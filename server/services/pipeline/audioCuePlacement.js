/**
 * Pure cue → timeline placement for whole-episode audio (issue #863, step 4).
 *
 * Cues are derived per-arc-beat in story order (audioCues.js) but carry no
 * timeline position — the design defers `startSec`/`endSec` to episode-stitch
 * time, because the only real source of timing is the rendered episode's
 * duration (storyboard scenes carry no per-scene duration, and the VO
 * `offsetSec` is a manually-placed audio offset, not a scene-timing source).
 *
 * This module owns that placement: given the ordered cues and the total episode
 * duration (ffprobed at stitch time), it lays each story-order cue onto the
 * absolute timeline so the cues tile the episode end-to-end. A cue's own
 * rendered `durationSec` is honored when present (so a 30s sting stays 30s);
 * unrendered cues split the remaining time evenly. The result is the
 * `startSec`/`endSec` the cue muxer (`buildCueMuxArgs`) places each cue at.
 *
 * Pure + unit-tested — no ffprobe, no filesystem. The caller probes the
 * duration and passes it in.
 */

/**
 * Place an ordered cue list onto a timeline of `totalDurationSec`. Returns a NEW
 * cue array (cues unchanged in identity) with `startSec`/`endSec` filled.
 *
 * Strategy: walk cues in order, advancing a cursor. Each cue spans from the
 * cursor to cursor + its length, where length is the cue's rendered
 * `durationSec` when it's a finite positive number, otherwise an even share of
 * the time still unclaimed by the remaining cues. The final cue is pinned to
 * end exactly at `totalDurationSec` so the bed covers the whole episode (no
 * trailing gap from rounding). Cues that would start past the episode end are
 * clamped to a zero-length tail at the end (the muxer drops zero/negative-span
 * cues via its placed-cue filter).
 *
 * @param {Array} cues               ordered cue objects (need at least `id`)
 * @param {number} totalDurationSec  episode length in seconds (> 0)
 * @returns {Array} cues with startSec/endSec set
 */
export function placeCuesOnTimeline(cues, totalDurationSec) {
  if (!Array.isArray(cues) || cues.length === 0) return [];
  const total = Number(totalDurationSec);
  if (!Number.isFinite(total) || total <= 0) {
    // No usable duration — leave timing null (un-placed); the muxer skips them.
    return cues.map((c) => ({ ...c, startSec: null, endSec: null }));
  }

  const out = [];
  let cursor = 0;
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    const remainingCues = cues.length - i;
    const remainingTime = Math.max(0, total - cursor);
    const rendered = Number(cue?.durationSec);
    const hasRendered = Number.isFinite(rendered) && rendered > 0;

    let length;
    if (i === cues.length - 1) {
      // Last cue: fill to the end so the bed covers the whole episode.
      length = remainingTime;
    } else if (hasRendered) {
      // Honor the cue's actual rendered length, but never overrun the timeline.
      length = Math.min(rendered, remainingTime);
    } else {
      // Even share of the time still unclaimed by the cues that remain.
      length = remainingTime / remainingCues;
    }

    const startSec = Math.min(cursor, total);
    const endSec = Math.min(cursor + length, total);
    out.push({ ...cue, startSec, endSec });
    cursor = endSec;
  }
  return out;
}
