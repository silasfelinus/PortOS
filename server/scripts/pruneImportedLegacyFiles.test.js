/**
 * Isolated unit test for the legacy-artifact prune. No live DB needed — the
 * module accepts an injectable `db` (a `{ query }` stub returning row counts)
 * and a `dataDir` override pointing at a temp tree. Proves the contract:
 *   1. prunes a domain's parked artifacts when the live row count >= the marker,
 *   2. WITHHOLDS (keeps the recovery files) when the count is short of the
 *      marker — the wiped/restored-DB signature,
 *   3. prunes the genuinely-empty case (imported:0 / 0 rows),
 *   4. removes the per-record nested artifacts but leaves live siblings + bodies,
 *   5. file-split backups gate on the successor existing,
 *   6. marker-gated: a clean pass stamps the marker and the next run no-ops; a
 *      blocked pass withholds the marker so a future boot retries.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, stat, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pruneImportedLegacyFiles } from './pruneImportedLegacyFiles.js';

let dataDir;

const exists = (p) => stat(p).then(() => true, () => false);
const writeJSON = (p, obj) => writeFile(p, JSON.stringify(obj), 'utf-8');

// A db stub whose COUNT(*) result is driven by a per-table map.
function stubDb(counts) {
  return {
    async query(text) {
      const m = text.match(/FROM (\w+)/);
      const table = m?.[1];
      return { rows: [{ n: counts[table] ?? 0 }] };
    },
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'legacy-prune-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('pruneImportedLegacyFiles', () => {
  it('prunes a domain whose row count matches the marker', async () => {
    await writeJSON(join(dataDir, 'universes.migrated.json'), { imported: 13 });
    await mkdir(join(dataDir, 'universes.imported'), { recursive: true });
    await writeFile(join(dataDir, 'universe-builder.json.bak-034'), 'legacy', 'utf-8');

    const res = await pruneImportedLegacyFiles({ dataDir, db: stubDb({ universes: 13 }) });

    expect(res.skipped).toBe(false);
    expect(await exists(join(dataDir, 'universes.imported'))).toBe(false);
    expect(await exists(join(dataDir, 'universe-builder.json.bak-034'))).toBe(false);
    expect(res.markerWritten).toBe(true);
    expect(await exists(join(dataDir, 'legacy-prune.applied.json'))).toBe(true);
  });

  it('WITHHOLDS prune + marker when the row count is short of the marker (wiped/restored DB)', async () => {
    await writeJSON(join(dataDir, 'universes.migrated.json'), { imported: 13 });
    await mkdir(join(dataDir, 'universes.imported'), { recursive: true });

    const res = await pruneImportedLegacyFiles({ dataDir, db: stubDb({ universes: 0 }) });

    expect(res.blocked).toBe(1);
    expect(res.markerWritten).toBe(false);
    // Recovery files survive, and no completion marker is written so a future
    // boot (once the DB is whole) retries.
    expect(await exists(join(dataDir, 'universes.imported'))).toBe(true);
    expect(await exists(join(dataDir, 'legacy-prune.applied.json'))).toBe(false);
  });

  it('prunes the genuinely-empty case (imported:0, 0 rows)', async () => {
    await writeJSON(join(dataDir, 'story-builder.migrated.json'), { imported: 0 });
    await mkdir(join(dataDir, 'story-builder.imported'), { recursive: true });

    const res = await pruneImportedLegacyFiles({ dataDir, db: stubDb({ story_builder_sessions: 0 }) });

    expect(res.markerWritten).toBe(true);
    expect(await exists(join(dataDir, 'story-builder.imported'))).toBe(false);
  });

  it('skips a domain with no migration marker (never parked anything)', async () => {
    // creative-director never migrated on this install — no marker, no files.
    const res = await pruneImportedLegacyFiles({ dataDir, db: stubDb({}) });
    expect(res.blocked).toBe(0);
    expect(res.removed).toBe(0);
    expect(res.markerWritten).toBe(true);
  });

  it('removes per-record nested artifacts but keeps live siblings', async () => {
    await writeJSON(join(dataDir, 'pipeline-series.migrated.json'), { imported: 2 });
    const seriesA = join(dataDir, 'pipeline-series', 'aaa');
    const seriesB = join(dataDir, 'pipeline-series', 'bbb');
    await mkdir(seriesA, { recursive: true });
    await mkdir(seriesB, { recursive: true });
    await writeFile(join(seriesA, 'index.json.imported'), '{}', 'utf-8');
    await writeFile(join(seriesA, 'index.json'), '{}', 'utf-8');           // live record
    await writeFile(join(seriesA, 'manuscript-review.json'), '{}', 'utf-8'); // live sibling
    await writeFile(join(seriesB, 'index.json.imported'), '{}', 'utf-8');

    const res = await pruneImportedLegacyFiles({ dataDir, db: stubDb({ pipeline_series: 2 }) });

    expect(res.markerWritten).toBe(true);
    expect(await exists(join(seriesA, 'index.json.imported'))).toBe(false);
    expect(await exists(join(seriesB, 'index.json.imported'))).toBe(false);
    // Live record + sibling untouched.
    expect(await exists(join(seriesA, 'index.json'))).toBe(true);
    expect(await exists(join(seriesA, 'manuscript-review.json'))).toBe(true);
  });

  it('removes writers-room metadata artifacts but keeps .md draft bodies', async () => {
    await writeJSON(join(dataDir, 'writers-room.migrated.json'), { works: 1 });
    const wr = join(dataDir, 'writers-room');
    const work = join(wr, 'works', 'work-1');
    const drafts = join(work, 'drafts');
    await mkdir(drafts, { recursive: true });
    await writeFile(join(wr, 'folders.imported.json'), '[]', 'utf-8');
    await writeFile(join(wr, 'exercises.imported.json'), '[]', 'utf-8');
    await writeFile(join(work, 'manifest.imported.json'), '{}', 'utf-8');
    await writeFile(join(drafts, 'draft-1.md'), '# body', 'utf-8'); // file-primary body

    const res = await pruneImportedLegacyFiles({ dataDir, db: stubDb({ writers_room_works: 1 }) });

    expect(res.markerWritten).toBe(true);
    expect(await exists(join(wr, 'folders.imported.json'))).toBe(false);
    expect(await exists(join(wr, 'exercises.imported.json'))).toBe(false);
    expect(await exists(join(work, 'manifest.imported.json'))).toBe(false);
    // The prose body MUST survive (it's file-primary, not migrated to DB).
    expect(await exists(join(drafts, 'draft-1.md'))).toBe(true);
  });

  it('prunes a file-split backup only when its successor exists', async () => {
    // history: successor present → backup removed.
    await writeFile(join(dataDir, 'history.json.bak-037'), 'x', 'utf-8');
    await writeFile(join(dataDir, 'history.jsonl'), '', 'utf-8');
    // media-collections: successor ABSENT → backup kept.
    await writeFile(join(dataDir, 'media-collections.json.bak-059'), 'x', 'utf-8');

    const res = await pruneImportedLegacyFiles({ dataDir, db: stubDb({}) });

    expect(await exists(join(dataDir, 'history.json.bak-037'))).toBe(false);
    expect(await exists(join(dataDir, 'media-collections.json.bak-059'))).toBe(true);
    expect(res.markerWritten).toBe(true);
  });

  it('is marker-gated: a current marker no-ops without touching the DB', async () => {
    await writeJSON(join(dataDir, 'legacy-prune.applied.json'), { version: 1, completedAt: 'x', removed: 0 });
    let queried = false;
    const db = { async query() { queried = true; return { rows: [{ n: 0 }] }; } };

    const res = await pruneImportedLegacyFiles({ dataDir, db });

    expect(res.skipped).toBe(true);
    expect(queried).toBe(false);
  });

  it('force re-runs even with a current marker', async () => {
    await writeJSON(join(dataDir, 'legacy-prune.applied.json'), { version: 1, completedAt: 'x', removed: 0 });
    await writeJSON(join(dataDir, 'creative-director-projects.migrated.json'), { imported: 1 });
    await writeFile(join(dataDir, 'creative-director-projects.json.imported'), '[]', 'utf-8');

    const res = await pruneImportedLegacyFiles({ dataDir, force: true, db: stubDb({ creative_director_projects: 1 }) });

    expect(res.skipped).toBe(false);
    expect(await exists(join(dataDir, 'creative-director-projects.json.imported'))).toBe(false);
  });

  it('is idempotent across runs (second run finds nothing to remove)', async () => {
    await writeJSON(join(dataDir, 'universes.migrated.json'), { imported: 5 });
    await mkdir(join(dataDir, 'universes.imported'), { recursive: true });
    const db = stubDb({ universes: 5 });

    const first = await pruneImportedLegacyFiles({ dataDir, db });
    expect(first.removed).toBe(1);

    // Marker now current → second run skips entirely.
    const second = await pruneImportedLegacyFiles({ dataDir, db });
    expect(second.skipped).toBe(true);
  });
});
