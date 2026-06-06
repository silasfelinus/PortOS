import { describe, it, expect } from 'vitest';
import { DOMAIN_IDS } from './domainAutonomy.js';
import {
  BUDGET_LIMIT_FIELDS,
  DEFAULT_DOMAIN_BUDGET,
  normalizeBudgetLimit,
  normalizeDomainBudgets,
  getDomainBudget,
  hasBudget,
  evaluateBudget
} from './domainBudgets.js';

describe('domainBudgets constants', () => {
  it('exposes the two measurable cap dimensions', () => {
    expect(BUDGET_LIMIT_FIELDS).toEqual(['maxActionsPerDay', 'maxMinutesPerDay']);
  });

  it('defaults every dimension to unlimited (null)', () => {
    expect(DEFAULT_DOMAIN_BUDGET).toEqual({ maxActionsPerDay: null, maxMinutesPerDay: null });
  });
});

describe('normalizeBudgetLimit', () => {
  it('keeps positive integers, flooring fractions', () => {
    expect(normalizeBudgetLimit(5)).toBe(5);
    expect(normalizeBudgetLimit(5.9)).toBe(5);
    expect(normalizeBudgetLimit('12')).toBe(12);
  });

  it('treats zero / negatives / garbage / Infinity as unlimited (null)', () => {
    for (const v of [0, -1, -100, NaN, Infinity, -Infinity, null, undefined, '', 'nope', {}, []]) {
      expect(normalizeBudgetLimit(v)).toBeNull();
    }
  });
});

describe('normalizeDomainBudgets', () => {
  it('fills every domain with an unlimited budget for empty/garbage input', () => {
    for (const raw of [undefined, null, {}, [], 'nope', 42]) {
      const out = normalizeDomainBudgets(raw);
      expect(Object.keys(out).sort()).toEqual([...DOMAIN_IDS].sort());
      for (const id of DOMAIN_IDS) {
        expect(out[id]).toEqual({ maxActionsPerDay: null, maxMinutesPerDay: null });
      }
    }
  });

  it('keeps valid caps, coerces invalid ones, and drops unknown domains', () => {
    const out = normalizeDomainBudgets({
      brain: { maxActionsPerDay: 20, maxMinutesPerDay: 0 },
      cos: { maxActionsPerDay: -3, maxMinutesPerDay: 90 },
      bogus: { maxActionsPerDay: 99 }
    });
    expect(out.brain).toEqual({ maxActionsPerDay: 20, maxMinutesPerDay: null });
    expect(out.cos).toEqual({ maxActionsPerDay: null, maxMinutesPerDay: 90 });
    expect(out.memory).toEqual({ maxActionsPerDay: null, maxMinutesPerDay: null });
    expect(out.bogus).toBeUndefined();
  });

  it('tolerates a non-object per-domain value', () => {
    const out = normalizeDomainBudgets({ brain: 'nope', memory: 7 });
    expect(out.brain).toEqual({ maxActionsPerDay: null, maxMinutesPerDay: null });
    expect(out.memory).toEqual({ maxActionsPerDay: null, maxMinutesPerDay: null });
  });
});

describe('getDomainBudget', () => {
  it('reads a domain budget from config, tolerating absent config', () => {
    expect(getDomainBudget(undefined, 'brain')).toEqual({ maxActionsPerDay: null, maxMinutesPerDay: null });
    expect(getDomainBudget({}, 'cos')).toEqual({ maxActionsPerDay: null, maxMinutesPerDay: null });
    expect(getDomainBudget({ domainBudgets: { cos: { maxActionsPerDay: 10 } } }, 'cos'))
      .toEqual({ maxActionsPerDay: 10, maxMinutesPerDay: null });
  });

  it('coerces invalid stored caps to unlimited', () => {
    expect(getDomainBudget({ domainBudgets: { cos: { maxActionsPerDay: -5, maxMinutesPerDay: 'x' } } }, 'cos'))
      .toEqual({ maxActionsPerDay: null, maxMinutesPerDay: null });
  });
});

describe('hasBudget', () => {
  it('is false for an unlimited budget and true when any cap is set', () => {
    expect(hasBudget(DEFAULT_DOMAIN_BUDGET)).toBe(false);
    expect(hasBudget(undefined)).toBe(false);
    expect(hasBudget({ maxActionsPerDay: 1, maxMinutesPerDay: null })).toBe(true);
    expect(hasBudget({ maxActionsPerDay: null, maxMinutesPerDay: 1 })).toBe(true);
  });
});

describe('evaluateBudget', () => {
  it('is always within budget when unlimited', () => {
    const r = evaluateBudget(DEFAULT_DOMAIN_BUDGET, { actions: 9999, ms: 9_999_999 });
    expect(r).toEqual({ withinBudget: true, exceeded: null });
  });

  it('exceeds the actions cap at exactly N (>=), not N-1', () => {
    const budget = { maxActionsPerDay: 3, maxMinutesPerDay: null };
    expect(evaluateBudget(budget, { actions: 2 })).toEqual({ withinBudget: true, exceeded: null });
    expect(evaluateBudget(budget, { actions: 3 })).toEqual({ withinBudget: false, exceeded: 'actions' });
    expect(evaluateBudget(budget, { actions: 4 })).toEqual({ withinBudget: false, exceeded: 'actions' });
  });

  it('exceeds the minutes cap when accumulated ms reaches the cap', () => {
    const budget = { maxActionsPerDay: null, maxMinutesPerDay: 10 };
    expect(evaluateBudget(budget, { ms: 9 * 60_000 })).toEqual({ withinBudget: true, exceeded: null });
    expect(evaluateBudget(budget, { ms: 10 * 60_000 })).toEqual({ withinBudget: false, exceeded: 'minutes' });
  });

  it('reports actions before minutes when both are exceeded', () => {
    const budget = { maxActionsPerDay: 1, maxMinutesPerDay: 1 };
    expect(evaluateBudget(budget, { actions: 5, ms: 5 * 60_000 }))
      .toEqual({ withinBudget: false, exceeded: 'actions' });
  });

  it('treats missing usage fields as zero', () => {
    const budget = { maxActionsPerDay: 1, maxMinutesPerDay: 1 };
    expect(evaluateBudget(budget, {})).toEqual({ withinBudget: true, exceeded: null });
    expect(evaluateBudget(budget, undefined)).toEqual({ withinBudget: true, exceeded: null });
  });
});
