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
