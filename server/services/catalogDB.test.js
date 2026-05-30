/**
 * Postgres-backed CRUD round-trip for the catalog data layer.
 *
 * This suite needs a live PostgreSQL instance with the catalog schema applied
 * (the same one `npm start` connects to). If no DB is reachable — the common
 * case in CI and on fresh checkouts — it SKIPS cleanly with a clear message
 * rather than failing red. When a DB IS reachable it exercises the full
 * scrap → ingredient → ref → source lifecycle and tears its rows back out so
 * the suite is repeatable.
 *
 * `instances.js` is left under the global vitest.setup.js mock (getPeers → [])
 * so no row created here fans out to live sync peers; nothing here exercises
 * the createUniverse/createSeries peerSync import path, so mockNoPeers alone
 * is sufficient per the CLAUDE.md record-creating-tests rule.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { checkHealth, ensureSchema, close } from '../lib/db.js';
import * as catalogDB from './catalogDB.js';

// Probe the DB ONCE at module load via top-level await, so the suite is
// registered with `describe.skipIf(!dbReady)` below and the runner reports
// its tests as SKIPPED when Postgres is unreachable — rather than as
// zero-assertion green, which would silently mask a broken connection in CI.
let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    // ensureSchema is idempotent: creates the catalog tables when absent and
    // ALTERs an older DB (missing newer tombstone columns) up to current.
    await ensureSchema().catch(() => {});
    const recheck = await checkHealth().catch(() => ({ hasCatalogSchema: false }));
    if (recheck.hasCatalogSchema) dbReady = true;
    else skipReason = 'catalog schema not present (ensureSchema did not create catalog tables)';
  }
}
if (!dbReady) console.log(`⏭️ catalogDB.test: skipping suite — ${skipReason || 'no database'}`);

// Secondary guard for the (registered) tests: when the suite runs, dbReady is
// always true here, so this is a no-op; describe.skipIf is the real gate.
function requireDb() { return dbReady; }

// Track ids created across tests so end-of-suite cleanup hard-deletes them
// even when an assertion throws mid-test. Cleanup runs BEFORE the pool is
// closed (single afterAll, in order) so the deletes have a live connection.
const createdIngredientIds = new Set();
const createdScrapIds = new Set();

afterAll(async () => {
  if (!dbReady) return;
  for (const id of createdIngredientIds) {
    await catalogDB.deleteIngredient(id, { hard: true }).catch(() => {});
  }
  for (const id of createdScrapIds) {
    await catalogDB.deleteScrap(id, { hard: true }).catch(() => {});
  }
  await close();
});

describe.skipIf(!dbReady)('catalogDB (Postgres CRUD round-trip)', () => {
  it('creates and reads back an ingredient with payload + tags', async () => {
    if (!requireDb('create/get ingredient')) return;
    const created = await catalogDB.createIngredient({
      type: 'character',
      name: '  Echo Saint  ',
      payload: { physicalDescription: 'A wiry figure in a long coat.', personality: 'Wry' },
      tags: ['noir', 'protagonist'],
    });
    createdIngredientIds.add(created.id);

    expect(created.id).toMatch(/^cat-chr-/);
    expect(created.name).toBe('Echo Saint'); // trimmed
    expect(created.type).toBe('character');
    expect(created.payload.physicalDescription).toContain('wiry figure');
    expect(created.tags).toEqual(['noir', 'protagonist']);
    expect(created.deleted).toBe(false);

    const fetched = await catalogDB.getIngredient(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe('Echo Saint');
    expect(fetched.payload.personality).toBe('Wry');
  });

  it('rejects an invalid type and a blank name', async () => {
    if (!requireDb('create validation')) return;
    await expect(catalogDB.createIngredient({ type: 'spaceship', name: 'X' }))
      .rejects.toThrow(/Invalid ingredient type/);
    await expect(catalogDB.createIngredient({ type: 'idea', name: '   ' }))
      .rejects.toThrow(/name is required/);
  });

  it('updates name/payload/tags in place and preserves untouched fields', async () => {
    if (!requireDb('update ingredient')) return;
    const created = await catalogDB.createIngredient({
      type: 'place',
      name: 'Old Harbor',
      payload: { description: 'Brine and rust.' },
      tags: ['coastal'],
    });
    createdIngredientIds.add(created.id);

    const updated = await catalogDB.updateIngredient(created.id, {
      name: 'New Harbor',
      tags: ['coastal', 'rebuilt'],
    });
    expect(updated.name).toBe('New Harbor');
    expect(updated.tags).toEqual(['coastal', 'rebuilt']);
    // payload untouched — only patched fields change
    expect(updated.payload.description).toBe('Brine and rust.');
  });

  it('soft-deletes so GET returns null but the row survives for sync', async () => {
    if (!requireDb('soft-delete ingredient')) return;
    const created = await catalogDB.createIngredient({ type: 'object', name: 'Brass Key' });
    createdIngredientIds.add(created.id);

    await catalogDB.deleteIngredient(created.id);
    const afterDelete = await catalogDB.getIngredient(created.id);
    expect(afterDelete).toBeNull();

    // The tombstone is still visible to the sync change-feed.
    const { items } = await catalogDB.getIngredientChangesSince('0', 1000);
    const tombstone = items.find((i) => i.id === created.id);
    expect(tombstone).toBeTruthy();
    expect(tombstone.deleted).toBe(true);
  });

  it('reviveDeletedIngredient un-deletes a soft-deleted row at the same id', async () => {
    if (!requireDb('revive ingredient')) return;
    const created = await catalogDB.createIngredient({
      type: 'concept', name: 'Entropy', payload: { summary: 'old' },
    });
    createdIngredientIds.add(created.id);
    await catalogDB.deleteIngredient(created.id);

    const revived = await catalogDB.reviveDeletedIngredient(created.id, {
      type: 'concept', name: 'Entropy', payload: { summary: 'new' }, tags: ['physics'],
    });
    expect(revived).not.toBeNull();
    expect(revived.deleted).toBe(false);
    expect(revived.payload.summary).toBe('new');

    // A fresh GET now succeeds (the row is active again).
    const fetched = await catalogDB.getIngredient(created.id);
    expect(fetched.tags).toEqual(['physics']);

    // Reviving a row that is NOT deleted returns null (no-op).
    const noop = await catalogDB.reviveDeletedIngredient(created.id, {
      type: 'concept', name: 'Entropy',
    });
    expect(noop).toBeNull();
  });

  it('lists by type and strips the embedding on the light path (but getIngredient returns it)', async () => {
    if (!requireDb('list by type')) return;
    // 768-dim to match the catalog_ingredients.embedding vector(768) column —
    // the row genuinely HAS an embedding, so a null on the list path proves the
    // light-column projection strips it (not merely an absent vector).
    const vec = Array.from({ length: 768 }, (_, i) => (i % 7) * 0.01);
    const scene = await catalogDB.createIngredient({
      type: 'scene', name: 'Rooftop Standoff', embedding: vec, embeddingModel: 'test-model',
    });
    createdIngredientIds.add(scene.id);

    const { items } = await catalogDB.listIngredients({ type: 'scene', limit: 200 });
    expect(items.every((i) => i.type === 'scene')).toBe(true);
    const listed = items.find((i) => i.id === scene.id);
    expect(listed).toBeTruthy();
    // Light list path omits the embedding column → null.
    expect(listed.embedding).toBeNull();

    // The full read returns the populated 768-vector — the divergence is the contract.
    const full = await catalogDB.getIngredient(scene.id);
    expect(Array.isArray(full.embedding)).toBe(true);
    expect(full.embedding).toHaveLength(768);
  });

  it('links an ingredient to a ref, lists both directions, then soft-unlinks', async () => {
    if (!requireDb('ref link/unlink')) return;
    const ing = await catalogDB.createIngredient({ type: 'character', name: 'Linker McRef' });
    createdIngredientIds.add(ing.id);
    const refId = `series-${ing.id}`; // unique synthetic ref id

    await catalogDB.linkIngredientToRef(ing.id, 'series', refId, 'cast-character');

    const refs = await catalogDB.listRefsForIngredient(ing.id);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ refKind: 'series', refId, role: 'cast-character', deleted: false });

    const forRef = await catalogDB.listIngredientsForRef('series', refId);
    expect(forRef).toHaveLength(1);
    expect(forRef[0].ingredient.id).toBe(ing.id);
    expect(forRef[0].role).toBe('cast-character');

    await catalogDB.unlinkIngredientFromRef(ing.id, 'series', refId, 'cast-character');
    // Live list paths hide tombstoned links.
    expect(await catalogDB.listRefsForIngredient(ing.id)).toHaveLength(0);
    expect(await catalogDB.listIngredientsForRef('series', refId)).toHaveLength(0);
  });

  it('creates a scrap, links it as an ingredient source, and hydrates it back', async () => {
    if (!requireDb('scrap source link')) return;
    const scrap = await catalogDB.createScrap({
      title: 'Notebook page',
      rawText: 'A long coat, a longer memory.',
      sourceKind: 'paste',
    });
    createdScrapIds.add(scrap.id);
    expect(scrap.id).toMatch(/^cat-scrap-/);

    const ing = await catalogDB.createIngredient({ type: 'character', name: 'Sourced One' });
    createdIngredientIds.add(ing.id);

    await catalogDB.linkIngredientToSource(ing.id, scrap.id, { start: 0, end: 10 });

    const sources = await catalogDB.listSourcesForIngredient(ing.id);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ scrapId: scrap.id, ingredientId: ing.id });
    expect(sources[0].span).toEqual({ start: 0, end: 10 });

    const forScrap = await catalogDB.listSourcesForScrap(scrap.id);
    expect(forScrap.some((s) => s.ingredientId === ing.id)).toBe(true);

    const hydrated = await catalogDB.listScrapsForIngredient(ing.id);
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0].rawText).toContain('long coat');
  });

  it('exportSliceForRef bundles ingredients + scraps + refs for a ref', async () => {
    if (!requireDb('export slice')) return;
    const ing = await catalogDB.createIngredient({
      type: 'character', name: 'Bundled Hero', payload: { role: 'lead' },
    });
    createdIngredientIds.add(ing.id);
    const refId = `work-${ing.id}`;
    await catalogDB.linkIngredientToRef(ing.id, 'work', refId, 'cast-character');
    const scrap = await catalogDB.createScrap({ rawText: 'Origin notes.' });
    createdScrapIds.add(scrap.id);
    await catalogDB.linkIngredientToSource(ing.id, scrap.id);

    const bundle = await catalogDB.exportSliceForRef('work', refId);
    expect(bundle.version).toBe(1);
    expect(bundle.ref).toEqual({ kind: 'work', id: refId });
    expect(bundle.ingredients).toHaveLength(1);
    const exported = bundle.ingredients[0];
    expect(exported.id).toBe(ing.id);
    expect(exported.roleForExportedRef).toBe('cast-character');
    expect(exported.scraps).toHaveLength(1);
    // Embedding is stripped from the export.
    expect(exported.embedding).toBeUndefined();
  });

  it('getCatalogStats reflects created rows', async () => {
    if (!requireDb('catalog stats')) return;
    const ing = await catalogDB.createIngredient({ type: 'idea', name: 'Stat Idea' });
    createdIngredientIds.add(ing.id);
    const stats = await catalogDB.getCatalogStats();
    expect(typeof stats.total).toBe('number');
    expect(stats.byType.idea).toBeGreaterThanOrEqual(1);
  });

  it('getMaxSequences returns numeric-string cursors for every table', async () => {
    if (!requireDb('max sequences')) return;
    const seqs = await catalogDB.getMaxSequences();
    for (const key of ['ingredients', 'scraps', 'sources', 'refs']) {
      expect(seqs[key]).toMatch(/^\d+$/);
    }
  });
});
