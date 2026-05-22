import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let existsResult = true;
// Queue of return values for sequential existsSync() calls. When empty, falls
// back to `existsResult`. Used to simulate ENOENT races where the file exists
// at the first check but disappears before the second.
const existsQueue = [];
const readFileMock = vi.fn();
const statMock = vi.fn();
const writeFileMock = vi.fn();

vi.mock('fs', () => ({
  existsSync: vi.fn(() => (existsQueue.length ? existsQueue.shift() : existsResult)),
}));

vi.mock('fs/promises', () => ({
  readFile: (...args) => readFileMock(...args),
  writeFile: (...args) => writeFileMock(...args),
  stat: (...args) => statMock(...args),
}));

let settings = { mortalloom: { enabled: true } };
vi.mock('./settings.js', () => ({
  getSettings: vi.fn(async () => settings),
}));

vi.mock('../lib/fileUtils.js', () => ({
  safeJSONParse: vi.fn((raw, fallback) => {
    if (typeof raw !== 'string' || !raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  }),
  readJSONFile: vi.fn(async () => null),
  dataPath: (...segs) => `/mock/data/${segs.join('/')}`,
  ensureDir: vi.fn(async () => {}),
}));

vi.mock('../lib/objects.js', () => ({
  isPlainObject: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
}));

const store = await import('./mortalLoomStore.js');

beforeEach(() => {
  existsResult = true;
  existsQueue.length = 0;
  readFileMock.mockReset();
  statMock.mockReset();
  writeFileMock.mockReset();
  settings = { mortalloom: { enabled: true, path: '/icloud/MortalLoom.json' } };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  // Restore every spy so the console.warn replacement above doesn't leak
  // into other test files (Vitest doesn't restoreMocks by default here).
  vi.restoreAllMocks();
});

describe('readStore', () => {
  it('returns null when file does not exist', async () => {
    existsResult = false;
    const result = await store.readStore();
    expect(result).toBeNull();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('returns parsed data on success', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ goals: [{ id: 'g1' }] }));
    const result = await store.readStore();
    expect(result).toEqual({ goals: [{ id: 'g1' }] });
  });

  it('returns null and logs a warning on EAGAIN read failure', async () => {
    const err = Object.assign(new Error('Unknown system error -11: Unknown system error -11, read'), {
      code: 'EAGAIN',
      errno: -11,
      syscall: 'read',
    });
    readFileMock.mockRejectedValue(err);

    const result = await store.readStore();

    expect(result).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('MortalLoom store unavailable (EAGAIN)')
    );
  });

  it('returns null on unknown errno without code', async () => {
    const err = Object.assign(new Error('Unknown system error -11, read'), { errno: -11 });
    readFileMock.mockRejectedValue(err);

    const result = await store.readStore();

    expect(result).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('MortalLoom store unavailable (-11)')
    );
  });

  it('does not warn when file disappears between existsSync and readFile (ENOENT race)', async () => {
    const err = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    readFileMock.mockRejectedValue(err);

    const result = await store.readStore();

    expect(result).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('returns null when the parsed JSON is a top-level array (unexpected shape)', async () => {
    // Every consumer expects { alcoholDrinks: [...], goals: [...], ... }.
    // A bare array slipping through would let callers misread "no fields
    // missing" as "store available," reporting empty counts. Treat as null.
    readFileMock.mockResolvedValue(JSON.stringify([{ id: 'a1' }, { id: 'a2' }]));
    const result = await store.readStore();
    expect(result).toBeNull();
  });

  it('returns null when the parsed JSON is a primitive', async () => {
    readFileMock.mockResolvedValue(JSON.stringify('legacy-string-blob'));
    const result = await store.readStore();
    expect(result).toBeNull();
  });
});

describe('mlArrayIfEnabled', () => {
  it('returns null when sync disabled', async () => {
    settings = { mortalloom: { enabled: false } };
    const result = await store.mlArrayIfEnabled('goals');
    expect(result).toBeNull();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('returns null when store read fails transiently (regression: goals endpoint must not 500)', async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error('boom'), { code: 'EAGAIN' }));
    const result = await store.mlArrayIfEnabled('goals');
    expect(result).toBeNull();
  });

  it('returns array when present', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ goals: [{ id: 'g1' }, { id: 'g2' }] }));
    const result = await store.mlArrayIfEnabled('goals');
    expect(result).toEqual([{ id: 'g1' }, { id: 'g2' }]);
  });
});

describe('updateStore', () => {
  it('seeds a fresh store when the file does not exist', async () => {
    existsResult = false;
    writeFileMock.mockResolvedValue(undefined);
    const result = await store.updateStore((s) => {
      s.goals.push({ id: 'new-1' });
      return s.goals[0];
    });
    expect(result).toEqual({ id: 'new-1' });
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const written = JSON.parse(writeFileMock.mock.calls[0][1]);
    expect(written.goals).toEqual([{ id: 'new-1' }]);
  });

  it('refuses to overwrite when file exists but read fails (regression: no silent truncation)', async () => {
    existsResult = true;
    readFileMock.mockRejectedValue(Object.assign(new Error('boom'), { code: 'EAGAIN' }));
    writeFileMock.mockResolvedValue(undefined);
    await expect(
      store.updateStore((s) => { s.goals.push({ id: 'should-not-write' }); })
    ).rejects.toThrow(/unreadable; refusing to overwrite/);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('throws a path-free message so route handlers do not leak the iCloud path to clients', async () => {
    existsResult = true;
    readFileMock.mockRejectedValue(Object.assign(new Error('boom'), { code: 'EAGAIN' }));
    writeFileMock.mockResolvedValue(undefined);
    let caught;
    await store.updateStore((s) => { s.goals.push({ id: 'x' }); }).catch((err) => { caught = err; });
    expect(caught).toBeDefined();
    expect(caught.message).not.toContain('/icloud/MortalLoom.json');
    expect(caught.message).not.toContain('/');
    // The full path still goes to server logs for diagnostics.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('/icloud/MortalLoom.json')
    );
  });

  it('refuses to overwrite when file exists but JSON is corrupt', async () => {
    existsResult = true;
    readFileMock.mockResolvedValue('{not json');
    writeFileMock.mockResolvedValue(undefined);
    await expect(
      store.updateStore((s) => { s.goals.push({ id: 'should-not-write' }); })
    ).rejects.toThrow(/unreadable; refusing to overwrite/);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('refuses to overwrite when file parses as an array (truncation guard)', async () => {
    existsResult = true;
    readFileMock.mockResolvedValue(JSON.stringify(['unexpected', 'array', 'shape']));
    writeFileMock.mockResolvedValue(undefined);
    await expect(
      store.updateStore((s) => { s.goals.push({ id: 'should-not-write' }); })
    ).rejects.toThrow(/unreadable; refusing to overwrite/);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('seeds a fresh store when the file disappears between existsSync and read (ENOENT race)', async () => {
    // existsSync sequence: (1) inside readStoreAtPath → true (read attempted),
    // (2) post-read check in updateStore's guard → false (file vanished).
    // The post-read recheck must discriminate this from a transient/corrupt
    // case so we don't reject a legitimate seed.
    existsQueue.push(true, false);
    readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    writeFileMock.mockResolvedValue(undefined);
    const result = await store.updateStore((s) => {
      s.goals.push({ id: 'seeded' });
      return s.goals[0];
    });
    expect(result).toEqual({ id: 'seeded' });
    expect(writeFileMock).toHaveBeenCalledTimes(1);
  });

  it('refuses to overwrite when file was absent initially but appears unreadable mid-call (reverse race)', async () => {
    // existsSync sequence: (1) inside readStoreAtPath → false (file absent at
    // the start of the read), (2) post-read check in updateStore's guard →
    // true (iCloud just finished downloading the file). Even though we'd be
    // happy to seed a fresh store, the now-present file's content is unknown,
    // so we must not blindly clobber it.
    existsQueue.push(false, true);
    writeFileMock.mockResolvedValue(undefined);
    await expect(
      store.updateStore((s) => { s.goals.push({ id: 'should-not-write' }); })
    ).rejects.toThrow(/unreadable; refusing to overwrite/);
    expect(writeFileMock).not.toHaveBeenCalled();
  });
});

describe('getStatus', () => {
  it('returns exists:false when file is missing', async () => {
    existsResult = false;
    const status = await store.getStatus();
    expect(status.exists).toBe(false);
    expect(status.size).toBe(0);
    expect(status.summary).toBeNull();
  });

  it('survives a transient stat/read failure with null summary and logs a warning', async () => {
    statMock.mockRejectedValue(Object.assign(new Error('boom'), { code: 'EAGAIN' }));
    const status = await store.getStatus();
    expect(status.exists).toBe(true);
    expect(status.size).toBe(0);
    expect(status.mtime).toBeNull();
    expect(status.summary).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('MortalLoom status stat unavailable (EAGAIN)')
    );
  });

  it('treats ENOENT during stat (file deleted after existsSync) as missing, not transient', async () => {
    statMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const status = await store.getStatus();
    expect(status.exists).toBe(false);
    expect(status.size).toBe(0);
    expect(status.mtime).toBeNull();
    expect(status.summary).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('treats ENOENT during readFile (file deleted after successful stat) as missing, not phantom', async () => {
    statMock.mockResolvedValue({ size: 42, mtime: new Date('2026-01-01T00:00:00Z') });
    readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const status = await store.getStatus();
    expect(status.exists).toBe(false);
    expect(status.size).toBe(0);
    expect(status.mtime).toBeNull();
    expect(status.summary).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('returns null summary when file parses as a top-level array (unexpected shape)', async () => {
    statMock.mockResolvedValue({ size: 16, mtime: new Date('2026-01-01T00:00:00Z') });
    readFileMock.mockResolvedValue(JSON.stringify([{ id: 'a1' }, { id: 'a2' }]));
    const status = await store.getStatus();
    expect(status.exists).toBe(true);
    expect(status.size).toBe(16);
    expect(status.summary).toBeNull();
  });

  it('returns counts when file readable', async () => {
    statMock.mockResolvedValue({ size: 42, mtime: new Date('2026-01-01T00:00:00Z') });
    readFileMock.mockResolvedValue(JSON.stringify({
      goals: [{ id: 'g1' }],
      alcoholDrinks: [{ id: 'a1' }, { id: 'a2' }],
      profile: { biologicalSex: 'm' },
    }));
    const status = await store.getStatus();
    expect(status.exists).toBe(true);
    expect(status.size).toBe(42);
    expect(status.summary.goals).toBe(1);
    expect(status.summary.alcoholDrinks).toBe(2);
    expect(status.summary.hasProfile).toBe(true);
  });
});
