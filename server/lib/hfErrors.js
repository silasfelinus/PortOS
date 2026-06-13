// Shared parsing of huggingface_hub gated-access error text. Both the image
// runner (server/services/imageGen/local.js) and the LoRA trainer
// (server/services/loraTraining/failure.js) hit gated-repo failures and want
// to deep-link the user to the model's license page — so the `owner/name`
// extraction lives here once instead of being re-regexed per subsystem.
//
// Pure, no side effects.

// Matches both huggingface_hub gated-access message shapes:
//   "Access to model <repo> is restricted …" (GatedRepoError prose)
//   "Cannot access gated repo for url https://huggingface.co/<repo>/…"
// The optional backtick tolerates markdown-wrapped repo ids; the trailing
// `.git` strip normalizes clone-style refs.
export const GATED_REPO_RE = /(?:Access to model|Cannot access gated repo for url https?:\/\/huggingface\.co\/)\s*`?([\w.-]+\/[\w.-]+)/i;

export function extractGatedRepo(text = '') {
  const match = String(text).match(GATED_REPO_RE);
  return match ? match[1].replace(/\.git$/, '') : null;
}
