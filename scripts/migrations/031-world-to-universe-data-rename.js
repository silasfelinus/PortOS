/**
 * Rename legacy "World" → "Universe" data shapes on disk.
 *
 * Background:
 *   PortOS originally shipped a "World Builder" feature whose data lived in
 *   `data/world-builder.json` with a top-level `worlds: []` key. The feature
 *   was renamed to "Universe Builder" — `data/universe-builder.json` with
 *   `universes: []`, plus `worldId` → `universeId` on series and `worldRun`
 *   → `universeRun` on media jobs.
 *
 *   The conversion shipped as a manual CLI script
 *   (`server/scripts/migrateWorldToUniverse.js`) that users had to invoke
 *   after upgrading. Anyone who upgraded without reading release notes was
 *   left with un-migrated data — their old worlds never appeared as
 *   universes in the new UI. This auto-running migration closes that gap.
 *
 * Steps (each idempotent — a re-run after partial completion is safe):
 *   1. Rename `data/world-builder.json` → `data/universe-builder.json`.
 *   2. In that file, rename top-level `worlds` key → `universes`.
 *   3. In `pipeline-series.json`, rename every `worldId` field → `universeId`.
 *   4. In `media-jobs.json`, rename every `worldRun` field → `universeRun`.
 *   5. In `media-collections.json`, rename legacy `"World: <name>"` render
 *      buckets to `"Universe: <name>"` AND stamp `universeId` when the name
 *      uniquely matches one of the migrated universes. Mirrors the logic in
 *      migration 021 (link orphan universe collections) but adapted for the
 *      old "World:" prefix — without this, the legacy buckets stay
 *      unlinked-and-mis-prefixed, and the next render mints a fresh
 *      "Universe: <name>" bucket, stranding the old renders.
 *
 * Edge cases:
 *   - If both `world-builder.json` and `universe-builder.json` exist
 *     (interrupted migration, hand-rename), the rename step skips with a
 *     warning. Downstream steps still run — they read the universe file.
 *   - Migration 001 already runs first by sort order; it collapses
 *     date-suffixed `"World: <name> — YYYY-MM-DD"` buckets into one bucket
 *     per base name, so by the time step 5 fires the names are clean.
 *   - Universes with no rendered collection just have step 5 no-op for them.
 */

import { readFile, writeFile, rename, stat } from 'fs/promises';
import { join } from 'path';

const COLLECTION_NAME_MAX = 80;
const LEGACY_PREFIX = 'World: ';
const NEW_PREFIX = 'Universe: ';

const fileExists = (path) => stat(path).then(() => true, (err) => {
  if (err.code === 'ENOENT') return false;
  throw err;
});

const readText = async (path) => {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  return raw;
};

const readJson = async (path) => {
  const raw = await readText(path);
  if (raw == null) return null;
  return JSON.parse(raw);
};

const writeJson = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + '\n');

// Mirrors `universeCollectionNameFor` in server/services/mediaCollections.js
// — duplicated inline so this one-shot migration's contract is frozen
// against future runtime changes to the naming convention.
const canonicalCollectionName = (universeName) =>
  `${NEW_PREFIX}${typeof universeName === 'string' ? universeName : ''}`.slice(0, COLLECTION_NAME_MAX);

// Legacy form — same shape but with the old prefix. Used to match collections
// minted before the rename so we can adopt them by name.
const legacyCollectionName = (universeName) =>
  `${LEGACY_PREFIX}${typeof universeName === 'string' ? universeName : ''}`.slice(0, COLLECTION_NAME_MAX);

const norm = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

async function renameWorldBuilderFile(dataDir) {
  const oldPath = join(dataDir, 'world-builder.json');
  const newPath = join(dataDir, 'universe-builder.json');
  const [hasOld, hasNew] = await Promise.all([fileExists(oldPath), fileExists(newPath)]);
  if (hasOld && hasNew) {
    console.warn(`⚠️  migration 031: both world-builder.json and universe-builder.json exist — leaving files alone (resolve manually)`);
    return false;
  }
  if (!hasOld) return false;
  await rename(oldPath, newPath);
  console.log(`🌍→🌐 migration 031: renamed world-builder.json → universe-builder.json`);
  return true;
}

async function renameTopLevelKey(dataDir) {
  const path = join(dataDir, 'universe-builder.json');
  const doc = await readJson(path);
  if (!doc || typeof doc !== 'object') return false;
  if (Array.isArray(doc.universes)) return false; // already migrated
  if (!Array.isArray(doc.worlds)) return false; // nothing to do
  const { worlds, ...rest } = doc;
  await writeJson(path, { universes: worlds, ...rest });
  console.log(`🌐 migration 031: renamed top-level "worlds" → "universes" (${worlds.length} entries)`);
  return true;
}

// Text-rewrite a single JSON key without re-stringifying the whole file —
// preserves the user's formatting and keeps the diff minimal. Only matches
// the `"<fromKey>":` token so substrings inside string values can't collide.
async function renameJsonField(path, fromKey, toKey, label) {
  const raw = await readText(path);
  if (raw == null) return 0;
  const pattern = new RegExp(`"${fromKey}"\\s*:`, 'g');
  const count = (raw.match(pattern) || []).length;
  if (count === 0) return 0;
  const next = raw.replace(pattern, `"${toKey}":`);
  await writeFile(path, next);
  console.log(`🔄 migration 031: renamed ${count} "${fromKey}" → "${toKey}" key(s) in ${label}`);
  return count;
}

// Step 5 — rename "World: <name>" → "Universe: <name>" collections AND
// stamp universeId where the name uniquely identifies one universe.
async function relinkLegacyWorldCollections(dataDir) {
  const collectionsPath = join(dataDir, 'media-collections.json');
  const universesPath = join(dataDir, 'universe-builder.json');

  const [collectionsDoc, universesDoc] = await Promise.all([
    readJson(collectionsPath),
    readJson(universesPath),
  ]);
  if (!collectionsDoc || !Array.isArray(collectionsDoc.collections)) return;
  if (!universesDoc || !Array.isArray(universesDoc.universes)) return;

  // Index universes by the legacy collection-name they would have produced,
  // so we match the prefix the old renderer wrote. Truncate the same way
  // the runtime does so long names still match through the same path.
  // Value is a list — multi-match means ambiguous, skip.
  const universesByLegacyName = new Map();
  for (const u of universesDoc.universes) {
    const key = norm(legacyCollectionName(u?.name));
    if (!key || key === norm(LEGACY_PREFIX)) continue; // skip empty/whitespace names
    const bucket = universesByLegacyName.get(key) || [];
    bucket.push(u);
    universesByLegacyName.set(key, bucket);
  }

  let renamed = 0;
  let ambiguous = 0;
  const now = new Date().toISOString();
  for (const c of collectionsDoc.collections) {
    if (!c || typeof c.name !== 'string') continue;
    if (c.universeId) continue; // already linked, don't touch
    if (!c.name.startsWith(LEGACY_PREFIX)) continue;
    const matches = universesByLegacyName.get(norm(c.name));
    if (!matches || matches.length === 0) continue;
    if (matches.length > 1) {
      ambiguous += 1;
      console.warn(`⚠️ migration 031: collection "${c.name}" matches ${matches.length} universes — skipping (ambiguous link).`);
      continue;
    }
    const universe = matches[0];
    c.name = canonicalCollectionName(universe.name);
    c.universeId = universe.id;
    c.updatedAt = now;
    renamed += 1;
  }

  if (renamed > 0) {
    await writeJson(collectionsPath, collectionsDoc);
    console.log(`🔗 migration 031: relinked ${renamed} legacy "World: <name>" collection(s) → "Universe: <name>" with universeId stamp`);
  }
  if (ambiguous > 0) {
    console.log(`ℹ️ migration 031: ${ambiguous} legacy collection(s) skipped due to multiple same-named universes.`);
  }
}

export default {
  async up({ rootDir }) {
    const dataDir = join(rootDir, 'data');
    await renameWorldBuilderFile(dataDir);
    await renameTopLevelKey(dataDir);
    await renameJsonField(join(dataDir, 'pipeline-series.json'), 'worldId', 'universeId', 'pipeline-series.json');
    await renameJsonField(join(dataDir, 'media-jobs.json'), 'worldRun', 'universeRun', 'media-jobs.json');
    await relinkLegacyWorldCollections(dataDir);
  },
};
