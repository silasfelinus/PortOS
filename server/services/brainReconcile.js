/**
 * Brain Anti-Entropy Reconcile
 *
 * Brain peer-sync is delta-log-based (see brainSyncLog.js): a peer pulls change
 * entries since its cursor. That alone is NOT eventually-consistent — once a
 * record's create/update entry is compacted out of the log, a peer that never
 * pulled it (was offline, had a stale cursor, or had sync disabled during the
 * window) can never learn that record's state again. The two installs then
 * diverge silently and forever (issue #1077).
 *
 * This module adds the missing anti-entropy layer, mirroring the snapshot
 * reconcile that the `dataSync` snapshot categories already have:
 *
 *   - `getBrainChecksum()` — a deterministic hash over EVERY record across all
 *     brain stores, INCLUDING tombstones (their LWW `updatedAt` clock is part
 *     of the converged state). Two installs with identical brain state produce
 *     identical checksums regardless of key/insertion order.
 *   - `getBrainSnapshot()` — the raw `{ type: { id: record } }` map (live records
 *     + tombstones) plus that checksum, for a peer to LWW-merge.
 *   - `applyBrainSnapshot(snapshot)` — LWW-merges each record through
 *     `brainStorage.applyRemoteRecord`, so the apply is idempotent and obeys the
 *     same tombstone/echo guards as delta sync. Returns per-op counts.
 *
 * Brain has NO per-record push pipeline (unlike universe/pipeline/media), so
 * there is nothing to scope out per peer — the snapshot is always the full set,
 * applied idempotently. That keeps this layer simple and forward/backward
 * compatible: an older peer that never calls these endpoints just keeps using
 * delta sync; a newer peer reconciles on top.
 */

import { createHash } from 'crypto';
import * as brainStorage from './brainStorage.js';
import * as brainSyncLog from './brainSyncLog.js';

const { BRAIN_ENTITY_TYPES } = brainStorage;

/**
 * Build the canonical `{ type: { id: record } }` map across all brain stores,
 * including tombstones. Types and ids are emitted in sorted order so the
 * serialization (and thus the checksum) is independent of object key order.
 */
async function buildRawMap() {
  const map = {};
  for (const type of [...BRAIN_ENTITY_TYPES].sort()) {
    const records = await brainStorage.getRawRecords(type);
    const sorted = {};
    for (const id of Object.keys(records).sort()) {
      sorted[id] = records[id];
    }
    map[type] = sorted;
  }
  return map;
}

/**
 * Deterministic md5 over the canonical brain record map. Matches `dataSync`'s
 * `computeChecksum` (md5 of a JSON string) so the two reconcile layers behave
 * the same. Stable across installs because `buildRawMap` sorts types + ids.
 */
function computeChecksum(rawMap) {
  return createHash('md5').update(JSON.stringify(rawMap)).digest('hex');
}

/**
 * Current brain reconcile checksum. Lightweight relative to the snapshot — a
 * peer fetches this first and only pulls the full snapshot on a mismatch.
 */
export async function getBrainChecksum() {
  return computeChecksum(await buildRawMap());
}

/**
 * Full brain snapshot: the canonical raw map + its checksum. The receiver
 * LWW-merges it; the checksum lets it cache + skip an unchanged peer next cycle.
 */
export async function getBrainSnapshot() {
  const records = await buildRawMap();
  return { records, checksum: computeChecksum(records) };
}

/**
 * LWW-merge a peer's brain snapshot into local state.
 *
 * Each record is applied through `brainStorage.applyRemoteRecord`, which is
 * idempotent and enforces the tombstone/LWW guards (a stale create can't
 * resurrect a newer delete; an equal/older `updatedAt` is skipped). A tombstone
 * record (`_deleted === true`) is applied as a delete so the deletion
 * propagates; everything else is an upsert. Unknown types are ignored
 * (forward-compat with a peer that adds a new store).
 *
 * Applied changes are relayed to OUR sync log so they propagate onward to other
 * peers and our delta cursor stays meaningful — mirroring `brainSync`'s relay,
 * and gated the same way (only APPLIED ops relay, so an echo can't amplify).
 *
 * @returns {Promise<{inserted:number, updated:number, deleted:number, skipped:number}>}
 */
export async function applyBrainSnapshot(snapshot) {
  let inserted = 0, updated = 0, deleted = 0, skipped = 0;
  const relayBatch = [];

  const records = snapshot?.records;
  if (!records || typeof records !== 'object') {
    return { inserted, updated, deleted, skipped };
  }

  for (const type of Object.keys(records)) {
    if (!BRAIN_ENTITY_TYPES.includes(type)) continue;
    const byId = records[type];
    if (!byId || typeof byId !== 'object') continue;

    for (const [id, record] of Object.entries(byId)) {
      if (!record || !record.updatedAt) { skipped++; continue; }
      const op = record._deleted === true ? 'delete' : 'update';
      // For a delete, hand applyRemoteRecord the wire-shape tombstone fields
      // (it rebuilds the marker); for an upsert, pass the record through.
      const applyRecord = op === 'delete'
        ? { updatedAt: record.updatedAt, originInstanceId: record.originInstanceId }
        : record;
      const result = await brainStorage.applyRemoteRecord(type, id, applyRecord, op);
      if (!result.applied) { skipped++; continue; }
      if (op === 'delete') deleted++;
      else updated++;
      relayBatch.push({ op, type, id, record: applyRecord, originInstanceId: record.originInstanceId });
    }
  }

  if (relayBatch.length > 0) {
    await brainSyncLog.appendChanges(relayBatch)
      .catch(err => console.error(`⚠️ Brain reconcile relay append failed (${relayBatch.length} entries): ${err.message}`));
  }

  console.log(`🔄 Brain reconcile applied: ${updated} upserted, ${deleted} deleted, ${skipped} skipped`);
  return { inserted, updated, deleted, skipped };
}
