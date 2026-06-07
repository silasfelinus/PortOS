import { describe, it, expect } from 'vitest';
import {
  RHYTHM_SHAPES,
  DIRGE_RHYTHM_SHAPES,
  VOICE_LAYERS,
  LEARNING_STEPS,
  NOTATION_HELP,
  SOLFEGE_DEGREES,
  solfegeForDegree,
  HARMONY_PARTS,
  DERIVABLE_HARMONY_PARTS,
  harmonyPartLabel,
  harmonyPartOrder,
} from './songCraft.js';

describe('songCraft reference data', () => {
  it('every rhythm shape carries id, label, bpm band, feel, count and a boolean dirge flag', () => {
    const ids = new Set();
    for (const s of RHYTHM_SHAPES) {
      expect(typeof s.id).toBe('string');
      expect(s.id.length).toBeGreaterThan(0);
      expect(ids.has(s.id)).toBe(false);
      ids.add(s.id);
      expect(typeof s.label).toBe('string');
      expect(typeof s.feel).toBe('string');
      expect(typeof s.count).toBe('string');
      expect(typeof s.bpm.label).toBe('string');
      expect(typeof s.dirge).toBe('boolean');
    }
  });

  it('exposes the dirge family as a subset of all rhythm shapes', () => {
    expect(DIRGE_RHYTHM_SHAPES.length).toBeGreaterThan(0);
    expect(DIRGE_RHYTHM_SHAPES.length).toBeLessThan(RHYTHM_SHAPES.length);
    for (const s of DIRGE_RHYTHM_SHAPES) {
      expect(s.dirge).toBe(true);
    }
    // The slow 4/4 ballad ("500 Miles") must be a dirge-family shape.
    expect(DIRGE_RHYTHM_SHAPES.some((s) => s.id === 'slow-4-4')).toBe(true);
  });

  it('orders voice layers foundation-first with unique sequential order numbers', () => {
    const orders = VOICE_LAYERS.map((l) => l.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
    // Lead melody is always the first layer learned.
    expect(VOICE_LAYERS[0].id).toBe('lead');
    for (const l of VOICE_LAYERS) {
      expect(typeof l.label).toBe('string');
      expect(typeof l.role).toBe('string');
      expect(typeof l.advice).toBe('string');
    }
  });

  it('every learning step and notation group has the documented shape', () => {
    for (const step of LEARNING_STEPS) {
      expect(typeof step.id).toBe('string');
      expect(typeof step.label).toBe('string');
      expect(typeof step.detail).toBe('string');
    }
    for (const g of NOTATION_HELP) {
      expect(typeof g.title).toBe('string');
      expect(typeof g.summary).toBe('string');
      expect(Array.isArray(g.points)).toBe(true);
      expect(g.points.length).toBeGreaterThan(0);
    }
  });

  it('maps scale degrees to solfège syllables, wrapping octaves', () => {
    expect(SOLFEGE_DEGREES).toHaveLength(7);
    expect(solfegeForDegree(1)).toBe('Do');
    expect(solfegeForDegree(3)).toBe('Mi');
    expect(solfegeForDegree(5)).toBe('Sol');
    // Octave wrap: 8 → Do, 9 → Re.
    expect(solfegeForDegree(8)).toBe('Do');
    expect(solfegeForDegree(9)).toBe('Re');
    expect(solfegeForDegree(null)).toBeNull();
    expect(solfegeForDegree('x')).toBeNull();
  });

  it('every harmony part carries id, label, role, register, derivable flag and interval', () => {
    const ids = new Set();
    const registers = new Set(['low', 'mid', 'high']);
    for (const p of HARMONY_PARTS) {
      expect(typeof p.id).toBe('string');
      expect(ids.has(p.id)).toBe(false); // ids unique
      ids.add(p.id);
      expect(typeof p.label).toBe('string');
      expect(typeof p.role).toBe('string');
      expect(registers.has(p.register)).toBe(true);
      expect(typeof p.derivable).toBe('boolean');
      expect(typeof p.interval).toBe('string');
    }
    // The melody is the base (not derivable); the rest are.
    expect(HARMONY_PARTS.find((p) => p.id === 'melody').derivable).toBe(false);
    expect(DERIVABLE_HARMONY_PARTS.every((p) => p.derivable)).toBe(true);
    expect(DERIVABLE_HARMONY_PARTS.map((p) => p.id)).toEqual([
      'bass', 'mid-harmony-1', 'mid-harmony-2', 'high-harmony-1', 'high-harmony-2',
    ]);
  });

  it('harmonyPartLabel resolves known ids and empties unknown', () => {
    expect(harmonyPartLabel('bass')).toBe('Bass');
    expect(harmonyPartLabel('high-harmony-2')).toBe('High Harmony II');
    expect(harmonyPartLabel('nope')).toBe('');
  });

  it('harmonyPartOrder sorts low→high and pushes unknown roles last', () => {
    expect(harmonyPartOrder('bass')).toBeLessThan(harmonyPartOrder('mid-harmony-1'));
    expect(harmonyPartOrder('mid-harmony-1')).toBeLessThan(harmonyPartOrder('high-harmony-1'));
    expect(harmonyPartOrder('custom-unknown')).toBe(3);
    // Resolves by role too (harmony parts share the 'harmony' role).
    expect(harmonyPartOrder('harmony')).toBeLessThanOrEqual(3);
  });
});
