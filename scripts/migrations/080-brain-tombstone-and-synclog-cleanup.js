/**
 * Migration 080 — brain tombstone backfill + sync-log cleanup.
 *
 * Fixes the federated brain-sync resurrection/amplification loop. Brain entity
 * deletes used to be HARD deletes with no tombstone, so a stale `create`
 * echoed from a peer found `existing === undefined`, skipped the last-writer-
 * wins guard, and RESURRECTED the record; the newer `delete` re-killed it; both
 * ops relayed to every peer forever. Installs that ran the looping code carry:
 *   - "ghost" records: live entries that actually have a NEWER matching delete
 *     in the sync log (the resurrected half of a ping-pong pair).
 *   - a bloated `sync_log.jsonl`: tens of thousands of churn entries, with the
 *     monotonic seq counter far above the surviving line count.
 *
 * This migration (idempotent, safe across independently-upgrading peers):
 *   1. Builds, from the sync log, the newest `delete` updatedAt per (type, id).
 *   2. For each entity store, converts any live record that has a newer matching
 *      delete into a tombstone (neutralizes ghosts in place). The new tombstone
 *      code then rejects future stale creates.
 *   3. COMPACTS the sync log to the last entry per (type, id) — WITHOUT
 *      renumbering. Max seq is preserved so peer `brainSeq` cursors stay valid
 *      (resetting to 0 would strand every peer cursor and break convergence).
 *
 * Runs in the boot-time migration runner, which fires BEFORE initSyncLog() — so
 * rewriting sync_log.jsonl here is safe (currentSeq hasn't been read yet).
 *
 * Wire format is unchanged (deletes still ship `{ updatedAt }`), so no
 * schemaVersion bump and older peers are unaffected.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// Deliberately a standalone copy of brainStorage.BRAIN_ENTITY_TYPES: migrations
// run in the boot-time runner BEFORE the service layer is wired up, so this file
// must not import from server/services. Keep in sync with that canonical list.
const ENTITY_TYPES = ['people', 'projects', 'ideas', 'admin', 'memories', 'links', 'buckets'];

function parseLog(content) {
  const entries = [];
  for (const line of content.trim().split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Skip a corrupt/half-written line rather than aborting the whole migration.
    }
  }
  return entries;
}

/**
 * Core transform, exported for unit tests. Pure over its inputs:
 *   - logEntries: array of parsed sync-log entries (in seq order).
 *   - stores: { [type]: { records: { [id]: record } } } loaded entity stores.
 * Returns { stores, compactedLines, ghostsTombstoned } with mutated stores and
 * the compacted JSONL line array (seq numbers preserved).
 */
export function computeBrainCleanup(logEntries, stores, { nowIso }) {
  // Newest delete updatedAt per (type/id), for ghost detection.
  const newestDelete = new Map();
  for (const e of logEntries) {
    if (e?.op !== 'delete' || !e.type || !e.id || !e.record?.updatedAt) continue;
    const key = `${e.type}/${e.id}`;
    const prev = newestDelete.get(key);
    if (!prev || e.record.updatedAt > prev.updatedAt) {
      newestDelete.set(key, { updatedAt: e.record.updatedAt, originInstanceId: e.originInstanceId });
    }
  }

  // 1. Tombstone any live record that has a newer matching delete (the ghost).
  let ghostsTombstoned = 0;
  for (const type of ENTITY_TYPES) {
    const store = stores[type];
    if (!store?.records) continue;
    for (const [id, record] of Object.entries(store.records)) {
      if (record?._deleted) continue; // already a tombstone
      const del = newestDelete.get(`${type}/${id}`);
      if (del && record?.updatedAt != null && del.updatedAt > record.updatedAt) {
        store.records[id] = {
          _deleted: true,
          updatedAt: del.updatedAt,
          originInstanceId: record.originInstanceId ?? del.originInstanceId ?? 'unknown',
          deletedAt: nowIso,
        };
        ghostsTombstoned++;
      }
    }
  }

  // 2. Compact the log to the terminal entry per (type, id), preserving seq.
  //    Keep insertion order by seq so the file stays monotonic for peers.
  const terminal = new Map(); // key -> entry (last wins)
  let maxSeqEntry = null; // the single highest-seq entry, type/id or not
  for (const e of logEntries) {
    if (e?.seq == null) continue;
    if (!maxSeqEntry || e.seq > maxSeqEntry.seq) maxSeqEntry = e;
    if (!e.type || !e.id) continue;
    terminal.set(`${e.type}/${e.id}`, e);
  }
  const kept = [...terminal.values()];
  // Guarantee the max seq survives even if the highest-seq entry lacks type/id
  // (every real appendChange sets both today, but the peer-cursor-validity
  // invariant must not depend on that). Append it only if not already kept.
  if (maxSeqEntry && !kept.some((e) => e.seq === maxSeqEntry.seq)) {
    kept.push(maxSeqEntry);
  }
  const compactedLines = kept
    .sort((a, b) => a.seq - b.seq)
    .map((e) => JSON.stringify(e));

  return { stores, compactedLines, ghostsTombstoned };
}

export async function up({ rootDir }) {
  const brainDir = join(rootDir, 'data', 'brain');
  const logPath = join(brainDir, 'sync_log.jsonl');

  if (!existsSync(logPath)) {
    console.log('🧹 brain-cleanup: no sync log present, nothing to do');
    return;
  }

  const logContent = await readFile(logPath, 'utf-8');
  const logEntries = parseLog(logContent);

  // Load the entity stores that exist on disk.
  const stores = {};
  for (const type of ENTITY_TYPES) {
    const file = join(brainDir, `${type}.json`);
    if (!existsSync(file)) continue;
    const raw = await readFile(file, 'utf-8').catch(() => null);
    if (raw == null) continue;
    try {
      const parsed = JSON.parse(raw);
      // Preserve any other top-level keys the store may carry — only normalize
      // the `records` map. (Brain stores hold only `records` today, but dropping
      // unknown keys would be a latent data-loss path if the shape ever grows.)
      stores[type] = parsed && typeof parsed === 'object'
        ? { ...parsed, records: parsed.records ?? {} }
        : { records: {} };
    } catch {
      // Skip an unparseable store rather than abort — the migration is idempotent.
    }
  }

  const nowIso = new Date().toISOString();
  const { compactedLines, ghostsTombstoned } = computeBrainCleanup(logEntries, stores, { nowIso });

  // Persist tombstoned stores (only those we loaded; only when changed is fine
  // to skip — rewriting an unchanged store is harmless and keeps the code simple).
  for (const type of ENTITY_TYPES) {
    if (!stores[type]) continue;
    await writeFile(join(brainDir, `${type}.json`), JSON.stringify(stores[type], null, 2));
  }

  // Rewrite the compacted log. Preserve trailing newline convention.
  const newContent = compactedLines.length > 0 ? compactedLines.join('\n') + '\n' : '';
  await writeFile(logPath, newContent);

  console.log(
    `🧹 brain-cleanup: tombstoned ${ghostsTombstoned} ghost record(s), compacted sync log ${logEntries.length} → ${compactedLines.length} entries`
  );
}

export default { up };
