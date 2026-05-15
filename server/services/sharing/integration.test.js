/**
 * End-to-end sharing round-trip test.
 *
 * Exercises: register bucket → export series (records + assets + manifest) →
 * delete locally → processManifest (auto-merge) → verify the series reappears
 * with its original id, origin metadata, and asset blobs intact. Also verifies
 * the LWW re-merge path: re-export with newer updatedAt, re-process, confirm
 * local record updated and `overridden` populated.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Universe builder evaluates `join(PATHS.data, …)` at module-top, so PATHS
// must point at a real dir from the very first import. Allocate a single
// root up-front; per-test setup wipes + reseeds inside it.
const tempData = mkdtempSync(join(tmpdir(), 'portos-sharing-roundtrip-data-'));
let tempBucket;

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'PATHS') return {
        ...actual.PATHS,
        data: tempData,
        images: join(tempData, 'images'),
        videos: join(tempData, 'videos'),
      };
      return target[prop];
    },
  });
});

// Stub instances.getInstanceId so the exporter doesn't try to read the
// real identity.json. Returns a fixed id for assertions.
vi.mock('../instances.js', () => ({
  getInstanceId: () => Promise.resolve('test-instance-id'),
}));

// Stub mediaJobQueue.getJob — exporter uses it for full-fidelity gen
// metadata on each shared imageJobId. Returns null so the exporter falls
// through to direct asset copy via imageRefs.
vi.mock('../mediaJobQueue/index.js', () => ({
  getJob: () => null,
}));

const buckets = await import('./buckets.js');
const exporter = await import('./exporter.js');
const importer = await import('./importer.js');
const series = await import('../pipeline/series.js');
const issues = await import('../pipeline/issues.js');

describe('sharing round-trip', () => {
  beforeEach(() => {
    // Wipe and re-seed the temp data dir + a fake asset for each test.
    rmSync(tempData, { recursive: true, force: true });
    mkdirSync(tempData, { recursive: true });
    mkdirSync(join(tempData, 'images'), { recursive: true });
    mkdirSync(join(tempData, 'videos'), { recursive: true });
    writeFileSync(join(tempData, 'images', 'fakeasset.png'), 'PNGSTUB');
    tempBucket = mkdtempSync(join(tmpdir(), 'portos-sharing-roundtrip-bucket-'));
  });
  afterEach(() => {
    if (tempBucket) rmSync(tempBucket, { recursive: true, force: true });
  });

  it('exports a series, processes the manifest as inbox, then promotes — id + origin preserved', async () => {
    const bucket = await buckets.createBucket({ name: 'Test', path: tempBucket, mode: 'inbox' });

    // Author a series + an issue locally.
    const s = await series.createSeries({
      name: 'Salt Run', logline: 'A foundry city goes silent.', premise: 'The only survivor is a child.',
      // Add an imageRef on a character so the exporter has an asset to copy.
      characters: [{ name: 'Vex', imageRefs: ['fakeasset.png'] }],
    });
    const iss = await issues.createIssue({ seriesId: s.id, title: 'Issue 1' });

    // Export.
    const exp = await exporter.exportSeries(s.id, bucket.id);
    expect(exp.manifestId).toBeTruthy();
    expect(exp.recordCount).toBe(2); // series + issue
    expect(exp.assetCount).toBeGreaterThanOrEqual(1);

    // Verify the bucket layout.
    expect(existsSync(join(tempBucket, 'manifests', exp.filename))).toBe(true);
    expect(existsSync(join(tempBucket, 'records', 'series', `${s.id}.json`))).toBe(true);
    expect(existsSync(join(tempBucket, 'records', 'issues', `${iss.id}.json`))).toBe(true);
    expect(existsSync(join(tempBucket, 'assets', 'images', 'fakeasset.png'))).toBe(true);

    // Process as inbox (the bucket mode is 'inbox'). The manifest should
    // queue, not auto-apply.
    const result = await importer.processManifest(bucket.id, exp.filename);
    expect(result.processed).toBe(true);
    expect(result.outcome.mode).toBe('inbox');
    expect(result.outcome.queued).toBe(true);

    // Inbox should have one item.
    const inbox = await importer.listInbox(bucket.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].source).toBeTruthy();

    // Delete the local series + issue, then promote — the promote path runs
    // the auto-merge logic with insertWithId, so ids round-trip.
    await series.deleteSeries(s.id);
    await issues.deleteIssue(iss.id);
    await importer.promoteInboxItem(bucket.id, exp.manifestId);

    const restored = await series.getSeries(s.id);
    expect(restored.id).toBe(s.id);
    expect(restored.name).toBe('Salt Run');
    expect(restored.origin).toMatchObject({
      bucketId: bucket.id,
      manifestId: exp.manifestId,
    });
    expect(restored.origin.source).toBeTruthy();

    const restoredIssue = await issues.getIssue(iss.id);
    expect(restoredIssue.id).toBe(iss.id);
    expect(restoredIssue.seriesId).toBe(s.id);
    expect(restoredIssue.origin).toBeTruthy();

    // Asset blob should be back in data/images.
    expect(existsSync(join(tempData, 'images', 'fakeasset.png'))).toBe(true);

    // Inbox should be empty after promotion.
    expect(await importer.listInbox(bucket.id)).toEqual([]);
  });

  it('auto-merge mode applies records immediately and reports overridden on re-export', async () => {
    const bucket = await buckets.createBucket({ name: 'AutoBucket', path: tempBucket, mode: 'auto-merge' });

    const s = await series.createSeries({ name: 'Test Series', logline: 'A' });
    const exp = await exporter.exportSeries(s.id, bucket.id);

    // Drop the local series, then process — auto-merge inserts under preserved id.
    await series.deleteSeries(s.id);
    const r1 = await importer.processManifest(bucket.id, exp.filename);
    expect(r1.outcome.mode).toBe('auto-merge');
    expect(r1.outcome.applied).toBeGreaterThan(0);
    expect(r1.outcome.overridden).toEqual([]);
    const restored = await series.getSeries(s.id);
    expect(restored.id).toBe(s.id);

    // Modify the local series so the next export carries a NEWER updatedAt.
    await new Promise((r) => setTimeout(r, 5));
    await series.updateSeries(s.id, { name: 'Test Series (renamed)' });

    // Re-export — manifest carries the newer record.
    const exp2 = await exporter.exportSeries(s.id, bucket.id);

    // Roll the local copy backwards by a millisecond so the *remote* is newer.
    await new Promise((r) => setTimeout(r, 5));
    await series.updateSeries(s.id, { name: 'Test Series (renamed)' });
    // Force the local updatedAt to be older than the manifest so LWW triggers override.
    // (Easiest: mutate the on-disk JSON directly to set an old updatedAt.)
    const statePath = join(tempData, 'pipeline-series.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    state.series[0].updatedAt = '2020-01-01T00:00:00.000Z';
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    // Process the new manifest — should LWW-override.
    const r2 = await importer.processManifest(bucket.id, exp2.filename);
    expect(r2.outcome.mode).toBe('auto-merge');
    expect(r2.outcome.overridden).toHaveLength(1);
    expect(r2.outcome.overridden[0]).toMatchObject({ kind: 'series', id: s.id });

    const afterOverride = await series.getSeries(s.id);
    expect(afterOverride.name).toBe('Test Series (renamed)');
  });

  it('re-importing the same manifest is a no-op (cursor dedup)', async () => {
    const bucket = await buckets.createBucket({ name: 'D', path: tempBucket, mode: 'auto-merge' });
    const s = await series.createSeries({ name: 'X' });
    const exp = await exporter.exportSeries(s.id, bucket.id);
    await series.deleteSeries(s.id);

    const r1 = await importer.processManifest(bucket.id, exp.filename);
    expect(r1.processed).toBe(true);

    const r2 = await importer.processManifest(bucket.id, exp.filename);
    expect(r2.skipped).toBe(true);
    expect(r2.reason).toBe('already-processed');
  });
});
