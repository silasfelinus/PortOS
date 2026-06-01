import { describe, expect, it } from 'vitest';
import { buildPrompt, buildMessages, summarizeTimings, extractStreamDelta } from './localLlmPlayground.js';

describe('buildPrompt', () => {
  it('returns the bare prompt when no system instructions', () => {
    expect(buildPrompt({ systemPrompt: '', prompt: 'hi' })).toBe('hi');
    expect(buildPrompt({ systemPrompt: '   ', prompt: 'hi' })).toBe('hi');
  });

  it('prefixes a labeled system block when present (display format, not wire)', () => {
    expect(buildPrompt({ systemPrompt: 'Be terse', prompt: 'hi' }))
      .toBe('System instructions:\nBe terse\n\nUser prompt:\nhi');
  });
});

describe('buildMessages', () => {
  it('omits the system message when blank', () => {
    expect(buildMessages({ systemPrompt: '  ', prompt: 'hi' })).toEqual([
      { role: 'user', content: 'hi' },
    ]);
  });

  it('includes a system message when present', () => {
    expect(buildMessages({ systemPrompt: 'Be terse', prompt: 'hi' })).toEqual([
      { role: 'system', content: 'Be terse' },
      { role: 'user', content: 'hi' },
    ]);
  });
});

describe('summarizeTimings', () => {
  it('computes ttft, total, and rate', () => {
    const t = summarizeTimings({ startedAt: 1000, firstChunkAt: 1200, endedAt: 3000, text: 'abcdefghij' });
    expect(t.ttftMs).toBe(200);
    expect(t.totalMs).toBe(2000);
    expect(t.chars).toBe(10);
    expect(t.charsPerSecond).toBe(5); // 10 chars / 2s
  });

  it('reports null ttft when no chunk ever arrived', () => {
    const t = summarizeTimings({ startedAt: 1000, firstChunkAt: null, endedAt: 2000, text: '' });
    expect(t.ttftMs).toBeNull();
  });

  it('reports null rate (not a char count) for a zero-duration run', () => {
    const t = summarizeTimings({ startedAt: 1000, firstChunkAt: 1000, endedAt: 1000, text: 'hello' });
    expect(t.totalMs).toBe(0);
    expect(t.charsPerSecond).toBeNull();
  });
});

describe('extractStreamDelta', () => {
  it('parses an OpenAI-style content delta', () => {
    const line = 'data: {"choices":[{"delta":{"content":"Hi"}}]}';
    expect(extractStreamDelta(line)).toEqual({ content: 'Hi', reasoning: '' });
  });

  it('parses a reasoning delta', () => {
    const line = 'data: {"choices":[{"delta":{"reasoning":"thinking"}}]}';
    expect(extractStreamDelta(line)).toEqual({ content: '', reasoning: 'thinking' });
  });

  it('skips non-data lines and the [DONE]/✅ sentinels', () => {
    expect(extractStreamDelta(': keep-alive')).toBeNull();
    expect(extractStreamDelta('data: [DONE]')).toBeNull();
    expect(extractStreamDelta('data: ✅')).toBeNull();
    expect(extractStreamDelta('')).toBeNull();
  });

  it('skips a malformed frame instead of throwing (one bad frame must not abort the stream)', () => {
    expect(extractStreamDelta('data: {not json')).toBeNull();
  });

  it('tolerates a frame with no delta', () => {
    expect(extractStreamDelta('data: {"choices":[{}]}')).toEqual({ content: '', reasoning: '' });
  });
});
