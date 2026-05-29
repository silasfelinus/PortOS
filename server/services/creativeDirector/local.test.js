import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks declared before importing the module under test.
const mockReadJSONFile = vi.fn();
const mockAtomicWrite = vi.fn();
const mockEnsureDir = vi.fn();

vi.mock('../../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: { data: '/fake/data' },
  readJSONFile: (...args) => mockReadJSONFile(...args),
  atomicWrite: (...args) => mockAtomicWrite(...args),
  ensureDir: (...args) => mockEnsureDir(...args),
}));

vi.mock('../mediaCollections.js', () => ({
  createCollection: vi.fn(async () => ({ id: 'col-1' })),
}));

const { setTreatment, recordRun, trimRuns } = await import('./local.js');

const VALID_TREATMENT = {
  logline: 'A cat finds a hat.',
  synopsis: 'Then puts it on.',
  scenes: [
    {
      sceneId: 'scene-1',
      order: 0,
      intent: 'Cat enters frame',
      prompt: 'A cat walks into view',
      durationSeconds: 4,
    },
  ],
};

beforeEach(() => {
  mockReadJSONFile.mockReset();
  mockAtomicWrite.mockReset().mockResolvedValue(undefined);
  mockEnsureDir.mockReset().mockResolvedValue(undefined);
});

describe('setTreatment — status preservation', () => {
  it('preserves paused status when agent PATCHes treatment on a paused project', async () => {
    mockReadJSONFile.mockResolvedValue([{ id: 'cd-1', status: 'paused', name: 'Test' }]);
    const result = await setTreatment('cd-1', VALID_TREATMENT);
    expect(result.status).toBe('paused');
    const saved = mockAtomicWrite.mock.calls[0][1];
    expect(saved[0].status).toBe('paused');
  });

  it('preserves failed status when agent PATCHes treatment on a failed project', async () => {
    mockReadJSONFile.mockResolvedValue([{ id: 'cd-1', status: 'failed', name: 'Test' }]);
    const result = await setTreatment('cd-1', VALID_TREATMENT);
    expect(result.status).toBe('failed');
    const saved = mockAtomicWrite.mock.calls[0][1];
    expect(saved[0].status).toBe('failed');
  });

  it('flips planning → rendering when agent PATCHes treatment on a planning project', async () => {
    mockReadJSONFile.mockResolvedValue([{ id: 'cd-1', status: 'planning', name: 'Test' }]);
    const result = await setTreatment('cd-1', VALID_TREATMENT);
    expect(result.status).toBe('rendering');
    const saved = mockAtomicWrite.mock.calls[0][1];
    expect(saved[0].status).toBe('rendering');
  });

  it('flips draft → rendering when agent PATCHes treatment on a draft project', async () => {
    mockReadJSONFile.mockResolvedValue([{ id: 'cd-1', status: 'draft', name: 'Test' }]);
    const result = await setTreatment('cd-1', VALID_TREATMENT);
    expect(result.status).toBe('rendering');
  });
});

describe('trimRuns — bound runs[] growth', () => {
  it('passes through arrays under the cap unchanged', () => {
    const runs = Array.from({ length: 50 }, (_, i) => ({ runId: `r-${i}`, status: 'completed' }));
    expect(trimRuns(runs)).toBe(runs);
  });

  it('keeps the most recent terminal runs when over the cap', () => {
    const runs = Array.from({ length: 250 }, (_, i) => ({ runId: `r-${i}`, status: 'completed' }));
    const trimmed = trimRuns(runs);
    expect(trimmed).toHaveLength(200);
    expect(trimmed[0].runId).toBe('r-50');
    expect(trimmed[199].runId).toBe('r-249');
  });

  it('preserves every in-flight run even when total exceeds the cap', () => {
    const terminal = Array.from({ length: 300 }, (_, i) => ({ runId: `done-${i}`, status: 'completed' }));
    const inflight = [
      { runId: 'live-1', status: 'running', kind: 'evaluate', sceneId: 'scene-1' },
      { runId: 'live-2', status: 'queued', kind: 'treatment' },
    ];
    const trimmed = trimRuns([...terminal, ...inflight]);
    expect(trimmed).toHaveLength(200);
    expect(trimmed.filter((r) => r.runId.startsWith('live-'))).toHaveLength(2);
    expect(trimmed.filter((r) => r.status === 'completed')).toHaveLength(198);
  });

  it('treats unknown non-terminal statuses as in-flight (orphan/wedge detection load-bearing)', () => {
    const runs = [
      { runId: 'mystery', status: 'evaluating' },
      ...Array.from({ length: 300 }, (_, i) => ({ runId: `done-${i}`, status: 'failed' })),
    ];
    const trimmed = trimRuns(runs);
    expect(trimmed.find((r) => r.runId === 'mystery')).toBeTruthy();
  });

  it('tolerates non-array / nullish input', () => {
    expect(trimRuns(null)).toEqual([]);
    expect(trimRuns(undefined)).toEqual([]);
  });
});

describe('recordRun — applies trim on append', () => {
  it('caps persisted runs[] when recordRun would otherwise grow it past the cap', async () => {
    const existing = Array.from({ length: 200 }, (_, i) => ({ runId: `r-${i}`, status: 'completed', startedAt: new Date(2026, 0, 1, 0, i).toISOString() }));
    mockReadJSONFile.mockResolvedValue([{ id: 'cd-1', status: 'rendering', name: 'Test', runs: existing }]);
    await recordRun('cd-1', { agentId: 'agent-x', kind: 'evaluate', sceneId: 'scene-1', status: 'running' });
    const saved = mockAtomicWrite.mock.calls[0][1];
    expect(saved[0].runs).toHaveLength(200);
    // The new in-flight run must survive trim, even though it pushed total past the cap.
    expect(saved[0].runs.find((r) => r.kind === 'evaluate' && r.sceneId === 'scene-1' && r.status === 'running')).toBeTruthy();
  });

  it('does not cap when total is still under the limit', async () => {
    const existing = Array.from({ length: 10 }, (_, i) => ({ runId: `r-${i}`, status: 'completed' }));
    mockReadJSONFile.mockResolvedValue([{ id: 'cd-1', status: 'rendering', name: 'Test', runs: existing }]);
    await recordRun('cd-1', { agentId: 'agent-x', kind: 'evaluate', status: 'running' });
    const saved = mockAtomicWrite.mock.calls[0][1];
    expect(saved[0].runs).toHaveLength(11);
  });
});
