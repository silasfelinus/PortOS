/**
 * Catalog sync — user-defined-type (catalog v8) federation tests.
 *
 * Covers the outbound `catalogTypes` envelope block, the inbound LWW-merge
 * (`applyUserTypesFromPeer` via `applyRemoteChanges`), and the version gate.
 * settings + catalogDB are mocked so the suite stays pure (no Postgres / disk).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory settings store the merge reads/writes.
let store = {};
vi.mock('./settings.js', () => ({
  getSettings: vi.fn(async () => ({ ...store })),
  updateSettings: vi.fn(async (patch) => { store = { ...store, ...patch }; return { ...store }; }),
}));

// catalogDB upserts/changes are no-ops here — we only exercise the catalogTypes
// path, but applyRemoteChanges dispatches every kind, so stub them all.
vi.mock('./catalogDB.js', () => ({
  getScrapChangesSince: vi.fn(async () => ({ items: [], hasMore: false })),
  getIngredientChangesSince: vi.fn(async () => ({ items: [], hasMore: false })),
  getSourceChangesSince: vi.fn(async () => ({ items: [], hasMore: false })),
  getRefChangesSince: vi.fn(async () => ({ items: [], hasMore: false })),
  getRelationChangesSince: vi.fn(async () => ({ items: [], hasMore: false })),
  getTagChangesSince: vi.fn(async () => ({ items: [], hasMore: false })),
  getMediaChangesSince: vi.fn(async () => ({ items: [], hasMore: false })),
  getMaxSequences: vi.fn(async () => ({ scraps: '0', ingredients: '0', sources: '0', refs: '0', relations: '0', tags: '0', media: '0' })),
  upsertScrapFromPeer: vi.fn(), upsertIngredientFromPeer: vi.fn(), upsertSourceFromPeer: vi.fn(),
  upsertRefFromPeer: vi.fn(), upsertRelationFromPeer: vi.fn(), upsertTagFromPeer: vi.fn(),
  upsertMediaFromPeer: vi.fn(), updateIngredient: vi.fn(),
}));
vi.mock('./universeBuilder.js', () => ({ listUniverses: vi.fn(async () => []) }));

const { getChangesSince, applyRemoteChanges } = await import('./catalogSync.js');
const { PORTOS_SCHEMA_VERSIONS } = await import('../lib/schemaVersions.js');
const { setUserCatalogTypes, getActiveCatalogType } = await import('../lib/catalogTypes.js');

beforeEach(() => {
  store = {};
  setUserCatalogTypes([]);
});

describe('getChangesSince — catalogTypes outbound block', () => {
  it('rides every envelope from the settings slice', async () => {
    store = { catalogUserTypes: [{ id: 'faction', label: 'Faction', primaryContentKey: 'creed', fields: [] }] };
    const changes = await getChangesSince('0', 100);
    expect(changes.catalogTypes).toEqual(store.catalogUserTypes);
  });

  it('is an empty array when no user types are defined', async () => {
    const changes = await getChangesSince('0', 100);
    expect(changes.catalogTypes).toEqual([]);
  });
});

describe('applyRemoteChanges — catalogTypes LWW merge', () => {
  const meta = { schemaVersions: { catalog: PORTOS_SCHEMA_VERSIONS.catalog } };

  it('adopts a first-seen peer type and refreshes the registry', async () => {
    const stats = await applyRemoteChanges({
      portosMeta: meta,
      catalogTypes: [{ id: 'faction', label: 'Faction', primaryContentKey: 'creed', fields: [], updatedAt: '2026-01-01' }],
    });
    expect(stats.catalogTypes.applied).toBe(1);
    expect(store.catalogUserTypes).toHaveLength(1);
    expect(getActiveCatalogType('faction')?.label).toBe('Faction');
  });

  it('LWW: a newer peer type wins, an older one is skipped', async () => {
    store = { catalogUserTypes: [{ id: 'faction', label: 'Old', primaryContentKey: 'x', fields: [], updatedAt: '2026-01-01' }] };
    // Older → skipped.
    let stats = await applyRemoteChanges({ portosMeta: meta, catalogTypes: [{ id: 'faction', label: 'Older', primaryContentKey: 'x', fields: [], updatedAt: '2025-01-01' }] });
    expect(stats.catalogTypes.applied).toBe(0);
    expect(stats.catalogTypes.skipped).toBe(1);
    expect(store.catalogUserTypes[0].label).toBe('Old');
    // Newer → wins.
    stats = await applyRemoteChanges({ portosMeta: meta, catalogTypes: [{ id: 'faction', label: 'New', primaryContentKey: 'x', fields: [], updatedAt: '2027-01-01' }] });
    expect(stats.catalogTypes.applied).toBe(1);
    expect(store.catalogUserTypes[0].label).toBe('New');
  });

  it('skips a peer type colliding with a built-in system id', async () => {
    const stats = await applyRemoteChanges({ portosMeta: meta, catalogTypes: [{ id: 'character', label: 'Hijack', primaryContentKey: 'x', fields: [], updatedAt: '2027-01-01' }] });
    expect(stats.catalogTypes.applied).toBe(0);
    expect(stats.catalogTypes.skipped).toBe(1);
    expect(store.catalogUserTypes ?? []).toHaveLength(0);
  });

  it('rejects with 412 when the sender is ahead on the catalog schema', async () => {
    await expect(applyRemoteChanges({
      portosMeta: { schemaVersions: { catalog: PORTOS_SCHEMA_VERSIONS.catalog + 1 } },
      catalogTypes: [{ id: 'faction', label: 'Faction', primaryContentKey: 'x', fields: [] }],
    })).rejects.toMatchObject({ status: 412 });
  });
});
