/**
 * One-time cleanup: prune the legacy file→Postgres migration artifacts that the
 * file→DB migrators intentionally park aside instead of deleting.
 *
 * Every file→DB migrator (migrateUniversesToDB, migrateIssuesToDB,
 * migrateSeriesToDB, migrateStoryBuilderToDB, migrateWritersRoomToDB,
 * migrateCreativeDirectorToDB) renames its source aside — `…​.imported` /
 * `index.json.imported` / `manifest.imported.json` — and the split migrations
 * (034–036) left `…​.bak-NNN` copies, "a recovery source for at least one
 * release." Nothing ever removed them, so on a long-lived install they linger in
 * `./data` indefinitely (multiple MB). This removes them once the DB is provably
 * authoritative. (They are deliberately NOT excluded from rsync backups: while a
 * prune is blocked they are the only recovery source, so a snapshot must keep
 * them — see the NOTE in server/services/backup.js. Once pruned from disk they
 * leave subsequent snapshots naturally.)
 *
 * WHY THIS RUNS AT BOOT (not in scripts/migrations/): the prune reads Postgres,
 * but the `scripts/migrations/` runner executes BEFORE the DB pool is up. So —
 * exactly like repairUniverseTags / reconcileCanonCatalog — the real work runs
 * here from server/index.js (after ensureSchema + every store's file→DB warm
 * import), and scripts/migrations/077-prune-imported-legacy-files.js is a
 * registration stub so the change still lands in the migration ledger.
 *
 * SAFETY — IDENTITY verification (not a row count). A domain's artifacts are
 * deleted only when EVERY record id those artifacts hold is confirmed present in
 * the database. The ids come straight off disk: the parked directory NAMES
 * (`universes.imported/<id>/`, `pipeline-issues.imported/<id>/`) or the parsed
 * JSON `.id` (the creative-director array, each writers-room manifest/folder/
 * exercise, the universe `config.runs[]`, each manifest's `drafts[]`). We then
 * verify those exact ids exist via `SELECT id ... WHERE id = ANY($1)`.
 *
 * Why identity, not `COUNT(*) >= marker.imported` (the prior approach, rejected
 * in review): a count can be satisfied by UNRELATED rows after a wipe+restore to
 * a different record set, and the migrators record `imported` from
 * `INSERT … ON CONFLICT DO NOTHING`, so a partial-retry marker can undercount
 * the parked source — either way a count `>=` check can pass while the specific
 * migrated rows are gone, deleting the only recovery copy. Checking the actual
 * ids can't be fooled by substitute rows or an undercounted marker. It also
 * handles the genuinely-empty install for free (no ids on disk → nothing to
 * verify → safe to prune the empty `.imported` dir) without depending on any
 * marker field. The `<domain>.migrated.json` marker is now used ONLY as a
 * "migration ran" signal (no marker → nothing was parked → skip).
 *
 * A wiped / partially-restored DB that is missing ANY parked id WITHHOLDS the
 * whole domain's prune and leaves the completion marker unwritten, so a future
 * boot retries once the DB is whole. This repair is also gated upstream by the
 * `dbReady` block in server/index.js, so it never runs under the
 * MEMORY_BACKEND=file escape hatch (no DB → no prune → recovery files kept).
 *
 * File-split backups (037 history.json, 059 media-collections.json) are NOT a
 * Postgres move — their successors live on disk — so they use a successor-exists
 * gate instead of id verification.
 *
 * Idempotent: `rm({ recursive: true, force: true })` no-ops on already-removed
 * paths, and a marker in `data/legacy-prune.applied.json` skips the walk once a
 * clean, complete pass has run.
 */

import { readFile, writeFile, rm, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';

const MARKER_VERSION = 1;
const MARKER_FILENAME = 'legacy-prune.applied.json';

// --- id extractors: pull the record ids a parked artifact holds, off disk. ---

// Immediate subdirectory names under `data/<dir>` (each a record id). Skips a
// type-level `index.json` and dotfiles. Used by the split-migration layouts
// where the record id IS the directory name.
async function idsFromSubdirs(base, dir) {
  const entries = await readdir(join(base, dir), { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && e.name !== 'index.json' && !e.name.startsWith('.'))
    .map((e) => e.name);
}

// `.id` of every element of a top-level JSON array file (the CD export, and the
// writers-room folders.imported.json / exercises.imported.json bare arrays).
async function idsFromJsonArray(base, file) {
  const arr = await readJson(base, file);
  return Array.isArray(arr) ? arr.map((r) => r?.id).filter((id) => typeof id === 'string') : [];
}

// Universe run ids: the type-level index.json's `config.runs[]`, each `{ id }`.
// (migrateUniversesToDB reads runs from `universes.imported/index.json`.)
async function universeRunIds(base) {
  const typeIndex = await readJson(base, 'universes.imported/index.json');
  const runs = Array.isArray(typeIndex?.config?.runs) ? typeIndex.config.runs : [];
  return runs.map((r) => r?.id).filter((id) => typeof id === 'string');
}

// Writers-room work ids + draft-version ids, read from each parked manifest.
async function writersRoomManifestIds(base) {
  const worksDir = 'writers-room/works';
  const subdirs = await readdir(join(base, worksDir), { withFileTypes: true }).catch(() => []);
  const workIds = [];
  const draftIds = [];
  for (const entry of subdirs) {
    if (!entry.isDirectory()) continue;
    const manifest = await readJson(base, join(worksDir, entry.name, 'manifest.imported.json'));
    if (typeof manifest?.id === 'string') workIds.push(manifest.id);
    if (Array.isArray(manifest?.drafts)) {
      for (const d of manifest.drafts) if (typeof d?.id === 'string') draftIds.push(d.id);
    }
  }
  return { workIds, draftIds };
}

// DB-gated domains. `markerFile` is the migrator's completion marker (used only
// as a "migration ran" signal — no marker means nothing was parked). `verify`
// returns `{ table, ids }[]`: the record ids each table must still contain for
// the artifacts to be safe to delete. `artifacts` are the parked sources to
// remove (file OR dir); `nestedGlobs` are per-record artifacts inside a still-
// live directory (one level deep).
const DB_DOMAINS = [
  {
    label: 'universes',
    markerFile: 'universes.migrated.json',
    // universes.imported holds both the universe records (subdir names) and the
    // config.runs[] log decomposed into universe_runs — verify both id sets.
    verify: async (base) => [
      { table: 'universes', ids: await idsFromSubdirs(base, 'universes.imported') },
      { table: 'universe_runs', ids: await universeRunIds(base) },
    ],
    artifacts: ['universes.imported', 'universe-builder.json.bak-034'],
  },
  {
    label: 'pipeline-issues',
    markerFile: 'pipeline-issues.migrated.json',
    verify: async (base) => [
      { table: 'pipeline_issues', ids: await idsFromSubdirs(base, 'pipeline-issues.imported') },
    ],
    artifacts: ['pipeline-issues.imported', 'pipeline-issues.json.bak-035'],
  },
  {
    label: 'pipeline-series',
    markerFile: 'pipeline-series.migrated.json',
    // migrateSeriesToDB renamed each record's index.json IN PLACE, leaving the
    // pipeline-series/<id>/ dir (+ manuscript-review.json sibling) intact — so
    // the series ids are the subdir names holding an index.json.imported.
    verify: async (base) => [
      { table: 'pipeline_series', ids: await idsFromSubdirsWithLeaf(base, 'pipeline-series', 'index.json.imported') },
    ],
    artifacts: ['pipeline-series.json.bak-036'],
    nestedGlobs: [{ baseDir: 'pipeline-series', leaf: 'index.json.imported' }],
  },
  {
    label: 'story-builder',
    markerFile: 'story-builder.migrated.json',
    verify: async (base) => [
      { table: 'story_builder_sessions', ids: await idsFromSubdirs(base, 'story-builder.imported') },
    ],
    artifacts: ['story-builder.imported'],
  },
  {
    label: 'writers-room',
    markerFile: 'writers-room.migrated.json',
    // This domain deletes the recovery copy of folders + works + exercises +
    // each work's drafts[], so verify every id set those artifacts hold.
    verify: async (base) => {
      const { workIds, draftIds } = await writersRoomManifestIds(base);
      return [
        { table: 'writers_room_folders', ids: await idsFromJsonArray(base, 'writers-room/folders.imported.json') },
        { table: 'writers_room_exercises', ids: await idsFromJsonArray(base, 'writers-room/exercises.imported.json') },
        { table: 'writers_room_works', ids: workIds },
        { table: 'writers_room_draft_versions', ids: draftIds },
      ];
    },
    artifacts: ['writers-room/folders.imported.json', 'writers-room/exercises.imported.json'],
    nestedGlobs: [{ baseDir: 'writers-room/works', leaf: 'manifest.imported.json' }],
  },
  {
    label: 'creative-director',
    markerFile: 'creative-director-projects.migrated.json',
    verify: async (base) => [
      { table: 'creative_director_projects', ids: await idsFromJsonArray(base, 'creative-director-projects.json.imported') },
    ],
    artifacts: ['creative-director-projects.json.imported'],
  },
];

// File-split backups: data reshaped file→file (NOT moved to Postgres), so they
// gate on the reshaped successor existing on disk. `backupPrefix` is a prefix:
// migration 037/059 normally write the bare `.bak-NNN`, but on a re-run
// collision they append `-<timestamp>`, so match the prefix to catch those too.
const FILE_SPLIT_BACKUPS = [
  { label: 'history', backupPrefix: 'history.json.bak-037', successor: 'history.jsonl' },
  { label: 'media-collections', backupPrefix: 'media-collections.json.bak-059', successor: 'media-collections' },
];

async function pathExists(p) {
  return stat(p).then(() => true, () => false);
}

async function readJson(base, file) {
  const raw = await readFile(join(base, file), 'utf-8').catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Subdir names under `data/<dir>` that contain a `<leaf>` file — the record ids
// for an in-place rename layout (pipeline-series keeps the live dir, so a bare
// subdir scan would also pick up unrelated siblings; gate on the leaf).
async function idsFromSubdirsWithLeaf(base, dir, leaf) {
  const entries = await readdir(join(base, dir), { withFileTypes: true }).catch(() => []);
  const ids = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (await pathExists(join(base, dir, entry.name, leaf))) ids.push(entry.name);
  }
  return ids;
}

// Of `ids`, return those NOT present in `table` (the rows a prune would orphan).
// Empty `ids` → no query, nothing missing (genuinely-empty install prunes free).
async function missingIds(query, table, ids) {
  if (ids.length === 0) return [];
  const { rows } = await query(`SELECT id FROM ${table} WHERE id = ANY($1)`, [ids]);
  const present = new Set(rows.map((r) => r.id));
  return ids.filter((id) => !present.has(id));
}

// Remove a path (file or dir) under `base`. force:true → no throw if absent.
// Returns true if the path existed before removal (so we can report a count).
async function removeUnder(base, rel) {
  const abs = join(base, rel);
  const existed = await pathExists(abs);
  if (existed) await rm(abs, { recursive: true, force: true });
  return existed;
}

// Remove `<baseDir>/<sub>/<leaf>` for every immediate subdir of baseDir.
async function removeNestedGlob(base, baseDir, leaf) {
  const entries = await readdir(join(base, baseDir), { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await removeUnder(base, join(baseDir, entry.name, leaf))) removed++;
  }
  return removed;
}

// Remove every top-level entry of `base` whose name starts with `prefix` (the
// bare `.bak-NNN` plus any `-<timestamp>` re-run collision variant).
async function removeByPrefix(base, prefix) {
  const entries = await readdir(base).catch(() => []);
  let removed = 0;
  for (const name of entries) {
    if (name.startsWith(prefix) && await removeUnder(base, name)) removed++;
  }
  return removed;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.force] - re-run even if the marker is current (tests/admin).
 * @param {object} [opts.db] - injectable db module ({ query }); defaults to server/lib/db.js.
 * @param {string} [opts.dataDir] - override data dir (tests). Defaults to PATHS.data.
 */
export async function pruneImportedLegacyFiles({ force = false, db, dataDir } = {}) {
  const base = dataDir ?? PATHS.data;

  const existing = await readJson(base, MARKER_FILENAME);
  if (existing?.version === MARKER_VERSION && !force) {
    return { skipped: true, marker: existing };
  }

  const { query } = db ?? await import('../lib/db.js');
  const totals = { removed: 0, blocked: 0, pruned: [] };

  for (const domain of DB_DOMAINS) {
    // No marker → migrator never completed for this install (or fresh install
    // with no legacy data). Nothing parked aside to prune; not a block.
    const marker = await readJson(base, domain.markerFile);
    if (!marker) continue;

    // Identity guard: every id the parked artifacts hold must still be present
    // in its table. A missing id means the DB lost a migrated record (wipe /
    // partial restore) — the parked files are the recovery source, so WITHHOLD
    // the whole domain and let a future boot retry once the DB is whole.
    const checks = await domain.verify(base);
    let blocked = false;
    for (const { table, ids } of checks) {
      const missing = await missingIds(query, table, ids);
      if (missing.length > 0) {
        console.warn(`🧹 legacy-prune: ${domain.label} blocked — ${missing.length}/${ids.length} ${table} id(s) missing from DB (e.g. ${missing[0]}); keeping recovery files`);
        blocked = true;
        break;
      }
    }
    if (blocked) {
      totals.blocked++;
      continue;
    }

    let domainRemoved = 0;
    for (const rel of domain.artifacts) {
      if (await removeUnder(base, rel)) domainRemoved++;
    }
    for (const glob of (domain.nestedGlobs ?? [])) {
      domainRemoved += await removeNestedGlob(base, glob.baseDir, glob.leaf);
    }
    if (domainRemoved > 0) {
      totals.removed += domainRemoved;
      totals.pruned.push(`${domain.label}(${domainRemoved})`);
    }
  }

  // File-split backups: prune only when the reshaped successor is present on
  // disk (proof the split landed). Absent successor → leave the backup alone.
  for (const item of FILE_SPLIT_BACKUPS) {
    if (!await pathExists(join(base, item.successor))) continue;
    const removed = await removeByPrefix(base, item.backupPrefix);
    if (removed > 0) {
      totals.removed += removed;
      totals.pruned.push(item.label);
    }
  }

  // Only stamp the completion marker on a clean pass with NO blocked domain —
  // a block means a future boot should retry (same logic as repairUniverseTags
  // withholding its marker on an incomplete pass).
  const markerWritten = totals.blocked === 0;
  if (markerWritten) {
    await writeFile(
      join(base, MARKER_FILENAME),
      JSON.stringify({ version: MARKER_VERSION, completedAt: new Date().toISOString(), removed: totals.removed }, null, 2) + '\n',
      'utf-8',
    );
  } else if (existing) {
    // A forced re-run that ended blocked must not leave a STALE clean marker on
    // disk — otherwise the next normal boot reads it, short-circuits via the
    // `skipped` branch above, and silently never retries the blocked domain.
    // Drop it so a normal boot re-evaluates. (Only reachable on the force path:
    // a non-forced run with a current marker returned `skipped` before any work.)
    await rm(join(base, MARKER_FILENAME), { force: true });
  }

  console.log(
    `🧹 legacy-prune: removed ${totals.removed} artifact(s)` +
    (totals.pruned.length ? ` [${totals.pruned.join(', ')}]` : '') +
    (totals.blocked ? `, ${totals.blocked} domain(s) blocked` : '') +
    (markerWritten ? '' : ' — marker NOT written (will retry next boot)'),
  );

  return { skipped: false, markerWritten, ...totals };
}
