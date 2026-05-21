import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './030-seed-intent-dashboard-layouts.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 030 — seed intent-named dashboard layouts', () => {
  let rootDir;
  let layoutsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-030-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    layoutsPath = join(rootDir, 'data', 'dashboard-layouts.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('no-ops cleanly when dashboard-layouts.json is missing (fresh install)', async () => {
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(result.reason).toBe('no-state');
    expect(existsSync(layoutsPath)).toBe(false);
  });

  it('inserts all three new built-ins when none are present', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        { id: 'default', name: 'Everything', builtIn: true, widgets: ['quick-task'], grid: [] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(3);
    const after = readJson(layoutsPath);
    const ids = after.layouts.map((l) => l.id);
    expect(ids).toContain('deep-work');
    expect(ids).toContain('health');
    expect(ids).toContain('agent-watch');
    const dw = after.layouts.find((l) => l.id === 'deep-work');
    expect(dw.builtIn).toBe(true);
    expect(dw.widgets).toContain('upcoming-tasks');
    expect(dw.grid.length).toBeGreaterThan(0);
  });

  it('is idempotent — second run is a no-op', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        { id: 'default', name: 'Everything', builtIn: true, widgets: ['quick-task'], grid: [] },
      ],
    });
    await migration.up({ rootDir });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(result.reason).toBe('already-applied');
  });

  it('seeds only the missing layouts when some are already present', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        { id: 'default', name: 'Everything', builtIn: true, widgets: ['quick-task'], grid: [] },
        { id: 'health', name: 'Health (custom)', builtIn: true, widgets: ['death-clock'], grid: [] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(2);
    const after = readJson(layoutsPath);
    const ids = after.layouts.map((l) => l.id);
    expect(ids).toContain('deep-work');
    expect(ids).toContain('agent-watch');
    expect(after.layouts.find((l) => l.id === 'health').name).toBe('Health (custom)');
  });

  it('preserves user layouts untouched', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'my-custom',
      layouts: [
        { id: 'default', name: 'Everything', builtIn: true, widgets: ['quick-task'], grid: [] },
        { id: 'my-custom', name: 'My Custom', builtIn: false, widgets: ['cos'], grid: [{ id: 'cos', x: 0, y: 0, w: 12, h: 4 }] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(3);
    const after = readJson(layoutsPath);
    expect(after.activeLayoutId).toBe('my-custom');
    const custom = after.layouts.find((l) => l.id === 'my-custom');
    expect(custom.widgets).toEqual(['cos']);
    expect(custom.grid).toEqual([{ id: 'cos', x: 0, y: 0, w: 12, h: 4 }]);
  });

  it('survives an unreadable JSON file', async () => {
    writeFileSync(layoutsPath, 'not json');
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(result.reason).toBe('unreadable');
  });

  it('does nothing when the file has no layouts array', async () => {
    writeJson(layoutsPath, { activeLayoutId: 'default' });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(result.reason).toBe('no-layouts-array');
  });
});
