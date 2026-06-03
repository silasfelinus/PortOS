import { describe, it, expect } from 'vitest';
import {
  MONUMENTS,
  STALL_DAYS,
  daysSinceLastProgress,
  effectiveGoalStatus,
  buildCompleteness,
  placeMonument,
  computeGoalMonuments,
} from './cityGoalMonuments';

const NOW = Date.parse('2026-06-03T00:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();

const goal = (over = {}) => ({
  id: 'goal-1',
  title: 'Run a marathon',
  status: 'active',
  progress: 50,
  createdAt: daysAgo(10),
  progressHistory: [{ date: daysAgo(5), value: 50 }],
  ...over,
});

describe('daysSinceLastProgress', () => {
  it('measures from the most recent progressHistory entry', () => {
    const g = goal({ progressHistory: [{ date: daysAgo(3), value: 20 }, { date: daysAgo(10), value: 5 }] });
    expect(daysSinceLastProgress(g, NOW)).toBeCloseTo(3, 1);
  });

  it('falls back to createdAt when no history', () => {
    const g = goal({ progressHistory: [], createdAt: daysAgo(7) });
    expect(daysSinceLastProgress(g, NOW)).toBeCloseTo(7, 1);
  });

  it('returns null when there is no usable date', () => {
    expect(daysSinceLastProgress({ progressHistory: [] }, NOW)).toBeNull();
    expect(daysSinceLastProgress(null, NOW)).toBeNull();
    expect(daysSinceLastProgress({ progressHistory: [{ date: 'nope' }] }, NOW)).toBeNull();
  });
});

describe('effectiveGoalStatus', () => {
  it('maps stored completed/abandoned through unchanged', () => {
    expect(effectiveGoalStatus(goal({ status: 'completed' }), NOW)).toBe('completed');
    expect(effectiveGoalStatus(goal({ status: 'abandoned' }), NOW)).toBe('abandoned');
  });

  it('treats progress >= 100 as completed even if stored active', () => {
    expect(effectiveGoalStatus(goal({ status: 'active', progress: 100 }), NOW)).toBe('completed');
  });

  it('derives stalled for an active goal with no progress past the threshold', () => {
    const stale = goal({ progressHistory: [{ date: daysAgo(STALL_DAYS + 5), value: 50 }] });
    expect(effectiveGoalStatus(stale, NOW)).toBe('stalled');
  });

  it('keeps a recently-progressed active goal active', () => {
    const fresh = goal({ progressHistory: [{ date: daysAgo(2), value: 50 }] });
    expect(effectiveGoalStatus(fresh, NOW)).toBe('active');
  });

  it('defaults to active for an unknown/missing status', () => {
    expect(effectiveGoalStatus({ progressHistory: [{ date: daysAgo(1) }] }, NOW)).toBe('active');
  });
});

describe('buildCompleteness', () => {
  it('is always 1 for a completed monument', () => {
    expect(buildCompleteness(goal({ progress: 12 }), 'completed')).toBe(1);
  });

  it('tracks progress/100 for active, clamped', () => {
    expect(buildCompleteness(goal({ progress: 40 }), 'active')).toBeCloseTo(0.4);
    expect(buildCompleteness(goal({ progress: 250 }), 'active')).toBe(1);
    expect(buildCompleteness(goal({ progress: -5 }), 'active')).toBe(0);
  });

  it('treats missing progress as 0 (a floor stub), not a crash', () => {
    expect(buildCompleteness({}, 'active')).toBe(0);
  });
});

describe('placeMonument', () => {
  it('maps status to color/opacity/dim/built', () => {
    const completed = placeMonument(goal({ status: 'completed' }), 0, 1, NOW);
    expect(completed.built).toBe(true);
    expect(completed.dim).toBe(false);
    expect(completed.completeness).toBe(1);
    expect(completed.height).toBeCloseTo(MONUMENTS.fullHeight);

    const abandoned = placeMonument(goal({ status: 'abandoned' }), 0, 1, NOW);
    expect(abandoned.dim).toBe(true);
    expect(abandoned.built).toBe(false);
    expect(abandoned.opacity).toBeLessThan(completed.opacity);
  });

  it('progress drives height between min and full', () => {
    const half = placeMonument(goal({ status: 'active', progress: 50, progressHistory: [{ date: daysAgo(1) }] }), 0, 1, NOW);
    expect(half.height).toBeGreaterThan(MONUMENTS.minHeight);
    expect(half.height).toBeLessThan(MONUMENTS.fullHeight);
  });

  it('centers a single monument on base.x', () => {
    const only = placeMonument(goal(), 0, 1, NOW);
    expect(only.position[0]).toBeCloseTo(MONUMENTS.base[0]);
    expect(only.position[2]).toBe(MONUMENTS.z);
  });

  it('lays out a row centered around base.x with consistent spacing', () => {
    const a = placeMonument(goal(), 0, 3, NOW);
    const b = placeMonument(goal(), 1, 3, NOW);
    const c = placeMonument(goal(), 2, 3, NOW);
    expect(b.position[0]).toBeCloseTo(MONUMENTS.base[0]); // middle slot on center
    expect(b.position[0] - a.position[0]).toBeCloseTo(MONUMENTS.spacing);
    expect(c.position[0] - b.position[0]).toBeCloseTo(MONUMENTS.spacing);
  });

  it('falls back to a title and id without crashing', () => {
    const m = placeMonument({}, 2, 5, NOW);
    expect(m.title).toBe('Untitled Goal');
    expect(m.id).toBe('goal-2');
  });
});

describe('computeGoalMonuments', () => {
  it('handles missing / non-array input as an empty district', () => {
    for (const bad of [null, undefined, 'nope', 42, {}]) {
      const vm = computeGoalMonuments(bad, NOW);
      expect(vm.monuments).toEqual([]);
      expect(vm.overflow).toBeNull();
      expect(vm.hasData).toBe(false);
      expect(vm.total).toBe(0);
    }
  });

  it('places one monument per goal up to the cap', () => {
    const goals = Array.from({ length: 4 }, (_, i) => goal({ id: `g-${i}` }));
    const vm = computeGoalMonuments(goals, NOW);
    expect(vm.monuments).toHaveLength(4);
    expect(vm.overflow).toBeNull();
    expect(vm.total).toBe(4);
    expect(vm.hasData).toBe(true);
  });

  it('caps at maxMonuments and folds the rest into an overflow marker', () => {
    const goals = Array.from({ length: MONUMENTS.maxMonuments + 3 }, (_, i) => goal({ id: `g-${i}` }));
    const vm = computeGoalMonuments(goals, NOW);
    expect(vm.monuments).toHaveLength(MONUMENTS.maxMonuments);
    expect(vm.overflow).not.toBeNull();
    expect(vm.overflow.count).toBe(3);
    expect(vm.overflow.position[2]).toBe(MONUMENTS.z);
    expect(vm.total).toBe(MONUMENTS.maxMonuments + 3);
  });

  it('orders completed monuments before active before stalled before abandoned', () => {
    const goals = [
      goal({ id: 'ab', status: 'abandoned' }),
      goal({ id: 'co', status: 'completed' }),
      goal({ id: 'st', progressHistory: [{ date: daysAgo(STALL_DAYS + 1) }] }),
      goal({ id: 'ac', progressHistory: [{ date: daysAgo(1) }] }),
    ];
    const vm = computeGoalMonuments(goals, NOW);
    expect(vm.monuments.map((m) => m.status)).toEqual(['completed', 'active', 'stalled', 'abandoned']);
  });

  it('reports completed / active counts', () => {
    const goals = [
      goal({ id: 'a', status: 'completed' }),
      goal({ id: 'b', status: 'completed' }),
      goal({ id: 'c', progressHistory: [{ date: daysAgo(1) }] }),
    ];
    const vm = computeGoalMonuments(goals, NOW);
    expect(vm.completedCount).toBe(2);
    expect(vm.activeCount).toBe(1);
  });

  it('skips null / non-object entries without crashing', () => {
    const vm = computeGoalMonuments([null, goal({ id: 'ok' }), 'bad', 42], NOW);
    expect(vm.monuments).toHaveLength(1);
    expect(vm.monuments[0].id).toBe('ok');
  });
});
