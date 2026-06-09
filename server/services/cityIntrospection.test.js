/**
 * Tests for the Data Harbor introspection service: DB section shape (including
 * the down-DB → `db: null` absent-vs-empty contract), the data/ domain walk
 * (sizes, file counts, symlink skip, "(root)" pseudo-domain), and the
 * TTL + stale-while-revalidate cache discipline.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'city-introspection-test-'));

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: TEST_DATA_ROOT }));

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../lib/db.js', () => ({ query: queryMock }));

const {
  getCityIntrospection,
  resetIntrospectionCache,
  INTROSPECTION_TTL_MS,
} = await import('./cityIntrospection.js');

const TABLE_ROWS = [
  { name: 'memories', row_estimate: '1200', total_bytes: '900000' },
  { name: 'catalog_scraps', row_estimate: '40', total_bytes: '50000' },
  { name: 'schema_migrations', row_estimate: '12', total_bytes: '8000' },
];

// Default happy-path query dispatcher, keyed on SQL shape.
const happyQueries = (sql) => {
  if (sql.includes('pg_stat_user_tables')) return { rows: TABLE_ROWS };
  if (sql.includes('information_schema.columns')) {
    return { rows: [{ table_name: 'memories' }, { table_name: 'catalog_scraps' }] };
  }
  if (sql.includes('pg_database_size')) return { rows: [{ bytes: '5000000' }] };
  if (sql.includes('schema_migrations')) {
    return { rows: [{ applied: 12, last_applied: '2026-06-01T00:00:00.000Z' }] };
  }
  throw new Error(`unexpected query: ${sql}`);
};

const writeFixtureTree = () => {
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
  mkdirSync(join(TEST_DATA_ROOT, 'images', 'sub'), { recursive: true });
  mkdirSync(join(TEST_DATA_ROOT, 'brain'), { recursive: true });
  writeFileSync(join(TEST_DATA_ROOT, 'images', 'a.png'), 'aaaaa'); // 5 bytes
  writeFileSync(join(TEST_DATA_ROOT, 'images', 'sub', 'b.png'), 'bbb'); // 3 bytes
  writeFileSync(join(TEST_DATA_ROOT, 'brain', 'x.json'), 'ccccccc'); // 7 bytes
  writeFileSync(join(TEST_DATA_ROOT, 'loose.json'), 'dd'); // 2 bytes
  // A symlinked directory must not be walked (or counted).
  symlinkSync(join(TEST_DATA_ROOT, 'images'), join(TEST_DATA_ROOT, 'linked'));
};

beforeEach(() => {
  resetIntrospectionCache();
  vi.restoreAllMocks();
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql) => happyQueries(sql));
  writeFixtureTree();
});

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe('getCityIntrospection — db section', () => {
  it('maps tables with coerced numbers, embedding flags, size, and migrations', async () => {
    const result = await getCityIntrospection();
    expect(result.ts).toBeTruthy();
    expect(result.db.sizeBytes).toBe(5000000);
    expect(result.db.tables).toHaveLength(3);
    const memories = result.db.tables.find((t) => t.name === 'memories');
    expect(memories).toEqual({
      name: 'memories', rowEstimate: 1200, totalBytes: 900000, hasEmbedding: true,
    });
    const migrationsTable = result.db.tables.find((t) => t.name === 'schema_migrations');
    expect(migrationsTable.hasEmbedding).toBe(false);
    expect(result.db.migrations).toEqual({ applied: 12, lastApplied: '2026-06-01T00:00:00.000Z' });
  });

  it('returns db: null (absent, not empty) when the table query fails', async () => {
    queryMock.mockImplementation(async (sql) => {
      if (sql.includes('pg_stat_user_tables')) throw new Error('connection refused');
      return happyQueries(sql);
    });
    const result = await getCityIntrospection();
    expect(result.db).toBeNull();
    // The filesystem section is independent of DB health.
    expect(result.fs.domains.length).toBeGreaterThan(0);
  });

  it('tolerates enrichment failures without sinking the section', async () => {
    queryMock.mockImplementation(async (sql) => {
      if (sql.includes('schema_migrations')) throw new Error('relation does not exist');
      if (sql.includes('pg_database_size')) throw new Error('nope');
      if (sql.includes('information_schema.columns')) throw new Error('nope');
      return happyQueries(sql);
    });
    const result = await getCityIntrospection();
    expect(result.db.tables).toHaveLength(3);
    expect(result.db.migrations).toBeNull();
    expect(result.db.sizeBytes).toBeNull();
    expect(result.db.tables.every((t) => t.hasEmbedding === false)).toBe(true);
  });
});

describe('getCityIntrospection — fs section', () => {
  it('walks domains recursively, rolls loose files into (root), sorts by size', async () => {
    const { fs } = await getCityIntrospection();
    expect(fs.domains.map((d) => d.name)).toEqual(['images', 'brain', '(root)']);
    expect(fs.domains[0]).toEqual({ name: 'images', bytes: 8, files: 2 });
    expect(fs.domains[1]).toEqual({ name: 'brain', bytes: 7, files: 1 });
    expect(fs.domains[2]).toEqual({ name: '(root)', bytes: 2, files: 1 });
    expect(fs.totalBytes).toBe(17);
    expect(fs.totalFiles).toBe(4);
  });

  it('skips symlinked directories entirely', async () => {
    const { fs } = await getCityIntrospection();
    expect(fs.domains.find((d) => d.name === 'linked')).toBeUndefined();
  });
});

describe('getCityIntrospection — cache discipline', () => {
  it('serves the cached payload within the TTL without re-querying', async () => {
    const first = await getCityIntrospection();
    const callsAfterFirst = queryMock.mock.calls.length;
    const second = await getCityIntrospection();
    expect(second).toBe(first);
    expect(queryMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('serves stale immediately past the TTL while revalidating in the background', async () => {
    const first = await getCityIntrospection();
    // Jump past the TTL without fake timers — the background rebuild does real
    // (mocked-fs) I/O that fake timers can't flush.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + INTROSPECTION_TTL_MS + 1000);

    // Make the rebuild distinguishable.
    queryMock.mockImplementation(async (sql) => {
      if (sql.includes('pg_database_size')) return { rows: [{ bytes: '777' }] };
      return happyQueries(sql);
    });

    const stale = await getCityIntrospection();
    expect(stale).toBe(first); // immediate stale answer, no blocking on the walk

    // Once the background rebuild settles, the fresh payload is served.
    await vi.waitFor(async () => {
      expect((await getCityIntrospection()).db.sizeBytes).toBe(777);
    });
    vi.restoreAllMocks();
  });
});
