import { describe, it, expect } from 'vitest';
import { getProcessStats, checkProcessRunning } from './processStats.js';

describe('cos-runner processStats', () => {
  describe('getProcessStats PID validation', () => {
    it('rejects non-numeric PIDs without spawning a process', async () => {
      const r = await getProcessStats('; rm -rf /');
      expect(r).toEqual({ active: false, pid: '; rm -rf /', cpu: 0, memoryKb: 0, state: 'invalid' });
    });
    it('rejects zero and negative PIDs', async () => {
      expect((await getProcessStats(0)).state).toBe('invalid');
      expect((await getProcessStats(-5)).state).toBe('invalid');
    });
    it('reports the current process as active', async () => {
      const r = await getProcessStats(process.pid);
      expect(r.active).toBe(true);
      expect(r.pid).toBe(process.pid);
    });
    it('reports a non-existent PID as dead', async () => {
      // 2^31-1 is effectively never a live PID on these platforms
      const r = await getProcessStats(2147483646);
      expect(r.active).toBe(false);
      expect(r.state).toBe('dead');
    });
  });

  describe('checkProcessRunning', () => {
    it('returns false for invalid PIDs', async () => {
      expect(await checkProcessRunning('bad')).toBe(false);
      expect(await checkProcessRunning(0)).toBe(false);
    });
    it('returns true for the current process', async () => {
      expect(await checkProcessRunning(process.pid)).toBe(true);
    });
  });
});
