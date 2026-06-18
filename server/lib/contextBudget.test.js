import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  usableInputTokens,
  planManuscriptPass,
  CHARS_PER_TOKEN,
  FALLBACK_CONTEXT_WINDOW,
} from './contextBudget.js';

const section = (n, chars) => ({ number: n, text: 'x'.repeat(chars) });

// A realistic section following the `${header}\n\n${content}` convention every
// consumer builds before calling planManuscriptPass — so it can be split when
// it alone overflows the window.
const header = (n, title) => `# Issue ${n}${title ? ` — ${title}` : ''} (script)`;
const realSection = (n, content, title = `T${n}`) => ({
  number: n,
  title,
  stageId: 'script',
  content,
  text: `${header(n, title)}\n\n${content}`,
});
// A body of `paras` paragraphs, each `chars` long, joined by blank lines.
const paragraphs = (paras, chars) =>
  Array.from({ length: paras }, (_, i) => `${String.fromCharCode(97 + (i % 26))}`.repeat(chars)).join('\n\n');

describe('contextBudget', () => {
  describe('estimateTokens', () => {
    it('estimates chars/4, rounding up, and tolerates null', () => {
      expect(estimateTokens('')).toBe(0);
      expect(estimateTokens('abcd')).toBe(1);
      expect(estimateTokens('abcde')).toBe(2);
      expect(estimateTokens(null)).toBe(0);
      expect(estimateTokens(undefined)).toBe(0);
    });
  });

  describe('usableInputTokens', () => {
    it('subtracts margin, output reserve, and overhead', () => {
      // 100k window, 10% margin -> 90k; minus 8k reserve minus 2k overhead = 80k
      expect(usableInputTokens({ contextWindow: 100_000, overheadTokens: 2_000 })).toBe(80_000);
    });
    it('falls back to the conservative window when none is declared', () => {
      const u = usableInputTokens({ contextWindow: null, outputReserveTokens: 0, safetyMargin: 0 });
      expect(u).toBe(FALLBACK_CONTEXT_WINDOW);
    });
    it('never goes negative when reserves exceed the window', () => {
      expect(usableInputTokens({ contextWindow: 4_000, outputReserveTokens: 8_000 })).toBe(0);
    });
    it('clamps a nonsensical margin back to the default', () => {
      // margin 2 (>1) is invalid -> default 0.1; 100k -> 90k - 8k = 82k
      expect(usableInputTokens({ contextWindow: 100_000, safetyMargin: 2 })).toBe(82_000);
    });
  });

  describe('planManuscriptPass', () => {
    it('returns whole when the corpus fits the window', () => {
      const plan = planManuscriptPass({
        contextWindow: 1_000_000,
        sections: [section(1, 4_000), section(2, 4_000)],
        outputReserveTokens: 0,
        safetyMargin: 0,
      });
      expect(plan.mode).toBe('whole');
      expect(plan.totalTokens).toBe(2_000);
      expect(plan.usableChars).toBe(plan.usableTokens * CHARS_PER_TOKEN);
    });

    it('returns whole for a single over-budget section that cannot be split (no string body)', () => {
      // `section()` has `text` but no `content`, so it can't be split on a body
      // — it stays one over-budget `whole` pass the caller truncates, as before.
      const plan = planManuscriptPass({
        contextWindow: 8_192,
        sections: [section(1, 1_000_000)],
      });
      expect(plan.mode).toBe('whole');
    });

    it('splits a single over-budget section into header-preserving sub-chunks instead of truncating', () => {
      // window 8192, margin 0, reserve 0 -> usable 8192 tokens = 32768 chars.
      // One section whose body is ~200k chars (~50k tokens) overflows alone.
      const body = paragraphs(40, 5_000); // 40 paras * 5000 chars + separators
      const plan = planManuscriptPass({
        contextWindow: 8_192,
        sections: [realSection(7, body, 'Long One')],
        outputReserveTokens: 0,
        safetyMargin: 0,
      });
      expect(plan.mode).toBe('chunked');
      expect(plan.chunks.length).toBeGreaterThan(1);

      // Every sub-chunk fits the usable budget once rendered (header + piece).
      const rendered = (s) => `${header(s.number, s.title)}\n\n${s.content}`;
      for (const chunk of plan.chunks) {
        const corpus = chunk.sections.map(rendered).join('\n\n---\n\n');
        expect(corpus.length).toBeLessThanOrEqual(plan.usableChars);
      }

      // Header attribution is preserved on every piece (so downstream
      // first-wins finding-merge dedups by the same issue), and no body text
      // is dropped — concatenating the pieces reproduces the original body.
      const subs = plan.chunks.flatMap((c) => c.sections);
      for (const s of subs) {
        expect(s.number).toBe(7);
        expect(s.title).toBe('Long One');
        expect(s.stageId).toBe('script');
      }
      expect(subs.map((s) => s.content).join('')).toBe(body);
    });

    it('splits on paragraph boundaries when they fit the budget', () => {
      // usable 8192 tokens = 32768 chars; budget for the body is usableChars
      // minus the short header prefix. Paragraphs of 6000 chars -> ~5 per piece.
      const body = paragraphs(20, 6_000);
      const plan = planManuscriptPass({
        contextWindow: 8_192,
        sections: [realSection(3, body)],
        outputReserveTokens: 0,
        safetyMargin: 0,
      });
      expect(plan.mode).toBe('chunked');
      const subs = plan.chunks.flatMap((c) => c.sections);
      // Each piece except the last ends on a paragraph boundary (blank line),
      // never mid-paragraph.
      for (const s of subs.slice(0, -1)) {
        expect(s.content.endsWith('\n\n')).toBe(true);
      }
      expect(subs.map((s) => s.content).join('')).toBe(body);
    });

    it('keeps a single over-budget section whole when the header alone exceeds the budget', () => {
      // A pathologically tiny window (4 tokens = 16 chars, smaller than the
      // ~25-char header prefix), so there is no room for any body piece ->
      // falls back to one whole pass.
      const plan = planManuscriptPass({
        contextWindow: 4,
        sections: [realSection(1, paragraphs(10, 2_000))],
        outputReserveTokens: 0,
        safetyMargin: 0,
      });
      expect(plan.mode).toBe('whole');
    });

    it('splits an over-budget section while packing its small neighbors normally', () => {
      // One huge section between two small ones: the huge one splits, the small
      // ones still pack/standalone, and overall order is preserved.
      const sections = [
        realSection(1, paragraphs(2, 1_000)),
        realSection(2, paragraphs(40, 5_000)),
        realSection(3, paragraphs(2, 1_000)),
      ];
      const plan = planManuscriptPass({ contextWindow: 8_192, sections, outputReserveTokens: 0, safetyMargin: 0 });
      expect(plan.mode).toBe('chunked');
      const order = plan.chunks.flatMap((c) => c.sections.map((s) => s.number));
      // Section 2's pieces all carry number 2, appearing contiguously between 1 and 3.
      expect(order[0]).toBe(1);
      expect(order[order.length - 1]).toBe(3);
      expect(order.filter((n) => n === 2).length).toBeGreaterThan(1);
    });

    it('chunks an over-budget multi-section corpus, preserving order and dropping nothing', () => {
      // window 8192, margin 0, reserve 0 -> usable 8192 tokens = 32768 chars.
      // four 5000-tok sections (20000 chars each) -> packs 1 per chunk (2 would be 10000 > 8192).
      const sections = [section(1, 20_000), section(2, 20_000), section(3, 20_000), section(4, 20_000)];
      const plan = planManuscriptPass({ contextWindow: 8_192, sections, outputReserveTokens: 0, safetyMargin: 0 });
      expect(plan.mode).toBe('chunked');
      const order = plan.chunks.flatMap((c) => c.sections.map((s) => s.number));
      expect(order).toEqual([1, 2, 3, 4]);
      expect(plan.chunks.length).toBe(4);
    });

    it('packs multiple small sections into one chunk up to the budget', () => {
      // usable 8192 tokens; sections of 1000 tokens (4000 chars) each -> 8 fit per chunk
      const sections = Array.from({ length: 10 }, (_, i) => section(i + 1, 4_000));
      const plan = planManuscriptPass({ contextWindow: 8_192, sections, outputReserveTokens: 0, safetyMargin: 0 });
      expect(plan.mode).toBe('chunked');
      expect(plan.chunks[0].sections.length).toBe(8); // 8 * 1000 = 8000 <= 8192
      expect(plan.chunks[1].sections.length).toBe(2);
      const total = plan.chunks.reduce((n, c) => n + c.sections.length, 0);
      expect(total).toBe(10);
    });
  });
});
