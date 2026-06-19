import { describe, it, expect } from 'vitest';
import { findAxisReversals, findShotTypeMonotony } from './shotContinuity.js';

describe('findAxisReversals', () => {
  it('flags an axis reversal across a continuity-linked left↔right pair', () => {
    const scene = {
      shots: [
        { id: 'a', description: 'hero faces left', screenDirection: 'left' },
        { id: 'b', description: 'reverse — hero faces right', screenDirection: 'right', continuityFromShotId: 'a' },
      ],
    };
    const out = findAxisReversals(scene);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ fromId: 'a', toId: 'b', fromDirection: 'left', toDirection: 'right' });
  });

  it('does NOT flag a continuity pair that keeps the same direction', () => {
    const scene = {
      shots: [
        { id: 'a', description: 'x', screenDirection: 'left' },
        { id: 'b', description: 'y', screenDirection: 'left', continuityFromShotId: 'a' },
      ],
    };
    expect(findAxisReversals(scene)).toEqual([]);
  });

  it('treats neutral (head-on) as no axis — never a reversal', () => {
    const scene = {
      shots: [
        { id: 'a', description: 'x', screenDirection: 'neutral' },
        { id: 'b', description: 'y', screenDirection: 'right', continuityFromShotId: 'a' },
      ],
    };
    expect(findAxisReversals(scene)).toEqual([]);
  });

  it('does NOT flag a direction flip between UNLINKED shots (a legitimate reverse angle)', () => {
    const scene = {
      shots: [
        { id: 'a', description: 'x', screenDirection: 'left' },
        { id: 'b', description: 'y', screenDirection: 'right' },   // no continuityFromShotId → fresh angle
      ],
    };
    expect(findAxisReversals(scene)).toEqual([]);
  });

  it('skips when either shot has an unclassified (null) direction', () => {
    const scene = {
      shots: [
        { id: 'a', description: 'x', screenDirection: null },
        { id: 'b', description: 'y', screenDirection: 'right', continuityFromShotId: 'a' },
      ],
    };
    expect(findAxisReversals(scene)).toEqual([]);
  });

  it('ignores a continuity ref to an unknown shot id', () => {
    const scene = {
      shots: [
        { id: 'b', description: 'y', screenDirection: 'right', continuityFromShotId: 'ghost' },
      ],
    };
    expect(findAxisReversals(scene)).toEqual([]);
  });

  it('returns [] for a non-array / empty / single-shot scene', () => {
    expect(findAxisReversals({})).toEqual([]);
    expect(findAxisReversals({ shots: 'nope' })).toEqual([]);
    expect(findAxisReversals({ shots: [{ id: 'a', screenDirection: 'left' }] })).toEqual([]);
  });
});

describe('findShotTypeMonotony', () => {
  it('flags a scene where every classified shot shares one framing', () => {
    const scene = {
      shots: [
        { id: 'a', shotType: 'medium' },
        { id: 'b', shotType: 'medium' },
        { id: 'c', shotType: 'medium' },
      ],
    };
    expect(findShotTypeMonotony(scene)).toMatchObject({ shotType: 'medium', classifiedCount: 3 });
  });

  it('does NOT flag a varied scene', () => {
    const scene = {
      shots: [
        { id: 'a', shotType: 'wide' },
        { id: 'b', shotType: 'medium' },
        { id: 'c', shotType: 'close' },
      ],
    };
    expect(findShotTypeMonotony(scene)).toBe(null);
  });

  it('does NOT flag when fewer than minClassified shots are classified', () => {
    const scene = {
      shots: [
        { id: 'a', shotType: 'medium' },
        { id: 'b', shotType: 'medium' },
        { id: 'c' },                        // unclassified
        { id: 'd' },                        // unclassified
      ],
    };
    // Only 2 classified, default minClassified is 3 → not enough confidence.
    expect(findShotTypeMonotony(scene)).toBe(null);
    // Lowering the threshold flags the all-medium classified pair.
    expect(findShotTypeMonotony(scene, { minClassified: 2 })).toMatchObject({ shotType: 'medium', classifiedCount: 2 });
  });

  it('ignores unclassified shots when judging monotony', () => {
    const scene = {
      shots: [
        { id: 'a', shotType: 'close' },
        { id: 'b' },                        // unclassified — not counted
        { id: 'c', shotType: 'close' },
        { id: 'd', shotType: 'close' },
      ],
    };
    expect(findShotTypeMonotony(scene)).toMatchObject({ shotType: 'close', classifiedCount: 3 });
  });

  it('returns null for non-array / empty shots', () => {
    expect(findShotTypeMonotony({})).toBe(null);
    expect(findShotTypeMonotony({ shots: 'x' })).toBe(null);
    expect(findShotTypeMonotony({ shots: [] })).toBe(null);
  });
});
