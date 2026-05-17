// Resolves a series's effective canon (characters, settings, objects) by
// reading the linked universe. Series no longer carries canon arrays of its
// own (Phase B.4) — every active series is universe-linked, so this is just
// a thin async lookup that returns empty arrays when the series has no
// `universeId` set.

import { getUniverse } from '../universeBuilder.js';

const EMPTY = Object.freeze({ characters: [], settings: [], objects: [] });

const pickCanon = (universe) => ({
  characters: Array.isArray(universe?.characters) ? universe.characters : [],
  settings: Array.isArray(universe?.settings) ? universe.settings : [],
  objects: Array.isArray(universe?.objects) ? universe.objects : [],
});

/**
 * Async canon read for text/arc-planning stages that don't already have the
 * universe record in scope. Returns frozen-empty when the series is orphan
 * (no universeId) or the linked universe is missing.
 *
 * @returns {Promise<{ characters, settings, objects }>}
 */
export async function getSeriesCanon(series) {
  if (!series?.universeId) return EMPTY;
  const universe = await getUniverse(series.universeId).catch(() => null);
  if (!universe) return EMPTY;
  return pickCanon(universe);
}
