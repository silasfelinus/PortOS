/**
 * Client-side preview of applying editorial fix edits to a manuscript section.
 * Mirrors the server splice in `server/services/pipeline/manuscriptFix.js`
 * (`acceptManuscriptFix`): locate each `find` (nearest the anchor when it
 * recurs), then replace from the bottom up so earlier offsets stay valid.
 *
 * PREVIEW ONLY — the server route remains authoritative for the real accept.
 * This exists so the impact-preview modal can show before/after without
 * mutating anything. Shares `locateFind` with `manuscriptAnchors.js`.
 */

import { locateFindSpan } from './manuscriptAnchors.js';

// Apply `edits` (each { find, replace, anchorQuote? }) to `content`. Edits whose
// `find` isn't present (even tolerating whitespace) are skipped; overlapping
// edits keep the earlier one. Whitespace tolerance mirrors the server accept.
export function applyEditsToContent(content, edits, anchorQuote) {
  const text = content || '';
  const located = [];
  (edits || []).forEach((e) => {
    const find = e?.find || '';
    if (!find) return;
    const span = locateFindSpan(text, find, e.anchorQuote ?? anchorQuote);
    if (!span) return;
    located.push({ start: span.start, end: span.end, replace: e.replace ?? '' });
  });

  // Drop overlaps (keep the earlier span), then splice high-to-low.
  located.sort((a, b) => a.start - b.start);
  const kept = [];
  let lastEnd = -1;
  located.forEach((l) => {
    if (l.start >= lastEnd) { kept.push(l); lastEnd = l.end; }
  });

  let out = text;
  kept.sort((a, b) => b.start - a.start).forEach((l) => {
    out = out.slice(0, l.start) + l.replace + out.slice(l.end);
  });
  return out;
}
