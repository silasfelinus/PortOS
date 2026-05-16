/**
 * Pipeline media-job owner strings.
 *
 * Single source of truth for the `pipeline:<issueId>:<stage>:<target>`
 * shape that's stamped onto every mediaJobQueue job enqueued from a
 * pipeline stage. Producers (visualStages.js) and consumers
 * (comicPagesFilenameHook.js) share these helpers so a typo on either
 * end is a compile/lint failure instead of a silently-unmatched event.
 */

const PREFIX = 'pipeline';

export function buildComicPagesOwner({ issueId, target, pageIndex }) {
  if (target === 'cover') return `${PREFIX}:${issueId}:comicPages:cover`;
  if (target === 'page') return `${PREFIX}:${issueId}:comicPages:page${pageIndex}`;
  throw new Error(`buildComicPagesOwner: unknown target "${target}"`);
}

const COMIC_PAGES_RE = /^pipeline:([^:]+):comicPages:(cover|page(\d+))$/;

export function parseComicPagesOwner(owner) {
  if (typeof owner !== 'string') return null;
  const m = owner.match(COMIC_PAGES_RE);
  if (!m) return null;
  const [, issueId, kind, pageIdxStr] = m;
  if (kind === 'cover') return { issueId, target: 'cover' };
  const pageIndex = Number(pageIdxStr);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) return null;
  return { issueId, target: 'page', pageIndex };
}

// Per-shot start-frame renders inside the storyboards stage. Scene-level
// owners (`pipeline:<id>:storyboards:scene<N>`) still exist for legacy
// scene-image renders that don't decompose into shots — that string is
// produced inline by `enqueueVisualImage` and intentionally falls outside
// this parser (no filename hook needed for the scene-level path).
export function buildStoryboardsShotOwner({ issueId, sceneIndex, shotIndex }) {
  return `${PREFIX}:${issueId}:storyboards:scene${sceneIndex}:shot${shotIndex}`;
}

const STORYBOARDS_SHOT_RE = /^pipeline:([^:]+):storyboards:scene(\d+):shot(\d+)$/;

export function parseStoryboardsShotOwner(owner) {
  if (typeof owner !== 'string') return null;
  const m = owner.match(STORYBOARDS_SHOT_RE);
  if (!m) return null;
  const [, issueId, sceneIdxStr, shotIdxStr] = m;
  const sceneIndex = Number(sceneIdxStr);
  const shotIndex = Number(shotIdxStr);
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0) return null;
  if (!Number.isInteger(shotIndex) || shotIndex < 0) return null;
  return { issueId, sceneIndex, shotIndex };
}
