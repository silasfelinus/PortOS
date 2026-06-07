/**
 * Pure record-transform tests for the Creative Director storage logic shared by
 * the file + Postgres backends. No I/O — these lock the mutation semantics the
 * two backends MUST agree on (status preservation, scene patching, runs[] cap).
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_PERSISTED_RUNS,
  trimRuns,
  buildProjectRecord,
  applyProjectPatch,
  applyTreatment,
  applySceneUpdate,
  appendRun,
  applyRunUpdate,
} from './projectsLogic.js';

const VALID_TREATMENT = {
  logline: 'A cat finds a hat.',
  synopsis: 'Then puts it on.',
  scenes: [{ sceneId: 'scene-1', order: 0, intent: 'Cat enters', prompt: 'A cat walks in', durationSeconds: 4 }],
};

describe('buildProjectRecord', () => {
  it('produces a draft project with the supplied collection id and null pointers', () => {
    const p = buildProjectRecord(
      { name: 'X', aspectRatio: '1:1', quality: 'draft', modelId: 'm', targetDurationSeconds: 9 },
      { id: 'cd-1', now: '2026-06-07T00:00:00.000Z', collectionId: 'col-1' },
    );
    expect(p).toMatchObject({
      id: 'cd-1', name: 'X', status: 'draft', collectionId: 'col-1',
      timelineProjectId: null, finalVideoId: null, treatment: null, runs: [],
    });
  });
});

describe('applyProjectPatch', () => {
  it('merges the patch and bumps updatedAt', () => {
    const next = applyProjectPatch({ id: 'cd-1', status: 'draft', updatedAt: 'old' }, { status: 'planning' });
    expect(next.status).toBe('planning');
    expect(next.updatedAt).not.toBe('old');
  });
  it('throws on an invalid status', () => {
    expect(() => applyProjectPatch({ id: 'cd-1' }, { status: 'bogus' })).toThrow(/Invalid status/);
  });
});

describe('applyTreatment — status preservation', () => {
  it('preserves paused status', () => {
    const next = applyTreatment({ id: 'cd-1', status: 'paused' }, VALID_TREATMENT);
    expect(next.status).toBe('paused');
    expect(next.treatment.scenes[0].status).toBe('pending');
  });
  it('preserves failed status', () => {
    expect(applyTreatment({ id: 'cd-1', status: 'failed' }, VALID_TREATMENT).status).toBe('failed');
  });
  it('flips planning → rendering', () => {
    expect(applyTreatment({ id: 'cd-1', status: 'planning' }, VALID_TREATMENT).status).toBe('rendering');
  });
  it('initializes scene runtime fields', () => {
    const next = applyTreatment({ id: 'cd-1', status: 'planning' }, VALID_TREATMENT);
    expect(next.treatment.scenes[0]).toMatchObject({ status: 'pending', retryCount: 0, renderedJobId: null, evaluation: null });
  });
  it('throws on an invalid treatment', () => {
    expect(() => applyTreatment({ id: 'cd-1', status: 'planning' }, { logline: '', synopsis: '', scenes: [] })).toThrow(/Treatment validation failed/);
  });
});

describe('applySceneUpdate', () => {
  const base = () => ({ id: 'cd-1', status: 'rendering', treatment: { logline: 'l', synopsis: 's', scenes: [{ sceneId: 'scene-1', order: 0, status: 'pending' }] } });
  it('patches the matching scene and returns it', () => {
    const { project, updated } = applySceneUpdate(base(), 'scene-1', { status: 'rendering', renderedJobId: 'job-1' });
    expect(updated).toMatchObject({ status: 'rendering', renderedJobId: 'job-1' });
    expect(project.treatment.scenes[0].renderedJobId).toBe('job-1');
  });
  it('does not mutate the input project (immutable update)', () => {
    const input = base();
    applySceneUpdate(input, 'scene-1', { status: 'accepted' });
    expect(input.treatment.scenes[0].status).toBe('pending');
  });
  it('throws when the project has no treatment', () => {
    expect(() => applySceneUpdate({ id: 'cd-1' }, 'scene-1', {})).toThrow(/no treatment/);
  });
  it('throws when the scene id is unknown', () => {
    expect(() => applySceneUpdate(base(), 'scene-9', {})).toThrow(/Scene not found/);
  });
});

describe('appendRun / applyRunUpdate', () => {
  it('appends a run with a generated runId + startedAt', () => {
    const { project, run } = appendRun({ id: 'cd-1', runs: [] }, { kind: 'treatment', status: 'running' });
    expect(run.runId).toBeTruthy();
    expect(run.startedAt).toBeTruthy();
    expect(project.runs).toHaveLength(1);
  });
  it('honors a supplied runId', () => {
    const { run } = appendRun({ id: 'cd-1', runs: [] }, { runId: 'fixed', kind: 'evaluate', status: 'running' });
    expect(run.runId).toBe('fixed');
  });
  it('patches an existing run by id', () => {
    const start = appendRun({ id: 'cd-1', runs: [] }, { runId: 'r1', status: 'running' });
    const { project, updated } = applyRunUpdate(start.project, 'r1', { status: 'completed' });
    expect(updated.status).toBe('completed');
    expect(project.runs[0].status).toBe('completed');
  });
  it('returns updated=null and the unchanged project for an unknown runId', () => {
    const input = { id: 'cd-1', runs: [{ runId: 'r1', status: 'running' }] };
    const { project, updated } = applyRunUpdate(input, 'nope', { status: 'completed' });
    expect(updated).toBeNull();
    expect(project).toBe(input);
  });
});

describe('trimRuns', () => {
  it('is a no-op under the cap', () => {
    const runs = [{ runId: 'a', status: 'completed' }];
    expect(trimRuns(runs)).toBe(runs);
  });
  it('caps terminal runs but keeps every in-flight run', () => {
    const terminal = Array.from({ length: MAX_PERSISTED_RUNS + 50 }, (_, i) => ({ runId: `t${i}`, status: 'completed' }));
    const inflight = [{ runId: 'live', status: 'running' }];
    const trimmed = trimRuns([...terminal, ...inflight]);
    expect(trimmed.length).toBe(MAX_PERSISTED_RUNS);
    expect(trimmed.some((r) => r.runId === 'live')).toBe(true);
  });
  it('preserves chronological order after trimming', () => {
    const runs = Array.from({ length: MAX_PERSISTED_RUNS + 10 }, (_, i) => ({ runId: `t${i}`, status: 'completed' }));
    const trimmed = trimRuns(runs);
    // The most-recent MAX runs, still in ascending order.
    expect(trimmed[0].runId).toBe('t10');
    expect(trimmed[trimmed.length - 1].runId).toBe(`t${runs.length - 1}`);
  });
  it('returns [] for non-array input', () => {
    expect(trimRuns(undefined)).toEqual([]);
    expect(trimRuns(null)).toEqual([]);
  });
});
