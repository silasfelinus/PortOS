// Wire proactive CoS speech to real subsystem events.
//
// `speakProactive` (proactiveSpeech.js) is the delivery primitive — it knows
// how to suppress for quiet hours / disabled voice and push a line over the
// `voice:speak` socket event. This module decides WHEN the CoS speaks first,
// by subscribing to three live event sources and turning select events into
// spoken lines:
//
//   1. errorEvents 'error'        — only `severity: 'critical'` (the rest are
//                                    routine 4xx/5xx the user shouldn't hear).
//   2. cosEvents   'task:ready'   — a new task became spawnable.
//   3. notificationEvents 'added' — only high/critical priority notifications.
//
// Each source has its OWN rate-limit bucket so a burst from one source can't
// starve another, and a storm within a source can't talk over the user. The
// rate-limit is applied BEFORE `speakProactive` (so we skip the config read +
// synthesis cost on a throttled event) and the bucket only advances on a line
// that actually went out — a quiet-hours/disabled suppression doesn't consume
// the budget.
//
// EventEmitter does NOT await async listeners: a rejection from the synthesis
// path inside `speakProactive` would surface as an unhandled rejection
// (process-killing on Node ≥15). Listeners here stay synchronous and route the
// awaited work through `dispatch`, which try/catches internally (sanctioned
// out-of-request-lifecycle boundary per CLAUDE.md) and never rejects; a `.catch`
// backstop on the call site guards the rest.

import { errorEvents } from '../../lib/errorHandler.js';
import { cosEvents } from '../cosEvents.js';
import { notificationEvents } from '../notifications.js';
import { speakProactive as defaultSpeak } from './proactiveSpeech.js';

// Per-source minimum interval between spoken lines (ms). Tuned for an opt-in
// assistant: critical errors are rare so a wide spacing is fine; tasks and
// notifications can cluster, so a one-minute floor keeps them from chattering.
export const RATE_LIMIT_MS = {
  error: 90_000,
  'task:ready': 60_000,
  notification: 60_000,
};

// Spoken lines should be short — synthesis is capped at MAX_PROACTIVE_TEXT_LEN
// upstream, but for the ear a sentence or two is plenty. Trim long source text.
const SPEECH_CLIP_LEN = 240;

const clip = (text) => {
  const s = (text || '').toString().trim().replace(/\s+/g, ' ');
  return s.length > SPEECH_CLIP_LEN ? `${s.slice(0, SPEECH_CLIP_LEN - 1)}…` : s;
};

// Pure rate-limit predicate — given a source, its last-spoken timestamp, and
// "now", may it speak? Unknown sources have no limit. Exported for unit tests.
export const allowBySource = (source, lastSpokenAt, now, limits = RATE_LIMIT_MS) => {
  const limit = limits[source];
  if (!limit) return true;
  if (lastSpokenAt == null) return true;
  return now - lastSpokenAt >= limit;
};

// High-severity notification gate — only `high` / `critical` get spoken.
export const isHighPriorityNotification = (priority) =>
  priority === 'high' || priority === 'critical';

// --- Pure formatters: event payload → spoken line (or '' to skip) ---

export const formatErrorLine = (error) => {
  if (error?.severity !== 'critical') return '';
  const msg = clip(error.message);
  return msg ? `Heads up. A critical error just occurred. ${msg}` : '';
};

export const formatTaskLine = (task) => {
  const label = clip(task?.title || task?.description);
  return label ? `A new task is ready: ${label}.` : '';
};

export const formatNotificationLine = (notification) => {
  if (!isHighPriorityNotification(notification?.priority)) return '';
  const title = clip(notification?.title);
  if (!title) return '';
  const description = clip(notification?.description);
  return description ? `${title}. ${description}` : title;
};

/**
 * Subscribe proactive speech to live event sources.
 *
 * @param {object}   opts
 * @param {object}   opts.io     Socket.IO server (passed to speakProactive).
 * @param {Function} [opts.speak] Override the delivery primitive (tests).
 * @param {object}   [opts.limits] Override per-source rate limits (tests).
 * @returns {Function} unwire — removes the listeners (boot wires once; tests
 *                     and hot-reload use this to avoid double-wiring).
 */
export const wireProactiveTriggers = ({ io, speak = defaultSpeak, limits = RATE_LIMIT_MS } = {}) => {
  if (!io) {
    console.warn('🔕 voice: proactive triggers not wired (no io)');
    return () => {};
  }

  // Per-source last-spoken timestamps live in this closure so each wiring gets
  // isolated state and a rewire starts fresh.
  const lastSpokenAt = new Map();

  // Single async boundary — never rejects, so the synchronous listeners that
  // call it can't leak an unhandled rejection. Advances the source's bucket
  // only when a line actually went out.
  const dispatch = async (source, text, priority) => {
    if (!text) return;
    const now = Date.now();
    if (!allowBySource(source, lastSpokenAt.get(source), now, limits)) return;
    const result = await speak({ io, text, priority, source }).catch((err) => {
      console.error(`🔕 voice: proactive ${source} synth failed: ${err?.message || err}`);
      return { ok: false, reason: 'error' };
    });
    if (result?.ok) lastSpokenAt.set(source, Date.now());
  };

  // Backstop: if dispatch itself somehow throws synchronously, swallow + log
  // rather than letting an unhandled rejection escape the listener.
  const fire = (source, text, priority) => {
    dispatch(source, text, priority).catch((err) =>
      console.error(`🔕 voice: proactive ${source} trigger failed: ${err?.message || err}`),
    );
  };

  const onError = (error) => fire('error', formatErrorLine(error), 'high');
  const onTaskReady = (task) => fire('task:ready', formatTaskLine(task), 'normal');
  const onNotification = (notification) => fire('notification', formatNotificationLine(notification), 'high');

  errorEvents.on('error', onError);
  cosEvents.on('task:ready', onTaskReady);
  notificationEvents.on('added', onNotification);

  console.log('🔔 voice: proactive triggers wired (error/task:ready/notification)');

  return () => {
    errorEvents.off('error', onError);
    cosEvents.off('task:ready', onTaskReady);
    notificationEvents.off('added', onNotification);
  };
};
