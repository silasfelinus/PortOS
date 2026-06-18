/**
 * Context-window budgeter for manuscript editorial passes.
 *
 * The editorial passes (completeness, manuscript-fix, per-issue analysis) feed
 * manuscript text to an LLM. Whether the whole manuscript fits in one call —
 * or has to be chunked — depends on the target model's context window. This
 * module makes that decision with a deliberately conservative heuristic: no
 * tokenizer dependency (chars/4), combined with an output reserve and a safety
 * margin, so a slight under-estimate never overflows the window.
 *
 * Pure / side-effect-free — unit-tested in contextBudget.test.js.
 */

import { chunkRawText } from './catalogChunking.js';

export const CHARS_PER_TOKEN = 4;
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 8_000;
export const DEFAULT_SAFETY_MARGIN = 0.1;
// Conservative floor when a provider declares no usable window at all — matches
// Ollama's historical default so we never plan for more than we can be sure of.
export const FALLBACK_CONTEXT_WINDOW = 8_192;

/** chars/4 token estimate. Conservative (real tokenizers pack denser). */
export const estimateTokens = (text) => Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN);

const clampMargin = (m) => (Number.isFinite(m) && m >= 0 && m < 1 ? m : DEFAULT_SAFETY_MARGIN);

const resolveWindow = (contextWindow) =>
  (Number(contextWindow) > 0 ? Number(contextWindow) : FALLBACK_CONTEXT_WINDOW);

/**
 * Usable INPUT token budget for the manuscript text itself, after reserving
 * output space, a safety margin, and any fixed prompt/context overhead
 * (template scaffolding, canon JSON, the finding, etc.).
 */
export function usableInputTokens({
  contextWindow,
  overheadTokens = 0,
  outputReserveTokens = DEFAULT_OUTPUT_RESERVE_TOKENS,
  safetyMargin = DEFAULT_SAFETY_MARGIN,
} = {}) {
  const afterMargin = Math.floor(resolveWindow(contextWindow) * (1 - clampMargin(safetyMargin)));
  return Math.max(0, afterMargin - Math.max(0, outputReserveTokens) - Math.max(0, overheadTokens));
}

/**
 * Expand one section into `{ section, tokens }` units that each fit the usable
 * budget. A section within budget passes through unchanged. An over-budget
 * section that follows the `${header}\n\n${body}` convention every consumer
 * uses (its `text` is the header-prefixed `content`) is split on `body` — via
 * the shared, lossless `chunkRawText` boundary splitter (paragraph → newline →
 * sentence → whitespace → hard cut), with the header preserved on each piece
 * via the retained meta fields. So downstream `sectionsCorpus(chunk.sections)`
 * re-attaches identical issue attribution and the consumers' first-wins
 * finding-merge still dedups across the sub-chunks. `maxChunks: Infinity`
 * disables `chunkRawText`'s chunk-count ceiling so an arbitrarily long section
 * is never trimmed — the whole point of this split. A section that can't be
 * split that way (no string body, or a header that alone exceeds the budget)
 * passes through as one over-budget unit the caller truncates, exactly as
 * before.
 */
function expandSection(section, text, tokens, usableTokens, usableChars) {
  if (tokens <= usableTokens) return [{ section, tokens }];
  const body = section?.content;
  if (typeof body !== 'string' || body.length === 0 || typeof text !== 'string' || !text.endsWith(body)) {
    return [{ section, tokens }];
  }
  const prefix = text.slice(0, text.length - body.length); // `${header}\n\n`
  const bodyBudgetChars = usableChars - prefix.length;
  if (bodyBudgetChars <= 0) return [{ section, tokens }]; // header alone over budget
  const pieces = chunkRawText(body, { maxChars: bodyBudgetChars, maxChunks: Number.POSITIVE_INFINITY });
  if (pieces.length <= 1) return [{ section, tokens }];
  return pieces.map((piece) => {
    const sub = { ...section, content: piece, text: `${prefix}${piece}` };
    return { section: sub, tokens: estimateTokens(sub.text) };
  });
}

/**
 * Plan how to feed a multi-section manuscript to a model with a given window.
 *
 * @param sections - [{ ...meta, text }] where `text` is the section's full
 *   contribution to the corpus (header + body). Order is preserved. A section
 *   that also carries a string `content` (so `text === \`${header}\n\n${content}\``)
 *   can be split when it alone overflows the window.
 * @returns
 *   { mode: 'whole',   usableTokens, usableChars, totalTokens }
 *   { mode: 'chunked', usableTokens, usableChars, totalTokens,
 *     chunks: [{ sections, tokens }] }
 *
 * When a single section is larger than the usable budget it is split into
 * multiple header-preserving sub-chunks (on paragraph/sentence boundaries) so
 * its tail is reviewed instead of truncated — unless it can't be split that way
 * (no string body / a header that alone exceeds the budget), in which case it
 * stays one over-budget unit the caller truncates, as before. A corpus that
 * fits the window (including the empty / single-fitting-section case) is
 * `whole`.
 */
export function planManuscriptPass({
  contextWindow,
  sections,
  overheadTokens = 0,
  outputReserveTokens = DEFAULT_OUTPUT_RESERVE_TOKENS,
  safetyMargin = DEFAULT_SAFETY_MARGIN,
} = {}) {
  const list = Array.isArray(sections) ? sections : [];
  const usableTokens = usableInputTokens({ contextWindow, overheadTokens, outputReserveTokens, safetyMargin });
  const usableChars = usableTokens * CHARS_PER_TOKEN;
  const withTokens = list.map((s) => ({ section: s, tokens: estimateTokens(s?.text) }));
  const totalTokens = withTokens.reduce((n, x) => n + x.tokens, 0);

  // Everything fits → one call.
  if (totalTokens <= usableTokens) {
    return { mode: 'whole', usableTokens, usableChars, totalTokens };
  }

  // Over budget → expand any over-budget section into header-preserving
  // sub-sections (so an oversized single section's tail is reviewed, not
  // truncated — #1386), then greedily first-fit order-preserving chunks.
  const units = withTokens.flatMap(({ section, tokens }) =>
    expandSection(section, section?.text, tokens, usableTokens, usableChars));

  // A lone section that couldn't be split stays one over-budget `whole` pass —
  // identical to the prior behavior (the caller truncates it). Only emit
  // `chunked` when there's genuinely more than one unit to feed.
  if (units.length <= 1) {
    return { mode: 'whole', usableTokens, usableChars, totalTokens };
  }

  // Greedy first-fit packing, order-preserving. Each chunk stays under the
  // usable budget unless a single (unsplittable) section already exceeds it.
  const chunks = [];
  let cur = [];
  let curTokens = 0;
  for (const { section, tokens } of units) {
    if (cur.length && curTokens + tokens > usableTokens) {
      chunks.push({ sections: cur, tokens: curTokens });
      cur = [];
      curTokens = 0;
    }
    cur.push(section);
    curTokens += tokens;
  }
  if (cur.length) chunks.push({ sections: cur, tokens: curTokens });
  return { mode: 'chunked', usableTokens, usableChars, totalTokens, chunks };
}
