/**
 * Shared TUI invocation + paste-handshake constants.
 *
 * Two execution paths need these: `server/lib/tuiPromptRunner.js` (one-shot
 * prompts from the central handler) and `server/services/agentTuiSpawning.js`
 * (long-running CoS agents). Both shell into the same set of TUI binaries
 * (Claude Code, Codex, Antigravity) and use identical PTY-paste choreography to
 * deliver the prompt — banner repaint wait, bracketed-paste, Enter handshake.
 * Without this shared module they had verbatim copies that would silently
 * drift the first time anyone tweaked one side's paste timing.
 *
 * No cycle risk: this module imports nothing from either consumer.
 */

import { resolveCliModel, hasModelFlag } from './providerModels.js';
import { ensureAntigravityTuiArgs, isAntigravityCommand } from './antigravity.js';

// ─── Paste handshake constants ────────────────────────────────────────────

// PTY readiness — wait for the TUI banner to finish repainting (output-idle
// for READY_IDLE_THRESHOLD_MS) before pasting. A fixed delay loses to slow
// banners and burns time on fast ones; idle-detect adapts.
export const READY_POLL_INTERVAL_MS = 300;
export const READY_IDLE_THRESHOLD_MS = 1200;
export const PASTE_DEADLINE_MS = 10000;

// Claude Code emits `[Pasted text #N +M lines]` after committing a paste.
// Watch for the marker (or fall back after PASTE_TO_ENTER_FALLBACK_MS)
// before sending `\r` so Enter doesn't get swallowed mid-paste-commit.
export const PASTE_MARKER_POLL_MS = 150;
export const PASTE_MARKER_PATTERN = /\[Pasted text #\d+/;
export const PASTE_TO_ENTER_MIN_DELAY_MS = 200;
export const PASTE_TO_ENTER_FALLBACK_MS = 3500;

// A SINGLE Enter after a large bracketed paste is unreliable: the TUI can still
// be processing/reflowing the multi-line paste when the `\r` arrives and
// swallow it, leaving the whole prompt sitting unsent in the input box. The
// agent then idles out and is falsely finalized as success — observed as the
// "the prompt was typed but I had to hit Enter myself" bug. (Modern Claude Code
// also no longer reliably emits the `[Pasted text #N]` marker, so the fast path
// above rarely fires and we lean entirely on the fallback Enter.) Send a few
// Enters spaced apart so at least one lands after the paste settles. Re-sending
// is safe: once the prompt submits the input box is empty and a bare Enter is a
// no-op in every TUI we drive (claude/codex/gemini), so the extra Enters can't
// fire a spurious empty message.
export const SUBMIT_ENTER_ATTEMPTS = 3;
export const SUBMIT_ENTER_SPACING_MS = 700;

/**
 * Submit a freshly-pasted TUI prompt by sending Enter SUBMIT_ENTER_ATTEMPTS
 * times: once immediately, then on a SUBMIT_ENTER_SPACING_MS interval until the
 * attempt budget is spent (see the constants above for why a single Enter is
 * unreliable). Shared by both the agent path and the one-shot runner so the two
 * can't drift.
 *
 * @param {() => void} write — sends one `\r` to the TUI. The caller owns the
 *   write mechanism (PTY vs shell session) and its error handling.
 * @param {() => boolean} isFinalized — true once the run has ended; stops the
 *   retry loop so it can't write into a torn-down session.
 * @returns {ReturnType<typeof setInterval>|null} the retry interval id (null
 *   when no retries were scheduled). The caller stores it so its finalize path
 *   can cancel pending retries; calling clearInterval on an already-self-cleared
 *   id is a harmless no-op.
 */
export function scheduleSubmitEnters(write, isFinalized) {
  if (isFinalized()) return null;
  write();
  let attemptsLeft = SUBMIT_ENTER_ATTEMPTS - 1;
  if (attemptsLeft <= 0) return null;
  const timer = setInterval(() => {
    if (isFinalized() || attemptsLeft <= 0) {
      clearInterval(timer);
      return;
    }
    attemptsLeft -= 1;
    write();
  }, SUBMIT_ENTER_SPACING_MS);
  return timer;
}

// Defaults the consumer applies when the provider config doesn't pin
// per-provider values (provider.tuiPromptDelayMs / .tuiIdleTimeoutMs).
export const DEFAULT_TUI_PROMPT_DELAY_MS = 2500;
export const DEFAULT_TUI_IDLE_TIMEOUT_MS = 180000;

// ─── Buffer caps (defensive RAM bounds) ───────────────────────────────────
//
// RAW caps stay small — the raw PTY stream is only used for paste-marker
// detection and a short failure-tail in the exit error message, both of
// which need only the recent past.
//
// OUTPUT caps are larger because the ANSI-stripped buffer is the fallback
// response text when a TUI fails to write its response file. A 1MB cap was
// silently truncating the *head* of large model responses mid-token; bumped
// to 8MB so realistic full-context replies (~600KB UTF-8 from a 200K-token
// window, plus screen chrome) fit cleanly. Consumers should still treat
// overflow as a fault — see `outputBufferTruncated` tracking in
// `tuiPromptRunner.js`.
export const RAW_BUFFER_CAP = 512 * 1024;
export const RAW_BUFFER_HEADROOM = 640 * 1024;
export const OUTPUT_BUFFER_CAP = 8 * 1024 * 1024;
export const OUTPUT_BUFFER_HEADROOM = 10 * 1024 * 1024;
// Disk safety valve for the agent-mode raw.txt spool. Counted as UTF-8 bytes
// actually written. Tests can override this via the same vi.mock pattern that
// shrinks OUTPUT_BUFFER_HEADROOM, so the cap-overflow test doesn't have to
// push hundreds of MB through the spawner to exercise the truncation path.
export const RAW_SPOOL_MAX_BYTES = 256 * 1024 * 1024;

// ─── Command + args helpers ───────────────────────────────────────────────

export function inferTuiCommand(id) {
  if (!id) return 'claude';
  if (id.includes('codex')) return 'codex';
  if (id.includes('antigravity')) return 'agy';
  if (id.includes('gemini')) return 'gemini';
  return 'claude';
}

// Codex TUI blocks on every tool approval AND sandboxes file/network writes
// unless we run it fully bypassed. There's no human-at-keyboard for headless
// calls (one-shot OR agent), so inject the full-yolo flag — the same posture
// the CLI/exec path uses in `agentCliSpawning.js`. The bypass flag is mutually
// exclusive with `--ask-for-approval` / `--sandbox`, so don't add it when the
// provider config already pins an approval/sandbox/bypass policy of its own.
export function applyCommandDefaults(command, args) {
  if (command === 'codex' && !codexHasApprovalPolicy(args)) {
    return ['--dangerously-bypass-approvals-and-sandbox', ...args];
  }
  if (isAntigravityCommand(command)) {
    return ensureAntigravityTuiArgs(args);
  }
  return args;
}

// True when the codex argv already declares an approval/sandbox posture, so
// injecting `--dangerously-bypass-approvals-and-sandbox` would collide with it.
function codexHasApprovalPolicy(args) {
  return args.some(arg =>
    arg === '--ask-for-approval' || arg === '-a' || arg.startsWith('-a=') || arg.startsWith('--ask-for-approval=') ||
    arg === '--sandbox' || arg === '-s' || arg.startsWith('-s=') || arg.startsWith('--sandbox=') ||
    arg === '--dangerously-bypass-approvals-and-sandbox' || arg === '--yolo'
  );
}

/**
 * Build the spawn args for a TUI invocation. When `provider.args` already
 * has a `--model X` (or `-m X`) pin, the args-baked flag wins and we skip
 * the per-call --model append — otherwise the CLI would see two flags and
 * either error or take the last one (provider-specific). Matches the same
 * gate `runner.js#buildCliArgs` uses for CLI providers.
 */
export function buildTuiInvocation(provider, model) {
  const command = provider?.command || inferTuiCommand(provider?.id);
  const baseArgs = applyCommandDefaults(command, [...(provider?.args || [])]);
  const effectiveModel = resolveCliModel(model);
  const shouldInject = !isAntigravityCommand(command) && effectiveModel && !hasModelFlag(baseArgs);
  const args = shouldInject ? [...baseArgs, '--model', effectiveModel] : baseArgs;
  return { command, args };
}

/**
 * Returns true when the stripped chunk looks like a `command not found`
 * error for our spawned TUI binary. Used as an early-fail probe so a typo'd
 * provider.command surfaces in seconds instead of after the idle timeout.
 */
export function detectMissingTuiBinary(strippedText, commandName) {
  const lower = strippedText.toLowerCase();
  return lower.includes('command not found') && lower.includes(commandName.toLowerCase());
}
