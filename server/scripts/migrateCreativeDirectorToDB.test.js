/**
 * Tests for the legacy creative-director-projects.json → Postgres importer.
 *
 * Marker file I/O + the legacy file read/rename are mocked to an in-memory
 * blob; `db.query` is a fake that records INSERTs and honors ON CONFLICT DO
 * NOTHING. No disk, no Postgres.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory filesystem keyed by absolute path.
let files = {};

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { data: '/fake/data' },
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (path) => {
    if (!(path in files)) {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    return files[path];
  }),
  writeFile: vi.fn(async (path, content) => { files[path] = content; }),
  rename: vi.fn(async (from, to) => {
    files[to] = files[from];
    delete files[from];
  }),
}));

// Fake DB: a Map standing in for creative_director_projects, with ON CONFLICT
// DO NOTHING semantics.
let table;
const query = vi.fn(async (sql, params) => {
  if (/INSERT INTO creative_director_projects/.test(sql)) {
    const [id, status, data] = params;
    if (table.has(id)) return { rowCount: 0, rows: [] };
    table.set(id, { id, status, data });
    return { rowCount: 1, rows: [] };
  }
  return { rowCount: 0, rows: [] };
});
vi.mock('../lib/db.js', () => ({ query: (...a) => query(...a) }));

const LEGACY = '/fake/data/creative-director-projects.json';
const MARKER = '/fake/data/creative-director-projects.migrated.json';
const IMPORTED = LEGACY + '.imported';

const { migrateCreativeDirectorToDB } = await import('./migrateCreativeDirectorToDB.js');

beforeEach(() => {
  files = {};
  table = new Map();
  query.mockClear();
});

describe('migrateCreativeDirectorToDB', () => {
  it('fresh install (no legacy file): stamps marker, imports nothing', async () => {
    const result = await migrateCreativeDirectorToDB();
    expect(result).toMatchObject({ ok: true, reason: 'fresh-install', imported: 0 });
    expect(files[MARKER]).toBeTruthy();
    expect(query).not.toHaveBeenCalled();
  });

  it('imports legacy projects into the table and renames the file aside', async () => {
    files[LEGACY] = JSON.stringify([
      { id: 'cd-1', status: 'complete', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
      { id: 'cd-2', status: 'draft', createdAt: '2026-01-03T00:00:00.000Z' },
    ]);
    const result = await migrateCreativeDirectorToDB();
    expect(result).toMatchObject({ ok: true, reason: 'imported', imported: 2 });
    expect(table.has('cd-1')).toBe(true);
    expect(table.has('cd-2')).toBe(true);
    // Legacy renamed aside (recovery source), marker written.
    expect(files[LEGACY]).toBeUndefined();
    expect(files[IMPORTED]).toBeTruthy();
    expect(files[MARKER]).toBeTruthy();
  });

  it('is a no-op on the second run (marker present)', async () => {
    files[LEGACY] = JSON.stringify([{ id: 'cd-1', status: 'draft' }]);
    await migrateCreativeDirectorToDB();
    query.mockClear();
    const result = await migrateCreativeDirectorToDB();
    expect(result).toMatchObject({ ok: true, reason: 'already-applied' });
    expect(query).not.toHaveBeenCalled();
  });

  it('does not clobber a row already in the table (ON CONFLICT DO NOTHING)', async () => {
    table.set('cd-1', { id: 'cd-1', status: 'rendering', data: '{"fresher":true}' });
    files[LEGACY] = JSON.stringify([{ id: 'cd-1', status: 'draft' }]);
    const result = await migrateCreativeDirectorToDB();
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(table.get('cd-1').data).toBe('{"fresher":true}');
  });

  it('skips malformed records (missing id) without aborting the import', async () => {
    files[LEGACY] = JSON.stringify([{ id: 'cd-1', status: 'draft' }, { noId: true }, null]);
    const result = await migrateCreativeDirectorToDB();
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it('leaves a corrupt legacy file in place for repair (no marker, no rename)', async () => {
    files[LEGACY] = '{ not valid json';
    const result = await migrateCreativeDirectorToDB();
    expect(result).toMatchObject({ ok: false, reason: 'unreadable' });
    expect(files[LEGACY]).toBeTruthy();   // untouched
    expect(files[MARKER]).toBeUndefined(); // not stamped → retries next boot
  });
});
