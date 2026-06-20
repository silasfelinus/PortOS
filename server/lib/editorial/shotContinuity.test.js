import { describe, it, expect } from 'vitest';
import { findAxisReversals, findShotTypeMonotony, summarizeStoryboardShots } from './shotContinuity.js';

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

describe('summarizeStoryboardShots (#1466)', () => {
  const sceneEntry = (issueNumber, scene) => ({ issueNumber, scene });

  it('renders a per-scene block with shot id, framing, direction, link and description', () => {
    const block = summarizeStoryboardShots([
      sceneEntry(4, {
        heading: 'INT. KITCHEN',
        shots: [
          { id: 'shot-01', shotType: 'medium', screenDirection: 'right', description: 'Anna looks toward the doorway' },
          { id: 'shot-02', shotType: 'medium', screenDirection: 'right', continuityFromShotId: 'shot-01', description: 'Ben answers, also looking right' },
        ],
      }),
    ]);
    expect(block).toContain('Scene 1 (Issue 4): INT. KITCHEN');
    expect(block).toContain('shot-01 [medium, faces screen-right]: Anna looks toward the doorway');
    expect(block).toContain('shot-02 [medium, faces screen-right] (continues from shot-01): Ben answers, also looking right');
  });

  it('skips a scene with fewer than two described shots (nothing to compare)', () => {
    // One described + one undescribed → not comparable.
    expect(summarizeStoryboardShots([
      sceneEntry(1, { heading: 'A', shots: [{ id: 's1', description: 'only one' }, { id: 's2' }] }),
    ])).toBe('');
    // Single described shot.
    expect(summarizeStoryboardShots([
      sceneEntry(1, { heading: 'A', shots: [{ id: 's1', description: 'alone' }] }),
    ])).toBe('');
  });

  it('still renders an undescribed shot (so a continuity ref resolves) once the scene qualifies', () => {
    const block = summarizeStoryboardShots([
      sceneEntry(null, {
        slugline: 'EXT. ROAD',
        shots: [
          { id: 's1', description: 'wide of the road' },
          { id: 's2', description: 'two riders approach' },
          { id: 's3' }, // undescribed, but the scene already qualifies on s1+s2
        ],
      }),
    ]);
    expect(block).toContain('Scene 1: EXT. ROAD'); // no issue number → no "(Issue n)"
    expect(block).toContain('s3 [unspecified framing, screen direction unspecified]: (no description)');
  });

  it('numbers only qualifying scenes sequentially and joins multiple with a blank line', () => {
    const block = summarizeStoryboardShots([
      sceneEntry(1, { heading: 'SKIP', shots: [{ id: 'x', description: 'lonely' }] }), // skipped
      sceneEntry(2, { heading: 'KEEP-A', shots: [{ id: 'a', description: 'one' }, { id: 'b', description: 'two' }] }),
      sceneEntry(3, { heading: 'KEEP-B', shots: [{ id: 'c', description: 'three' }, { id: 'd', description: 'four' }] }),
    ]);
    expect(block).toContain('Scene 1 (Issue 2): KEEP-A');
    expect(block).toContain('Scene 2 (Issue 3): KEEP-B');
    expect(block).not.toContain('SKIP');
    expect(block.split('\n\n')).toHaveLength(2);
  });

  it('returns empty string and never throws for empty / malformed input', () => {
    expect(summarizeStoryboardShots([])).toBe('');
    expect(summarizeStoryboardShots(null)).toBe('');
    expect(summarizeStoryboardShots(undefined)).toBe('');
    expect(() => summarizeStoryboardShots([{ scene: null }, { scene: { shots: 'x' } }, {}])).not.toThrow();
    expect(summarizeStoryboardShots([{ scene: { shots: [1, 2] } }])).toBe(''); // non-object shots → no descriptions
  });
});
