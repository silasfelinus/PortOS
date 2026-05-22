/**
 * Test for migration 031 — rename legacy "World" → "Universe" data shapes
 * on disk. Picked up by server/vitest.config.js's
 * `../scripts/migrations/**\/*.test.js` glob.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './031-world-to-universe-data-rename.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 031 — world → universe data rename', () => {
  let rootDir;
  let dataDir;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-031-'));
    dataDir = join(rootDir, 'data');
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('renames world-builder.json → universe-builder.json and the top-level key', async () => {
    writeJson(join(dataDir, 'world-builder.json'), {
      worlds: [{ id: 'u-1', name: 'Echoes of the Choir' }],
      runs: [],
    });

    await migration.up({ rootDir });

    expect(existsSync(join(dataDir, 'world-builder.json'))).toBe(false);
    expect(existsSync(join(dataDir, 'universe-builder.json'))).toBe(true);
    const after = readJson(join(dataDir, 'universe-builder.json'));
    expect(after.universes).toEqual([{ id: 'u-1', name: 'Echoes of the Choir' }]);
    expect(after.worlds).toBeUndefined();
    expect(after.runs).toEqual([]);
  });

  it('renames worldId → universeId in pipeline-series.json', async () => {
    writeJson(join(dataDir, 'pipeline-series.json'), {
      series: [
        { id: 's-1', worldId: 'u-1', title: 'Test' },
        { id: 's-2', worldId: 'u-2', title: 'Other' },
      ],
    });

    await migration.up({ rootDir });

    const after = readJson(join(dataDir, 'pipeline-series.json'));
    expect(after.series[0].universeId).toBe('u-1');
    expect(after.series[0].worldId).toBeUndefined();
    expect(after.series[1].universeId).toBe('u-2');
  });

  it('renames worldRun → universeRun in media-jobs.json', async () => {
    writeJson(join(dataDir, 'media-jobs.json'), {
      jobs: [
        { id: 'j-1', params: { worldRun: 'r-1' } },
      ],
    });

    await migration.up({ rootDir });

    const after = readJson(join(dataDir, 'media-jobs.json'));
    expect(after.jobs[0].params.universeRun).toBe('r-1');
    expect(after.jobs[0].params.worldRun).toBeUndefined();
  });

  it('relinks legacy "World: <name>" collections to migrated universes', async () => {
    writeJson(join(dataDir, 'world-builder.json'), {
      worlds: [
        { id: 'u-choir', name: 'Echoes of the Choir' },
        { id: 'u-scav', name: 'Scavenger Time' },
      ],
    });
    writeJson(join(dataDir, 'media-collections.json'), {
      collections: [
        { id: 'c-1', name: 'World: Echoes of the Choir', items: [] },
        { id: 'c-2', name: 'World: Scavenger Time', items: [] },
        { id: 'c-3', name: 'My Personal Notes', items: [] }, // untouched
      ],
    });

    await migration.up({ rootDir });

    const after = readJson(join(dataDir, 'media-collections.json'));
    const byId = Object.fromEntries(after.collections.map((c) => [c.id, c]));
    expect(byId['c-1'].name).toBe('Universe: Echoes of the Choir');
    expect(byId['c-1'].universeId).toBe('u-choir');
    expect(byId['c-1'].updatedAt).toBeTruthy();
    expect(byId['c-2'].name).toBe('Universe: Scavenger Time');
    expect(byId['c-2'].universeId).toBe('u-scav');
    expect(byId['c-3'].name).toBe('My Personal Notes');
    expect(byId['c-3'].universeId).toBeUndefined();
  });

  it('skips ambiguous legacy collections that match multiple universes by name', async () => {
    writeJson(join(dataDir, 'world-builder.json'), {
      worlds: [
        { id: 'u-a', name: 'Duplicate' },
        { id: 'u-b', name: 'Duplicate' },
      ],
    });
    writeJson(join(dataDir, 'media-collections.json'), {
      collections: [
        { id: 'c-dup', name: 'World: Duplicate', items: [] },
      ],
    });

    await migration.up({ rootDir });

    const after = readJson(join(dataDir, 'media-collections.json'));
    expect(after.collections[0].name).toBe('World: Duplicate'); // unchanged
    expect(after.collections[0].universeId).toBeUndefined();
  });

  it('does not touch already-linked collections', async () => {
    writeJson(join(dataDir, 'world-builder.json'), {
      worlds: [{ id: 'u-1', name: 'Already Linked' }],
    });
    writeJson(join(dataDir, 'media-collections.json'), {
      collections: [
        { id: 'c-existing', name: 'Universe: Already Linked', universeId: 'u-1', items: [] },
      ],
    });

    const before = readJson(join(dataDir, 'media-collections.json'));
    await migration.up({ rootDir });
    const after = readJson(join(dataDir, 'media-collections.json'));
    expect(after.collections[0]).toEqual(before.collections[0]);
  });

  it('is a no-op when already migrated (idempotent re-run)', async () => {
    writeJson(join(dataDir, 'universe-builder.json'), {
      universes: [{ id: 'u-1', name: 'Already Migrated' }],
    });
    writeJson(join(dataDir, 'pipeline-series.json'), {
      series: [{ id: 's-1', universeId: 'u-1' }],
    });

    const beforeUniverse = readJson(join(dataDir, 'universe-builder.json'));
    const beforeSeries = readJson(join(dataDir, 'pipeline-series.json'));

    await migration.up({ rootDir });

    expect(readJson(join(dataDir, 'universe-builder.json'))).toEqual(beforeUniverse);
    expect(readJson(join(dataDir, 'pipeline-series.json'))).toEqual(beforeSeries);
  });

  it('leaves files alone when both legacy and new files exist (manual cleanup case)', async () => {
    writeJson(join(dataDir, 'world-builder.json'), {
      worlds: [{ id: 'u-old', name: 'Old' }],
    });
    writeJson(join(dataDir, 'universe-builder.json'), {
      universes: [{ id: 'u-new', name: 'New' }],
    });

    await migration.up({ rootDir });

    // Both files must still exist with original contents — the migration
    // refuses to clobber when there's an ambiguous starting state.
    expect(readJson(join(dataDir, 'world-builder.json')).worlds[0].name).toBe('Old');
    expect(readJson(join(dataDir, 'universe-builder.json')).universes[0].name).toBe('New');
  });

  it('handles missing files gracefully (fresh install)', async () => {
    // No files at all — every step is a no-op, must not throw.
    await expect(migration.up({ rootDir })).resolves.not.toThrow();
    expect(existsSync(join(dataDir, 'universe-builder.json'))).toBe(false);
  });
});
