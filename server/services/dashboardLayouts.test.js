import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// The service captures STATE_PATH at module-load time, so the scratch dir
// must exist before the import resolves. vi.hoisted runs before any imports
// (including the mocked module), so we mint the dir there and just clear
// its contents between tests.
const scratch = vi.hoisted(() => {
  const { mkdtempSync: mk, mkdirSync: mkd } = require('fs');
  const { tmpdir: tmp } = require('os');
  const { join: j } = require('path');
  const dir = mk(j(tmp(), 'dashboard-svc-'));
  mkd(j(dir, 'data'), { recursive: true });
  return { dir };
});
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return {
    ...actual,
    PATHS: { ...actual.PATHS, data: join(scratch.dir, 'data') },
  };
});

import * as svc from './dashboardLayouts.js';

const STATE_FILE = join(scratch.dir, 'data', 'dashboard-layouts.json');
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));

describe('dashboardLayouts service', () => {
  beforeEach(() => {
    // Each test starts with a clean state file. The dir itself is reused.
    if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
  });

  afterEach(() => {});

  describe('saveLayout — activateWindow merge behavior', () => {
    const stateFile = () => STATE_FILE;

    it('preserves activateWindow when the caller omits the key', async () => {
      writeJson(stateFile(), {
        activeLayoutId: 'morning',
        layouts: [
          { id: 'morning', name: 'Morning', builtIn: false, widgets: ['cos'], grid: [], activateWindow: { start: '06:00', end: '11:00' } },
        ],
      });
      // Vanilla edit: rename only. The caller doesn't know about activateWindow.
      await svc.saveLayout({ id: 'morning', name: 'Morning v2', widgets: ['cos'], grid: [] });
      const after = await svc.getState();
      const found = after.layouts.find((l) => l.id === 'morning');
      expect(found.name).toBe('Morning v2');
      expect(found.activateWindow).toEqual({ start: '06:00', end: '11:00' });
    });

    it('clears activateWindow when the caller sends null', async () => {
      writeJson(stateFile(), {
        activeLayoutId: 'morning',
        layouts: [
          { id: 'morning', name: 'Morning', builtIn: false, widgets: ['cos'], grid: [], activateWindow: { start: '06:00', end: '11:00' } },
        ],
      });
      await svc.saveLayout({ id: 'morning', name: 'Morning', widgets: ['cos'], grid: [], activateWindow: null });
      const after = await svc.getState();
      const found = after.layouts.find((l) => l.id === 'morning');
      expect(found.activateWindow).toBe(null);
    });

    it('sets activateWindow when the caller provides one', async () => {
      writeJson(stateFile(), {
        activeLayoutId: 'morning',
        layouts: [
          { id: 'morning', name: 'Morning', builtIn: false, widgets: ['cos'], grid: [] },
        ],
      });
      await svc.saveLayout({
        id: 'morning',
        name: 'Morning',
        widgets: ['cos'],
        grid: [],
        activateWindow: { start: '07:00', end: '10:00' },
      });
      const after = await svc.getState();
      const found = after.layouts.find((l) => l.id === 'morning');
      expect(found.activateWindow).toEqual({ start: '07:00', end: '10:00' });
    });

    it('drops malformed activateWindow on read', async () => {
      // Hand-edit produces garbage shapes — sanitizer must null them out.
      writeJson(stateFile(), {
        activeLayoutId: 'busted',
        layouts: [
          { id: 'busted', name: 'Busted', builtIn: false, widgets: ['cos'], grid: [], activateWindow: { start: '25:99', end: '11:00' } },
        ],
      });
      const after = await svc.getState();
      const found = after.layouts.find((l) => l.id === 'busted');
      expect(found.activateWindow).toBe(null);
    });
  });

  describe('saveLayout — surfaces builtIn correctly for new ids', () => {
    it('persists builtIn=true for a built-in id (deep-work) when seeded through saveLayout', async () => {
      // A fresh state file is fine — getState() will seed defaults, then we save.
      await svc.saveLayout({ id: 'deep-work', name: 'Deep Work renamed', widgets: ['cos'], grid: [] });
      const after = await svc.getState();
      const found = after.layouts.find((l) => l.id === 'deep-work');
      expect(found?.builtIn).toBe(true);
    });
  });

  describe('built-in layouts ship with the three new intent variants', () => {
    it('seeds deep-work, health, agent-watch on first read', async () => {
      const state = await svc.getState();
      const ids = state.layouts.map((l) => l.id);
      expect(ids).toContain('deep-work');
      expect(ids).toContain('health');
      expect(ids).toContain('agent-watch');
      // The new built-ins should be flagged so the editor refuses to delete them.
      expect(state.layouts.find((l) => l.id === 'deep-work').builtIn).toBe(true);
    });

    it('does not write the state file on first read (defaults are in-memory)', async () => {
      // getState() doesn't write — only saveLayout / setActive / delete do.
      // Verify by reading getState() and confirming no file got written.
      await svc.getState();
      expect(existsSync(STATE_FILE)).toBe(false);
    });
  });
});
