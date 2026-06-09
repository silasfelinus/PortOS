/**
 * City Introspection
 *
 * Read-only diagnostics backing CyberCity's Data Harbor district: the PostgreSQL
 * datastore (one silo per table) and the `data/` filesystem (one archive rack per
 * domain directory). Purely derived state — nothing is stored, synced, or backed
 * up (see docs/STORAGE.md: transient query results need no classification).
 *
 * Caching: the data/ walk can take whole seconds on a media-heavy install
 * (data/images alone holds thousands of files), so results are cached with a TTL
 * and served stale-while-revalidate — once a payload exists, callers always get
 * an immediate answer while an expired cache refreshes in the background.
 * Concurrent first calls share one in-flight build.
 */

import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { query } from '../lib/db.js';

export const INTROSPECTION_TTL_MS = 45_000;

// Domain directories walked concurrently (each walk is itself sequential —
// bounded I/O pressure either way).
const WALK_CONCURRENCY = 4;

let cache = null;
let cacheBuiltAt = 0;
let inFlight = null;

// Test hook — clears the module-level cache between suites.
export function resetIntrospectionCache() {
  cache = null;
  cacheBuiltAt = 0;
  inFlight = null;
}

// Postgres returns bigint columns as strings; coerce defensively.
const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// The database section. A down/unreachable DB yields `null` (absent), never a
// hollow `{ tables: [] }` — the harbor renders "DB OFFLINE" instead of an empty
// quay (CLAUDE.md's absent-vs-empty rule).
async function buildDbSection() {
  const tables = await query(
    `SELECT relname AS name,
            n_live_tup AS row_estimate,
            pg_total_relation_size(relid) AS total_bytes
       FROM pg_stat_user_tables
      WHERE schemaname = 'public'
      ORDER BY pg_total_relation_size(relid) DESC, relname ASC`,
  ).then((r) => r.rows, () => null);
  if (!tables) return null;

  // Independent enrichments — each degrades to absent without sinking the section.
  const [vectorRows, sizeRow, migrationRow] = await Promise.all([
    query(
      `SELECT DISTINCT table_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND udt_name = 'vector'`,
    ).then((r) => r.rows, () => []),
    query('SELECT pg_database_size(current_database()) AS bytes')
      .then((r) => r.rows[0], () => null),
    query('SELECT count(*)::int AS applied, max(applied_at) AS last_applied FROM schema_migrations')
      .then((r) => r.rows[0], () => null),
  ]);

  const vectorTables = new Set(vectorRows.map((r) => r.table_name));

  return {
    sizeBytes: sizeRow ? toNumber(sizeRow.bytes) : null,
    tables: tables.map((t) => ({
      name: t.name,
      rowEstimate: toNumber(t.row_estimate),
      totalBytes: toNumber(t.total_bytes),
      hasEmbedding: vectorTables.has(t.name),
    })),
    migrations: migrationRow
      ? { applied: toNumber(migrationRow.applied), lastApplied: migrationRow.last_applied ?? null }
      : null,
  };
}

// Recursive size/count of a directory tree. Symlinks are skipped (a link into a
// media library shouldn't count as local data); unreadable entries are tolerated
// per-entry so one bad file can't sink a domain.
async function walkDir(path) {
  let bytes = 0;
  let files = 0;
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const childPath = join(path, entry.name);
    if (entry.isDirectory()) {
      const sub = await walkDir(childPath);
      bytes += sub.bytes;
      files += sub.files;
    } else if (entry.isFile()) {
      const s = await stat(childPath).catch(() => null);
      if (s) {
        bytes += s.size;
        files += 1;
      }
    }
  }
  return { bytes, files };
}

// The filesystem section: each depth-1 directory under data/ becomes a domain;
// loose top-level files roll into a "(root)" pseudo-domain. Domains sorted by
// size so the harbor's biggest racks come first.
async function buildFsSection() {
  const entries = await readdir(PATHS.data, { withFileTypes: true }).catch(() => null);
  if (!entries) return null;

  const dirs = [];
  let rootBytes = 0;
  let rootFiles = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      dirs.push(entry.name);
    } else if (entry.isFile()) {
      const s = await stat(join(PATHS.data, entry.name)).catch(() => null);
      if (s) {
        rootBytes += s.size;
        rootFiles += 1;
      }
    }
  }

  const domains = [];
  for (let i = 0; i < dirs.length; i += WALK_CONCURRENCY) {
    const batch = dirs.slice(i, i + WALK_CONCURRENCY);
    const results = await Promise.all(batch.map((name) => walkDir(join(PATHS.data, name))));
    batch.forEach((name, j) => domains.push({ name, ...results[j] }));
  }
  if (rootFiles > 0) domains.push({ name: '(root)', bytes: rootBytes, files: rootFiles });

  domains.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  return {
    domains,
    totalBytes: domains.reduce((sum, d) => sum + d.bytes, 0),
    totalFiles: domains.reduce((sum, d) => sum + d.files, 0),
  };
}

async function build() {
  const [db, fs] = await Promise.all([buildDbSection(), buildFsSection()]);
  return { ts: new Date().toISOString(), db, fs };
}

export async function getCityIntrospection() {
  const now = Date.now();
  if (cache && now - cacheBuiltAt < INTROSPECTION_TTL_MS) return cache;

  if (!inFlight) {
    inFlight = build().then(
      (result) => {
        cache = result;
        cacheBuiltAt = Date.now();
        inFlight = null;
        return result;
      },
      (err) => {
        // When stale cache is being served nobody awaits this promise, so a
        // rethrow would be an unhandled rejection — resolve to the stale
        // payload instead and only propagate when there's nothing to serve.
        inFlight = null;
        console.error(`❌ City introspection rebuild failed: ${err.message}`);
        if (cache) return cache;
        throw err;
      },
    );
  }

  // Stale-while-revalidate: an expired-but-present cache answers immediately
  // while the rebuild completes in the background.
  return cache ?? inFlight;
}
