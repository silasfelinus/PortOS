import { describe, it, expect } from 'vitest';
import { placeCuesOnTimeline } from './audioCuePlacement.js';

describe('placeCuesOnTimeline', () => {
  it('returns [] for empty / non-array input', () => {
    expect(placeCuesOnTimeline([], 100)).toEqual([]);
    expect(placeCuesOnTimeline(null, 100)).toEqual([]);
  });

  it('leaves timing null when the duration is unknown', () => {
    const cues = [{ id: 'cue-001' }, { id: 'cue-002' }];
    const placed = placeCuesOnTimeline(cues, null);
    expect(placed).toHaveLength(2);
    expect(placed.every((c) => c.startSec === null && c.endSec === null)).toBe(true);
  });

  it('leaves timing null for a non-positive duration', () => {
    const placed = placeCuesOnTimeline([{ id: 'cue-001' }], 0);
    expect(placed[0].startSec).toBeNull();
  });

  it('tiles cues end-to-end across the episode, last cue pinned to the end', () => {
    const cues = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const placed = placeCuesOnTimeline(cues, 90);
    // Even split (no rendered durations): 30s each.
    expect(placed[0].startSec).toBe(0);
    expect(placed[0].endSec).toBeCloseTo(30, 5);
    expect(placed[1].startSec).toBeCloseTo(30, 5);
    expect(placed[2].endSec).toBe(90); // pinned to the episode end
    // Contiguous: each cue starts where the previous ended.
    expect(placed[1].startSec).toBeCloseTo(placed[0].endSec, 5);
    expect(placed[2].startSec).toBeCloseTo(placed[1].endSec, 5);
  });

  it('honors a cue rendered durationSec, splitting the rest evenly', () => {
    const cues = [
      { id: 'a', durationSec: 20 }, // honored
      { id: 'b' },
      { id: 'c' },
    ];
    const placed = placeCuesOnTimeline(cues, 100);
    expect(placed[0].endSec).toBeCloseTo(20, 5); // honored rendered length
    // remaining 80s split across the 2 remaining cues → 40 each, last pinned to 100
    expect(placed[1].startSec).toBeCloseTo(20, 5);
    expect(placed[1].endSec).toBeCloseTo(60, 5);
    expect(placed[2].endSec).toBe(100);
  });

  it('clamps a rendered duration that would overrun the timeline', () => {
    const cues = [{ id: 'a', durationSec: 500 }, { id: 'b' }];
    const placed = placeCuesOnTimeline(cues, 60);
    // First cue can't run past the episode; last cue pinned to the end.
    expect(placed[0].endSec).toBeLessThanOrEqual(60);
    expect(placed[1].endSec).toBe(60);
    // A clamped first cue can leave the last cue a zero-length tail — that's fine,
    // the muxer's placed-cue filter drops zero/negative spans.
    expect(placed[1].startSec).toBeLessThanOrEqual(60);
  });

  it('preserves cue identity fields (id/label/prompt) while adding timing', () => {
    const cues = [{ id: 'cue-001', label: 'Act I', prompt: 'pads' }];
    const placed = placeCuesOnTimeline(cues, 30);
    expect(placed[0]).toMatchObject({ id: 'cue-001', label: 'Act I', prompt: 'pads', startSec: 0, endSec: 30 });
  });
});
