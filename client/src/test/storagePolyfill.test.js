import { describe, it, expect, afterEach, vi } from 'vitest';
import { createMemoryStorage, storageWorks, ensureStorage } from './storagePolyfill.js';

describe('storagePolyfill', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('createMemoryStorage', () => {
    it('implements the Storage contract (set/get/remove/clear/length/key)', () => {
      const s = createMemoryStorage();
      expect(s.length).toBe(0);
      expect(s.getItem('missing')).toBe(null);

      s.setItem('a', '1');
      s.setItem('b', '2');
      expect(s.getItem('a')).toBe('1');
      expect(s.length).toBe(2);
      expect([s.key(0), s.key(1)]).toEqual(['a', 'b']);
      expect(s.key(99)).toBe(null);

      s.removeItem('a');
      expect(s.getItem('a')).toBe(null);
      expect(s.length).toBe(1);

      s.clear();
      expect(s.length).toBe(0);
    });

    it('coerces keys and values to strings, matching the DOM Storage spec', () => {
      const s = createMemoryStorage();
      s.setItem(1, 2);
      expect(s.getItem('1')).toBe('2');
      expect(s.getItem(1)).toBe('2');
    });
  });

  describe('storageWorks', () => {
    it('returns false for null/undefined', () => {
      expect(storageWorks(null)).toBe(false);
      expect(storageWorks(undefined)).toBe(false);
    });

    it('returns true for a functioning Storage', () => {
      expect(storageWorks(createMemoryStorage())).toBe(true);
    });

    it('returns false for a Storage whose setItem throws (quota/private mode)', () => {
      const broken = { setItem() { throw new Error('QuotaExceededError'); }, getItem() {}, removeItem() {} };
      expect(storageWorks(broken)).toBe(false);
    });

    it('returns false for a Storage that drops what it stores', () => {
      const lossy = { setItem() {}, getItem() { return null; }, removeItem() {} };
      expect(storageWorks(lossy)).toBe(false);
    });
  });

  describe('ensureStorage', () => {
    it('installs a working Storage when the environment lacks one (the #1438 failure mode)', () => {
      const root = {};
      // Reproduces "Cannot read properties of undefined (reading clear)": no Storage present.
      expect(root.localStorage).toBeUndefined();
      const installed = ensureStorage('localStorage', root);
      expect(installed).toBe(true);
      expect(storageWorks(root.localStorage)).toBe(true);
      root.localStorage.setItem('k', 'v');
      expect(root.localStorage.getItem('k')).toBe('v');
    });

    it('leaves a working Storage untouched (idempotent, no clobber)', () => {
      const existing = createMemoryStorage();
      existing.setItem('keep', 'me');
      const root = { localStorage: existing };
      const installed = ensureStorage('localStorage', root);
      expect(installed).toBe(false);
      expect(root.localStorage).toBe(existing);
      expect(root.localStorage.getItem('keep')).toBe('me');
    });

    it('replaces a broken Storage with a working shim', () => {
      const root = { localStorage: { setItem() { throw new Error('boom'); }, getItem() {}, removeItem() {} } };
      const installed = ensureStorage('localStorage', root);
      expect(installed).toBe(true);
      expect(storageWorks(root.localStorage)).toBe(true);
    });
  });

  it('the active test environment has a working localStorage (setup.js installed it)', () => {
    expect(storageWorks(globalThis.localStorage)).toBe(true);
    expect(storageWorks(globalThis.sessionStorage)).toBe(true);
    // And the bare global resolves to the same instance window exposes.
    expect(localStorage).toBe(window.localStorage);
  });
});
