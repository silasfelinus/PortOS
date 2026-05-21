/**
 * Update pipeline stage prompt templates that were updated in the
 * "length profile" feature (feat/pipeline-genconfig-length-cover).
 *
 * The prompts now carry `{{lengthTargets.*}}` variables so the idea, prose,
 * comic-script, and TV-script stages scale their beat counts, word targets,
 * and page/minute targets with the per-issue length profile picker instead of
 * using the old hardcoded numbers.
 *
 * `pipeline-tv-script.md` was renamed to `pipeline-teleplay.md` in 96bc7f17;
 * an older install that never ran migration 003 still carries the obsolete
 * file in `data/`. `retireOnSampleMissing: true` lets the shared helper soft-
 * delete it when unmodified and warn when customized, instead of crashing on
 * the sample-side ENOENT.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-idea-expansion.md':  ['aee25112b2c596f643b17c559b772c22'],
  'pipeline-prose.md':           ['bfea5aeeb471aae9749baee765b473a7'],
  'pipeline-comic-script.md':    ['40e5fdc1a1e68a7419b7dad936366c1a'],
  'pipeline-tv-script.md':       ['3f6fecc25573ed054b47db392250034a'],
  'pipeline-season-episodes.md': ['6e349ad26bed8a0ccb042571f03f03eb'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-idea-expansion.md':  '41facefbc0c0549d456bef9111f95ab9',
  'pipeline-prose.md':           '30ac30ec2b9d3e2a9eb869c181732cc6',
  'pipeline-comic-script.md':    'beab031951859ca13579cdb9c4dbe769',
  'pipeline-tv-script.md':       '376f779f4687b598f1c92ca4e770fd5a',
  'pipeline-season-episodes.md': 'c4928e2a5f833358116b29d2d669888d',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'pipeline stage prompt',
  retireOnSampleMissing: true,
  customizedHint: (filename) =>
    `   To apply the length-profile variables manually, diff:\n` +
    `     data.sample/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and merge the {{lengthTargets.*}} template variables.`,
  skipFooter: (count) =>
    `⚠️  ${count} prompt(s) could not be auto-updated because they were customized.\n` +
    `   The length profile picker UI will work, but those prompts won't use\n` +
    `   {{lengthTargets.*}} variables until you merge them manually.\n` +
    `   See data.sample/prompts/stages/ for the updated templates.`,
});

export { applyMigration };
export default { up };
