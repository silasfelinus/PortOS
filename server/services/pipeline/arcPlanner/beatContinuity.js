/**
 * arcPlanner/beatContinuity.js — whole-manuscript BEAT-level continuity pass
 * (#1510).
 *
 * The series autopilot caught arc/continuity problems at two altitudes with a
 * gap in the middle: `verifyArc` reviews episode SYNOPSES across the whole arc
 * (before beats exist), and the full-text completeness pass reads VERBATIM
 * scripts (after the expensive text stage). So whole-BOOK beat defects — a
 * cliffhanger raised in one issue and never resolved, a finale that drifts from
 * the arc's intended ending, a promised through-line that never lands, an event
 * staged as "first" in two issues — only surfaced AFTER 24 full scripts were
 * generated, by the full-text pass (or not until a human read it).
 *
 * This pass closes the gap: it runs over the per-issue beat sheets (idea.output)
 * for the whole series — a compact corpus that fits a normal window cheaply (no
 * chunking) — BETWEEN beat generation and full-script generation. On blocking
 * findings the resolver rewrites the offending issues' BEATS directly
 * (idea.output) — the right altitude for a beat-level finding — so the fix lands
 * before any script is generated. The full-text completeness pass stays as-is
 * for what genuinely needs verbatim text (pacing, looping/repetition, dialogue
 * craft); this is an additional, earlier, cheaper pass, not a replacement.
 *
 * Mirrors arcCore.js's verifyArc / resolveVerifyIssues / applyEpisodeResolutions
 * trio — same LLM-call + shape + apply structure, one altitude down.
 */

import { runStagedLLM } from '../../../lib/stageRunner.js';
import { ServerError } from '../../../lib/errorHandler.js';
import { getSeries } from '../series.js';
import { listIssues, updateStageWithLatest, TEXT_STAGE_IDS } from '../issues.js';
import {
  buildBeatContinuityContext,
  buildBeatContinuityResolveContext,
  shapeVerifyIssues,
  shapeFindings,
  shapeBeatResolutions,
} from './context.js';

// Text stages generated FROM the beats — stale once the beats are rewritten, so
// a beat correction must clear them for regeneration. `idea` (which holds the
// beats) is excluded; the rest of the text chain (prose → scripts) is downstream.
const DOWNSTREAM_TEXT_STAGES = TEXT_STAGE_IDS.filter((s) => s !== 'idea');

// Cross-issue BEAT continuity pass over the whole series. Read-only — returns
// `{ issues }` shaped like verifyArc. Issues without beats are reviewed at
// synopsis depth (renderVolumeIssue falls back), so a partially-expanded series
// is still checkable.
export async function analyzeBeatContinuity(seriesId, options = {}) {
  const series = await getSeries(seriesId);
  if (!series.arc) {
    throw new ServerError(
      'Series has no arc — run /arc/generate first before checking beat continuity',
      { status: 400, code: 'PIPELINE_NO_ARC' },
    );
  }
  const ctx = await buildBeatContinuityContext(series, options.preloadedWorld);
  const { content, runId, providerId, model } = await runStagedLLM(
    'pipeline-beat-continuity',
    ctx,
    {
      providerOverride: options.providerOverride,
      modelOverride: options.modelOverride,
      returnsJson: true,
      source: 'pipeline-beat-continuity',
    },
  );
  const issues = shapeVerifyIssues(content?.issues);
  return { issues, raw: content, runId, providerId, model };
}

/**
 * Auto-resolve beat-continuity findings by rewriting the offending issues'
 * BEATS in place. Unlike `resolveVerifyIssues` (which rewrites the arc + season
 * synopses and clears beats for regeneration), this edits only `idea.output`,
 * the right altitude for a beat-level finding — so it converges WITHOUT
 * re-running the beat-sheet generation step and never touches the arc/seasons.
 *
 * `options.findings` empty/omitted → run analyzeBeatContinuity first and resolve
 * whatever it returns.
 */
export async function resolveBeatContinuity(seriesId, options = {}) {
  const series = await getSeries(seriesId);
  if (!series.arc) {
    throw new ServerError(
      'Series has no arc to resolve — run /arc/generate first',
      { status: 400, code: 'PIPELINE_NO_ARC' },
    );
  }

  let findings = shapeFindings(options.findings);
  if (!findings.length) {
    const fresh = await analyzeBeatContinuity(seriesId, options);
    findings = fresh.issues || [];
    if (!findings.length) {
      return { series, applied: false, notes: 'No findings to resolve', episodesResolved: [] };
    }
  }

  const ctx = await buildBeatContinuityResolveContext(series, findings, options.preloadedWorld);
  const { content, runId, providerId, model } = await runStagedLLM(
    'pipeline-beat-continuity-resolve',
    ctx,
    {
      providerOverride: options.providerOverride,
      modelOverride: options.modelOverride,
      returnsJson: true,
      source: 'pipeline-beat-continuity-resolve',
    },
  );

  const episodesResolved = await applyBeatResolutions(
    seriesId,
    series,
    shapeBeatResolutions(content?.episodes),
  );
  const notes = typeof content?.notes === 'string' ? content.notes.trim().slice(0, 2000) : '';
  return { series, applied: true, notes, findings, episodesResolved, runId, providerId, model };
}

/**
 * Apply the resolver's per-issue beat rewrites to the canonical issue records.
 * Each correction targets one issue by its series-global episode number (with
 * `seasonNumber` as a disambiguating cross-check, mirroring
 * `applyEpisodeResolutions`). Writes the new beats to `idea.output` while
 * preserving the existing `idea.input` synopsis.
 *
 * After rewriting an issue's beats, the now-stale downstream text stages
 * (prose/comicScript/teleplay) are cleared so the conductor regenerates them from
 * the corrected beats — see the inline note below.
 *
 * Three guards: a locked `idea` stage is left untouched (the user froze it); an
 * issue that has NO beats yet is skipped (the corpus is beat-level — fabricating
 * beats for a still-synopsis-only issue would be out of band, and a later
 * beat-sheet run would overwrite them anyway); an unmatched correction is
 * dropped with a log so a number-scheme mismatch is diagnosable. Never throws.
 * Returns `[{ issueId, number, seasonNumber, corrected, clearedStages, skipped }]`.
 */
export async function applyBeatResolutions(seriesId, series, episodes) {
  if (!Array.isArray(episodes) || episodes.length === 0) return [];
  const issues = await listIssues({ seriesId });
  const seasonIdByNumber = new Map(
    (series?.seasons || []).filter((s) => Number.isInteger(s?.number)).map((s) => [s.number, s.id]),
  );
  const applied = [];
  for (const edit of episodes) {
    const wantSeasonId = edit.seasonNumber != null ? seasonIdByNumber.get(edit.seasonNumber) : null;
    // Require the season match when a resolvable season was named — a bare
    // number fallback could rewrite the wrong season's issue (see the same
    // reasoning in applyEpisodeResolutions). Fail safe to `no-match`.
    const issue = wantSeasonId
      ? issues.find((i) => i.number === edit.episodeNumber && i.seasonId === wantSeasonId)
      : issues.find((i) => i.number === edit.episodeNumber);
    if (!issue) {
      console.log(`⚠️ beat-continuity: no issue matched beat correction (season ${edit.seasonNumber}, episode ${edit.episodeNumber})`);
      applied.push({ seasonNumber: edit.seasonNumber, episodeNumber: edit.episodeNumber, skipped: 'no-match' });
      continue;
    }
    if (issue.stages?.idea?.locked === true) {
      applied.push({ issueId: issue.id, number: issue.number, seasonNumber: edit.seasonNumber, skipped: 'locked' });
      continue;
    }
    if (!(issue.stages?.idea?.output && issue.stages.idea.output.trim())) {
      applied.push({ issueId: issue.id, number: issue.number, seasonNumber: edit.seasonNumber, skipped: 'no-beats' });
      continue;
    }
    await updateStageWithLatest(issue.id, 'idea', () => ({
      output: edit.beats,
      status: 'ready',
      errorMessage: '',
    })).catch((err) => {
      console.log(`⚠️ beat-continuity: episode ${edit.episodeNumber} beat edit failed: ${err.message}`);
    });
    // The beats just changed, so any already-generated prose/scripts derived from
    // them are stale. Clear the unlocked downstream text stages so the conductor's
    // textStages step regenerates them from the corrected beats — otherwise
    // `textReady` sees the old scripts as ready and the run finishes with scripts
    // that contradict the fixed beats. In the normal forward flow these stages are
    // still empty (beat continuity runs before textStages), so this only bites on a
    // re-run / resume over already-drafted issues. Mirrors how applyEpisodeResolutions
    // clears beats when it rewrites a synopsis. A locked downstream stage is the
    // user's frozen work — leave it untouched.
    const clearedStages = [];
    for (const stageId of DOWNSTREAM_TEXT_STAGES) {
      const st = issue.stages?.[stageId];
      if (!st || st.locked === true) continue;
      if (!(st.output && st.output.trim())) continue; // nothing generated → nothing to clear
      await updateStageWithLatest(issue.id, stageId, () => ({ status: 'empty', output: '', errorMessage: '' })).catch((err) => {
        console.log(`⚠️ beat-continuity: clear ${stageId} for episode ${edit.episodeNumber} failed: ${err.message}`);
      });
      clearedStages.push(stageId);
    }
    applied.push({ issueId: issue.id, number: issue.number, seasonNumber: edit.seasonNumber, corrected: true, clearedStages });
  }
  if (applied.length) {
    const fixed = applied.filter((a) => a.corrected).length;
    console.log(`📝 beat-continuity: corrected ${fixed} episode beat sheet(s) for series ${seriesId.slice(0, 12)}`);
  }
  return applied;
}
