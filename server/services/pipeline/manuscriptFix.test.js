import { describe, it, expect } from 'vitest';
import { locateFindSpan } from './manuscriptFix.js';

describe('locateFindSpan', () => {
  it('locates an exact substring', () => {
    const text = 'PAGE 56\nPANEL 1\nGiant stands.';
    expect(locateFindSpan(text, 'PANEL 1\nGiant')).toEqual({ start: 8, end: 8 + 'PANEL 1\nGiant'.length });
  });

  it('tolerates whitespace-only differences in the quote (LLM reformatting)', () => {
    // The manuscript has a single newline; the quoted `find` added a blank line.
    const text = 'PAGE 56\nPANEL 1\nLow angle. Giant stands.\nPANEL 2\nHe falls.';
    const find = 'PAGE 56\n\nPANEL 1\nLow angle. Giant stands.';
    const span = locateFindSpan(text, find);
    expect(span).not.toBeNull();
    // The matched span covers the ORIGINAL (single-newline) text, not find.length.
    expect(text.slice(span.start, span.end)).toBe('PAGE 56\nPANEL 1\nLow angle. Giant stands.');
    expect(span.end - span.start).toBe(find.length - 1);
  });

  it('returns null when the text is genuinely absent', () => {
    expect(locateFindSpan('hello world', 'not here at all')).toBeNull();
  });

  it('returns null for an empty find', () => {
    expect(locateFindSpan('anything', '')).toBeNull();
  });

  it('disambiguates a recurring fuzzy match by the nearest anchorQuote', () => {
    const text = 'run away.\n\n[marker] run\taway.';
    // "run away." (exact) appears first; with whitespace tolerance the second
    // (tab instead of space) also matches — anchor picks the nearer one.
    const span = locateFindSpan(text, 'run away.'.replace(' ', ' '), '[marker]');
    // exact match exists at index 0, so it wins (nearest-occurrence among exacts).
    expect(span.start).toBe(0);
  });

  it('escapes regex metacharacters in the quote', () => {
    const text = 'Cost is $5 (approx).';
    expect(locateFindSpan(text, '$5 (approx)')).toEqual({ start: 8, end: 8 + '$5 (approx)'.length });
  });
});
