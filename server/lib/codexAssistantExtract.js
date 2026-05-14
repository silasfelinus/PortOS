// Codex CLI echoes its full session transcript (banner + metadata + echoed
// prompt + `\ncodex\n<reply>` + token footer). JSON stages survive because the
// parser skips non-JSON chunks; text stages don't, so this helper carves out
// just the assistant reply. Idempotent for non-Codex output.
export function extractCodexAssistant(text) {
  if (typeof text !== 'string' || !text) return text;
  if (!text.startsWith('OpenAI Codex v')) return text;

  const codexIdx = text.indexOf('\ncodex\n');
  if (codexIdx < 0) return text;
  let response = text.slice(codexIdx + '\ncodex\n'.length);

  const tokensIdx = response.lastIndexOf('\ntokens used');
  if (tokensIdx > 0) response = response.slice(0, tokensIdx);

  return response.trim();
}
