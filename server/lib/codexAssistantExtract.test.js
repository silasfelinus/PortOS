import { describe, it, expect } from 'vitest';
import { extractCodexAssistant } from './codexAssistantExtract.js';

describe('extractCodexAssistant', () => {
  it('returns text unchanged when there is no Codex banner', () => {
    const claudeOutput = 'Here is the comic script:\n\n## Page 1\n\nPanel 1...';
    expect(extractCodexAssistant(claudeOutput)).toBe(claudeOutput);
  });

  it('carves out the assistant reply between the prompt echo and the token footer', () => {
    const full = `OpenAI Codex v0.128.0 (research preview)
--------
workdir: /repo
model: gpt-5
provider: openai
--------
user
# Pipeline — Comic-Book Script

You are a comics writer...

Return ONLY the script.

codex
# Issue 1 — The Harvest Market

## Page 1

### Panel 1
**Description:** Wide establishing shot...

tokens used: 12345
`;
    const out = extractCodexAssistant(full);
    expect(out.startsWith('# Issue 1 — The Harvest Market')).toBe(true);
    expect(out).not.toContain('OpenAI Codex v');
    expect(out).not.toContain('You are a comics writer');
    expect(out).not.toContain('tokens used');
  });

  it('handles missing token-stats footer (response runs to EOF)', () => {
    const full = `OpenAI Codex v0.125.0 (research preview)
--------
workdir: /repo
--------
user
prompt body

codex
The assistant reply with no trailing token line.`;
    const out = extractCodexAssistant(full);
    expect(out).toBe('The assistant reply with no trailing token line.');
  });

  it('returns input untouched when the `codex` marker is missing (truncated run)', () => {
    const truncated = `OpenAI Codex v0.125.0 (research preview)
--------
workdir: /repo
--------
user
prompt body`;
    expect(extractCodexAssistant(truncated)).toBe(truncated);
  });

  it('returns empty / non-string input unchanged', () => {
    expect(extractCodexAssistant('')).toBe('');
    expect(extractCodexAssistant(null)).toBe(null);
    expect(extractCodexAssistant(undefined)).toBe(undefined);
  });
});
