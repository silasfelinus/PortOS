/**
 * Storyboard / video shot-continuity deterministic primitives (#1315) for the
 * editorial check registry. Pure and dependency-free (no side-effecting imports)
 * so it stays unit-testable in isolation — mirrors ./nameSimilarity.js and the
 * other deterministic scanners.
 *
 * Backs the deterministic `visual.shot-continuity` check in checkRegistry.js,
 * which reasons over a storyboard scene's `shots[]` (each carrying the
 * film-grammar fields `shotType` + `screenDirection` + `continuityFromShotId`
 * from server/lib/shotGrammar.js). Two classic film-grammar errors are computable
 * from those signals without an LLM:
 *
 *   1. **180-degree rule (axis reversal).** When shot B chains from an earlier
 *      shot A (`B.continuityFromShotId === A.id`) — i.e. the author declared the
 *      two shots a continuous bridge — and the two shots face OPPOSITE screen
 *      directions (one `left`, one `right`), the subject appears to flip sides
 *      across the cut. That's an axis jump that disorients the viewer. A
 *      continuity-linked pair is the high-precision trigger: the link is the
 *      author's explicit "these are continuous" signal, so a direction flip
 *      across it is a real error, not a legitimate reverse-angle.
 *
 *   2. **Shot-type monotony.** A scene whose shots ALL share one framing (every
 *      shot `medium`, say) reads as flat, slideshow coverage — no establishing
 *      wide, no punch-in for emphasis. Flagged only when enough shots are
 *      classified to be confident it's monotony, not a sparse outline.
 *
 * High-precision by design (favors under-flagging, like the other deterministic
 * scanners). Unclassified shots (null `shotType` / `screenDirection`) are treated
 * as ABSENT — skipped, never guessed — per the absent-vs-empty rule. The judgment
 * cases this can't compute need an LLM: eyeline match ships as the `visual.eyeline-match`
 * check (#1466), fed by `summarizeStoryboardShots` below; appearance/prop continuity
 * is a tracked follow-up.
 */

// Two directions are an axis reversal only when both are decided AND opposite.
// `neutral` (head-on / ambiguous) has no axis to cross, so it never reverses.
function isAxisReversal(a, b) {
  if (a == null || b == null) return false;
  if (a === 'neutral' || b === 'neutral') return false;
  return a !== b; // one 'left', one 'right'
}

// Shots of a scene as a safe array (an older/peer-synced scene may carry a
// non-array `shots`). Each element is passed through untouched — the caller
// type-guards the fields it reads.
function sceneShots(scene) {
  return Array.isArray(scene?.shots) ? scene.shots : [];
}

/**
 * Detect 180-degree-rule axis reversals across continuity-linked shot pairs in
 * one scene. For every shot that chains from an earlier shot in the same scene,
 * compare their `screenDirection`; a decided-and-opposite pair is flagged.
 *
 * @param {object} scene  a storyboard scene with `shots[]`
 * @returns {Array<{ fromId, toId, fromDirection, toDirection, fromDescription, toDescription }>}
 */
export function findAxisReversals(scene) {
  const shots = sceneShots(scene);
  if (shots.length < 2) return [];
  // Shot ids are unique on the extract path (sanitizeShot synthesizes them) but
  // the route doesn't enforce cross-shot uniqueness, so a hand-edited scene could
  // carry a duplicate id — last-wins here, matching how a continuity ref would
  // resolve anyway. Acceptable under the check's high-precision / under-flag design.
  const byId = new Map();
  for (const s of shots) {
    if (s && typeof s === 'object' && typeof s.id === 'string' && s.id) byId.set(s.id, s);
  }
  const out = [];
  for (const shot of shots) {
    if (!shot || typeof shot !== 'object') continue;
    const fromId = typeof shot.continuityFromShotId === 'string' ? shot.continuityFromShotId : null;
    if (!fromId) continue;
    const prior = byId.get(fromId);
    if (!prior || prior === shot) continue;
    const fromDir = typeof prior.screenDirection === 'string' ? prior.screenDirection : null;
    const toDir = typeof shot.screenDirection === 'string' ? shot.screenDirection : null;
    if (!isAxisReversal(fromDir, toDir)) continue;
    out.push({
      fromId,
      toId: typeof shot.id === 'string' ? shot.id : '',
      fromDirection: fromDir,
      toDirection: toDir,
      fromDescription: typeof prior.description === 'string' ? prior.description : '',
      toDescription: typeof shot.description === 'string' ? shot.description : '',
    });
  }
  return out;
}

// Human-readable label for a shot's screen direction, used when rendering shots
// for the LLM eyeline/appearance continuity passes (#1466). `neutral` is head-on;
// an unset direction is named so the model knows the signal is absent, not "left".
const DIRECTION_PROMPT_LABEL = {
  left: 'faces screen-left',
  right: 'faces screen-right',
  neutral: 'faces head-on',
};

/**
 * Render the collected storyboard scenes into a compact, ordered text block for
 * an LLM continuity pass (eyeline match — #1466 — and, later, appearance/prop
 * continuity). Pure + deterministic so it's unit-testable and so its token cost
 * is countable. Each qualifying scene becomes a labeled block; each shot is one
 * line carrying the fields the model reasons over: id, shot type, screen
 * direction, continuity link, and the free-text description (the eyeline signal).
 *
 * A scene qualifies only when it has at least two shots with a non-empty
 * description — an eyeline/appearance match is a judgment ACROSS shots, so a
 * single-shot (or description-less) scene has nothing to compare. ALL shots of a
 * qualifying scene are rendered (not just the described ones) so a
 * `continuityFromShotId` reference still resolves to a visible line; an
 * undescribed shot renders its description as `(no description)`.
 *
 * Returns '' when no scene qualifies, so the caller can gate the LLM call on a
 * non-empty block (mirrors the object-backstory check's row gate).
 *
 * @param {Array<{ issueNumber: number|null, scene: object }>} storyboardScenes
 * @returns {string}
 */
export function summarizeStoryboardShots(storyboardScenes) {
  const entries = Array.isArray(storyboardScenes) ? storyboardScenes : [];
  const blocks = [];
  let sceneIndex = 0;
  for (const entry of entries) {
    const scene = entry?.scene;
    if (!scene || typeof scene !== 'object') continue;
    const shots = sceneShots(scene);
    const describedCount = shots.filter(
      (s) => s && typeof s === 'object' && typeof s.description === 'string' && s.description.trim(),
    ).length;
    // Need at least two described shots to compare an eyeline / appearance across.
    if (describedCount < 2) continue;
    sceneIndex += 1;
    const issueNumber = Number.isInteger(entry.issueNumber) ? entry.issueNumber : null;
    const sceneName = typeof scene.heading === 'string' && scene.heading.trim()
      ? scene.heading.trim()
      : (typeof scene.slugline === 'string' && scene.slugline.trim() ? scene.slugline.trim() : 'scene');
    const header = issueNumber != null
      ? `Scene ${sceneIndex} (Issue ${issueNumber}): ${sceneName}`
      : `Scene ${sceneIndex}: ${sceneName}`;
    const lines = [];
    for (const s of shots) {
      if (!s || typeof s !== 'object') continue;
      const id = typeof s.id === 'string' && s.id ? s.id : 'shot';
      const type = typeof s.shotType === 'string' && s.shotType ? s.shotType : 'unspecified framing';
      const dir = DIRECTION_PROMPT_LABEL[s.screenDirection] || 'screen direction unspecified';
      const from = typeof s.continuityFromShotId === 'string' && s.continuityFromShotId
        ? ` (continues from ${s.continuityFromShotId})`
        : '';
      const desc = typeof s.description === 'string' && s.description.trim()
        ? s.description.trim()
        : '(no description)';
      lines.push(`  - ${id} [${type}, ${dir}]${from}: ${desc}`);
    }
    blocks.push(`${header}\n${lines.join('\n')}`);
  }
  return blocks.join('\n\n');
}

/**
 * Detect shot-type monotony in one scene: enough classified shots that they ALL
 * share a single `shotType`. Returns the monotony descriptor or null.
 *
 * Only CLASSIFIED shots (non-null `shotType`) count toward the verdict — an
 * outline where the extractor tagged framing on some shots but not others isn't
 * penalized for the untagged ones. The scene is flagged only when at least
 * `minClassified` shots are classified AND every classified one is the same type
 * (so a 2-of-5 partial tag never trips it).
 *
 * @param {object} scene
 * @param {{ minClassified?: number }} [opts] minClassified — floored at 2 (a
 *   single classified shot is never "monotony"); default 3.
 * @returns {{ shotType: string, classifiedCount: number } | null}
 */
export function findShotTypeMonotony(scene, opts = {}) {
  const minClassified = Math.max(2, Number.isInteger(opts.minClassified) ? opts.minClassified : 3);
  const shots = sceneShots(scene);
  const types = [];
  for (const s of shots) {
    if (s && typeof s === 'object' && typeof s.shotType === 'string' && s.shotType) types.push(s.shotType);
  }
  if (types.length < minClassified) return null;
  const first = types[0];
  if (!types.every((t) => t === first)) return null;
  return { shotType: first, classifiedCount: types.length };
}
