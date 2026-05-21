/**
 * Make the pipeline arc + season + verify + resolve prompts Vonnegut-shape
 * aware. Adds `{{{shapeGuidance}}}` (the rendered curve + per-position
 * guidance) and, where applicable, `{{shapePosition}}` / `{{volumeShapePosition}}`
 * (the per-volume placement on the picked curve) to:
 *
 *   pipeline-arc-overview        — propose-or-honor block + `shape` in JSON output
 *   pipeline-season-episodes     — per-season curve placement, episode pacing rule
 *   pipeline-arc-verify          — new "story-shape adherence" check
 *   pipeline-volume-verify       — per-volume placement + volume-internal adherence check
 *   pipeline-arc-resolve         — preserve picked shape during auto-resolve
 *
 * `pipeline-arc-resolve.md` was never previously in data.sample/ (it shipped
 * in `27ef3c27` but only landed in `data/`). `createIfMissing: true` keeps
 * the migration self-contained for that case; for the other files the branch
 * never fires because they already shipped in data.sample/.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-arc-overview.md':    ['6a3ecab43d1f46b7ef9aab6c69ea0326'],
  'pipeline-arc-verify.md':      ['52e31abc93e3105176236fcaa5d1575a'],
  'pipeline-volume-verify.md':   ['c6ea28e972ad6e229bafb2d602b4dda3'],
  'pipeline-season-episodes.md': ['c4928e2a5f833358116b29d2d669888d'],
  'pipeline-arc-resolve.md':     ['87bc5c01f1a8a97b681727a38b05edc6'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-arc-overview.md':    'd34d72b8e49ba303d38607845dd87f1c',
  'pipeline-arc-verify.md':      'ff56d8387162017e08d5d0491060ddd6',
  'pipeline-volume-verify.md':   '03f3c874cb80e1c98abcf03168fa7a92',
  'pipeline-season-episodes.md': '50c68a29c3ebc275db3095d06bd87100',
  'pipeline-arc-resolve.md':     'a8677bbe1eb38f871fb152a5b0fec7c6',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'shape-aware prompt',
  createIfMissing: true,
  customizedHint: (filename) =>
    `   To apply the Vonnegut shape variables manually, diff:\n` +
    `     data.sample/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and merge the {{{shapeGuidance}}} block (and {{shapePosition}} / {{volumeShapePosition}} where applicable).`,
  skipFooter: (count) =>
    `⚠️  ${count} prompt(s) could not be auto-updated because they were customized.\n` +
    `   Shape-aware features will work for un-customized prompts; the customized\n` +
    `   ones will continue using their existing templates (without the\n` +
    `   {{{shapeGuidance}}} block) until you merge manually.`,
});

export { applyMigration };
export default { up };
