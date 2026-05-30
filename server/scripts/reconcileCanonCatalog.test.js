/**
 * Tests for the boot-time canon↔catalog reconciliation.
 *
 * fs/promises (marker), fileUtils (PATHS), universeBuilder (listUniverses /
 * updateUniverse) and catalogDB (getIngredient / updateIngredient) are mocked,
 * so this exercises the walk + LWW-merge + dual-write orchestration:
 *   - newer catalog row wins → stamped back onto the embedded canon entry;
 *   - newer embedded entry wins → written into the catalog row;
 *   - entries without an ingredientId are untouched;
 *   - a clean pass writes the marker; a second run is a marker-gated no-op.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsState = { marker: null, written: null };
const dbState = { rows: {}, updates: [] };
const uniState = { universes: [], canonStamps: [] };

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => (fsState.marker == null
    ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    : JSON.stringify(fsState.marker))),
  writeFile: vi.fn(async (_p, data) => { fsState.written = JSON.parse(data); }),
}));

vi.mock('../lib/fileUtils.js', () => ({ PATHS: { data: '/tmp/portos-data' } }));

vi.mock('../services/universeBuilder.js', () => ({
  listUniverses: vi.fn(async () => uniState.universes),
  updateUniverse: vi.fn(async (id, mutator) => {
    const cur = uniState.universes.find((u) => u.id === id);
    const patch = mutator(cur || {});
    uniState.canonStamps.push({ id, patch });
    return patch;
  }),
}));

vi.mock('../services/catalogDB.js', () => ({
  getIngredient: vi.fn(async (id) => dbState.rows[id] || null),
  updateIngredient: vi.fn(async (id, patch, ctx) => {
    dbState.updates.push({ id, patch, ctx });
    return dbState.rows[id];
  }),
}));

const { reconcileCanonCatalog } = await import('./reconcileCanonCatalog.js');

beforeEach(() => {
  fsState.marker = null;
  fsState.written = null;
  dbState.rows = {};
  dbState.updates = [];
  uniState.universes = [];
  uniState.canonStamps = [];
});

describe('reconcileCanonCatalog', () => {
  it('catalog row newer → stamps catalog payload back onto the embedded canon entry', async () => {
    const past = '2026-01-01T00:00:00.000Z';
    const future = '2026-02-01T00:00:00.000Z';
    dbState.rows['cat-chr-1'] = { id: 'cat-chr-1', name: 'Ada', payload: { role: 'catalog-role' }, updatedAt: future };
    uniState.universes = [{
      id: 'u-1',
      characters: [{ id: 'e1', ingredientId: 'cat-chr-1', name: 'Ada', role: 'canon-role', updatedAt: past }],
    }];

    const result = await reconcileCanonCatalog();

    expect(result.skipped).toBe(false);
    expect(result.stats.catalogWon).toBe(1);
    expect(result.stats.canonWon).toBe(0);
    // No catalog write (catalog already authoritative); one canon stamp.
    expect(dbState.updates).toHaveLength(0);
    expect(uniState.canonStamps).toHaveLength(1);
    const stamped = uniState.canonStamps[0].patch.characters[0];
    expect(stamped.role).toBe('catalog-role');
  });

  it('embedded canon entry newer → writes it into the catalog row', async () => {
    const past = '2026-01-01T00:00:00.000Z';
    const future = '2026-02-01T00:00:00.000Z';
    dbState.rows['cat-chr-2'] = { id: 'cat-chr-2', name: 'Bee', payload: { role: 'old' }, updatedAt: past };
    uniState.universes = [{
      id: 'u-1',
      characters: [{ id: 'e1', ingredientId: 'cat-chr-2', name: 'Bee', role: 'fresh', updatedAt: future }],
    }];

    const result = await reconcileCanonCatalog();

    expect(result.stats.canonWon).toBe(1);
    expect(result.stats.catalogWon).toBe(0);
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0].patch.payload.role).toBe('fresh');
    expect(dbState.updates[0].ctx.source).toBe('sync');
    // No canon stamp needed (canon already authoritative).
    expect(uniState.canonStamps).toHaveLength(0);
  });

  it('leaves entries without an ingredientId untouched', async () => {
    uniState.universes = [{
      id: 'u-1',
      characters: [{ id: 'e1', name: 'Unpromoted', role: 'x', updatedAt: '2026-01-01T00:00:00.000Z' }],
    }];

    const result = await reconcileCanonCatalog();

    expect(result.stats.scanned).toBe(0);
    expect(dbState.updates).toHaveLength(0);
    expect(uniState.canonStamps).toHaveLength(0);
  });

  it('writes the completion marker on a clean pass', async () => {
    dbState.rows['cat-chr-3'] = { id: 'cat-chr-3', name: 'C', payload: {}, updatedAt: '2026-01-01T00:00:00.000Z' };
    uniState.universes = [{
      id: 'u-1',
      characters: [{ id: 'e1', ingredientId: 'cat-chr-3', name: 'C', updatedAt: '2026-01-01T00:00:00.000Z' }],
    }];

    const result = await reconcileCanonCatalog();
    expect(result.markerWritten).toBe(true);
    expect(fsState.written.version).toBe(1);
  });

  it('second run is a marker-gated no-op', async () => {
    fsState.marker = { version: 1, completedAt: '2026-01-01T00:00:00.000Z' };
    dbState.rows['cat-chr-4'] = { id: 'cat-chr-4', name: 'D', payload: { role: 'x' }, updatedAt: '2026-02-01T00:00:00.000Z' };
    uniState.universes = [{
      id: 'u-1',
      characters: [{ id: 'e1', ingredientId: 'cat-chr-4', name: 'D', role: 'y', updatedAt: '2026-01-01T00:00:00.000Z' }],
    }];

    const result = await reconcileCanonCatalog();

    expect(result.skipped).toBe(true);
    expect(dbState.updates).toHaveLength(0);
    expect(uniState.canonStamps).toHaveLength(0);
  });
});
