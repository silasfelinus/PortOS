/**
 * Share Bucket — manifest & cursor helpers.
 *
 * A manifest is one JSON file in `<bucket>/manifests/` per share action. It
 * names the records + assets bundled in that share, plus identifying
 * metadata (sender, source display name, timestamp). The cursor tracks which
 * manifest filenames the local PortOS has already processed so the watcher
 * doesn't replay them on restart.
 *
 * Manifest filename convention:
 *   <iso-ts>-<sender-id>-<manifest-id>.json
 *
 * Using an ISO-prefixed timestamp gives chokidar's lexicographic event order a
 * stable replay order if multiple manifests land in the same poll cycle.
 */

import { randomUUID } from 'crypto';
import { join } from 'path';
import { readdir } from 'fs/promises';
import { PATHS, atomicWrite, readJSONFile, ensureDir } from '../../lib/fileUtils.js';
import { SHARING_SCHEMA_VERSION, getProducedByVersion } from './version.js';
import { isStr } from '../../lib/storyBible.js';

export const MANIFEST_KIND = Object.freeze(['series', 'universe', 'media']);

/** @deprecated Use SHARING_SCHEMA_VERSION from ./version.js. Kept exported for back-compat. */
export const MANIFEST_SCHEMA_VERSION = SHARING_SCHEMA_VERSION;

const cursorPath = (bucketId) => join(PATHS.data, 'sharing', 'cursors', `${bucketId}.json`);

/**
 * Cursor shape:
 *   {
 *     processedById: { '<filename>': '<lastSeenManifestId>' },
 *     processed: ['<filename>', ...],            // legacy: pre-content-aware cursor entries
 *     lastProcessedAt: ISO
 *   }
 *
 * The `processedById` map is the content-aware path used for subscription
 * manifests: a fresh `manifestId` inside the same filename means the file's
 * contents changed (the subscription re-exported) and we need to re-import.
 * Legacy `processed[]` entries from buckets created on v1.0..v1.2 still
 * suppress re-import — those were one-shot manifests with random filenames,
 * so they're never going to be re-processed by content anyway.
 */
export async function readCursor(bucketId) {
  await ensureDir(join(PATHS.data, 'sharing', 'cursors'));
  const raw = await readJSONFile(cursorPath(bucketId), { processedById: {}, processed: [] }, { logError: false });
  return {
    processedById: (raw.processedById && typeof raw.processedById === 'object') ? raw.processedById : {},
    processed: Array.isArray(raw.processed) ? raw.processed : [],
    lastProcessedAt: raw.lastProcessedAt || null,
  };
}

export async function writeCursor(bucketId, cursor) {
  await ensureDir(join(PATHS.data, 'sharing', 'cursors'));
  await atomicWrite(cursorPath(bucketId), cursor);
}

/**
 * Mark a manifest filename as processed at the given manifestId. Caps the
 * cursor at 5000 entries so a runaway peer can't grow the file unbounded.
 */
export async function markProcessed(bucketId, manifestFilename, manifestId = null) {
  const cursor = await readCursor(bucketId);
  cursor.processedById[manifestFilename] = manifestId || cursor.processedById[manifestFilename] || '';
  // Drop legacy entry if it was tracked there; the map is now authoritative.
  if (cursor.processed.includes(manifestFilename)) {
    cursor.processed = cursor.processed.filter((f) => f !== manifestFilename);
  }
  const keys = Object.keys(cursor.processedById);
  if (keys.length > 5000) {
    // Drop the lexicographically-smallest 1000 — for timestamp-prefixed
    // one-shot manifests this is the oldest entries. Subscription filenames
    // (sub-…) sort after timestamp-prefixed ones, so they survive a prune
    // even when the cursor is full of legacy one-shot history.
    const drop = new Set(keys.sort().slice(0, keys.length - 5000));
    for (const k of drop) delete cursor.processedById[k];
  }
  cursor.lastProcessedAt = new Date().toISOString();
  await writeCursor(bucketId, cursor);
  return cursor;
}

/**
 * Remove a filename from the cursor entirely (used on `unlink` so a future
 * re-share of the same record under the same filename re-imports cleanly).
 * No-op short-circuit when the filename isn't tracked — chokidar fires
 * `unlink` for arbitrary files in the watched dir, not just our manifests.
 */
export async function forgetProcessed(bucketId, manifestFilename) {
  const cursor = await readCursor(bucketId);
  const inMap = cursor.processedById && manifestFilename in cursor.processedById;
  const inLegacy = cursor.processed.includes(manifestFilename);
  if (!inMap && !inLegacy) return cursor;
  if (inMap) delete cursor.processedById[manifestFilename];
  if (inLegacy) cursor.processed = cursor.processed.filter((f) => f !== manifestFilename);
  await writeCursor(bucketId, cursor);
  return cursor;
}

/**
 * Returns true when we've already imported THIS specific version of the
 * manifest. For subscription manifests, content-aware: a new manifestId on
 * the same filename re-processes. For legacy entries (processed[] array),
 * any subsequent reference to that filename is suppressed.
 */
export function hasBeenProcessed(cursor, manifestFilename, manifestId = null) {
  if (cursor?.processedById && manifestFilename in cursor.processedById) {
    const stored = cursor.processedById[manifestFilename];
    if (!stored) return true; // unknown id → trust filename match (idempotent)
    return manifestId ? stored === manifestId : true;
  }
  return Array.isArray(cursor?.processed) && cursor.processed.includes(manifestFilename);
}

/**
 * Build a fresh manifest. Caller writes it after every record + asset is in
 * place. `producedByVersion` is the PortOS app version; resolve via
 * `getProducedByVersion()` (from ./version.js) and pass in — kept as a
 * parameter so this stays pure + synchronous.
 *
 * `schemaVersion` is the wire-protocol version (the only one importer compat
 * is gated on). `sharingSchemaVersion` is its more descriptive alias kept for
 * forward-compat readability — both carry the same value.
 *
 * `subscription`, when provided as `{ recordKind, recordId }`, marks this
 * manifest as a persistent subscription rather than a one-shot share. The
 * filename is then deterministic per (recordKind, recordId), so re-exports
 * overwrite in place and recipients see updates via chokidar `change`
 * events. Importer cursor keys on the manifest id (fresh per export) so
 * content-changes re-process correctly.
 */
export function buildManifest({
  kind, senderInstanceId, source, sourceBio, recordIds, assetRefs,
  bucketId, bucketName, note, producedByVersion, subscription, collection,
}) {
  if (!MANIFEST_KIND.includes(kind)) throw new Error(`buildManifest: invalid kind '${kind}'`);
  return {
    id: randomUUID(),
    schemaVersion: SHARING_SCHEMA_VERSION,
    sharingSchemaVersion: SHARING_SCHEMA_VERSION,
    producedByVersion: producedByVersion || 'unknown',
    createdAt: new Date().toISOString(),
    kind,                              // 'series' | 'universe' | 'media'
    subscription: subscription && subscription.recordKind && subscription.recordId
      ? { recordKind: subscription.recordKind, recordId: subscription.recordId }
      : null,
    senderInstanceId: senderInstanceId || 'unknown',
    source: source || 'unknown',        // human display name
    sourceBio: sourceBio || null,
    bucketId,
    bucketName: bucketName || bucketId,
    recordIds: Array.isArray(recordIds) ? recordIds : [],
    assetRefs: Array.isArray(assetRefs) ? assetRefs : [],
    // Optional payload for universe shares — the linked media collection so
    // recipients gain the same set of generated images and the link is
    // restored on their side.
    collection: collection && collection.universeId && Array.isArray(collection.items)
      ? {
        name: collection.name || `Universe: ${collection.universeId}`,
        universeId: collection.universeId,
        description: collection.description || '',
        items: collection.items.map((it) => ({ kind: it.kind, ref: it.ref, addedAt: it.addedAt || null })),
      }
      : null,
    note: isStr(note) ? note.slice(0, 1000) : null,
  };
}

/**
 * Filename a manifest lives under inside `<bucket>/manifests/`.
 *
 * For subscription manifests we use a deterministic name keyed on the
 * (recordKind, recordId, bucketId) tuple so re-exports overwrite the same
 * file — bucket recipients see updates via chokidar `change` events, not as
 * accumulating new files. For one-shot manifests we use the legacy
 * `<iso-ts>-<source>-<uuid>.json` naming so the watcher's add-order remains
 * lexicographically deterministic.
 */
/** Filename for a subscription manifest. Used by both the writer (exporter)
 *  and the reader (subscriptions service, watcher) so the formula stays in
 *  one place. */
export function subscriptionFilename({ recordKind, recordId }) {
  return `sub-${recordKind}-${recordId}.json`;
}

export function manifestFilename(manifest) {
  if (manifest.subscription?.recordKind && manifest.subscription?.recordId) {
    return subscriptionFilename(manifest.subscription);
  }
  const ts = manifest.createdAt.replace(/[:.]/g, '-');
  const senderSlug = (manifest.source || manifest.senderInstanceId || 'unknown')
    .toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    || 'unknown';
  return `${ts}-${senderSlug}-${manifest.id}.json`;
}

export async function writeManifest(bucketPath, manifest) {
  await ensureDir(join(bucketPath, 'manifests'));
  const filename = manifestFilename(manifest);
  await atomicWrite(join(bucketPath, 'manifests', filename), manifest);
  return filename;
}

export async function readManifest(bucketPath, filename) {
  return readJSONFile(join(bucketPath, 'manifests', filename), null, { logError: false });
}

/** List every manifest filename in a bucket, newest first by ISO-prefixed name. */
export async function listManifestFilenames(bucketPath) {
  const dir = join(bucketPath, 'manifests');
  const entries = await readdir(dir).catch(() => []);
  return entries.filter((f) => f.endsWith('.json')).sort().reverse();
}
