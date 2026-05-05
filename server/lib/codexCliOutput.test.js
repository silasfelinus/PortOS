import { describe, expect, it } from 'vitest';
import { createCodexStderrFormatter } from './codexCliOutput.js';

describe('createCodexStderrFormatter', () => {
  it('drops Codex startup prompt echo and keeps the real runtime error', () => {
    const formatter = createCodexStderrFormatter();

    const lines = formatter.processChunk(`Reading prompt from stdin...
OpenAI Codex v0.125.0 (research preview)
--------
workdir: /repo
model: gpt-5
provider: openai
approval: never
sandbox: workspace-write
reasoning effort: high
session id: abc
--------
user
PortOS intentionally omits authentication in this deployment.
Begin working now.
ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5' model is not supported when using Codex with a ChatGPT account."}}
`);

    expect(lines).toEqual([
      'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5\' model is not supported when using Codex with a ChatGPT account."}}'
    ]);
  });

  it('summarizes Codex exec lines without retaining command output', () => {
    const formatter = createCodexStderrFormatter();

    const lines = formatter.processChunk("exec bash -lc 'npm test' in /repo succeeded in 2s:\nlong command output\n");

    expect(lines).toEqual(['🔧 npm test']);
  });

  it('does not leak prompt lines containing error keywords before the separator', () => {
    const formatter = createCodexStderrFormatter();

    const lines = formatter.processChunk(`Reading prompt from stdin...
OpenAI Codex v0.125.0 (research preview)
--------
workdir: /repo
model: gpt-4o
provider: openai
approval: never
sandbox: workspace-write
session id: abc
--------
user
Debug why the api key is not working and why the model is not supported.
`);

    expect(lines).toEqual([]);
  });

  it('emits a real ERROR: line that arrives after the separator', () => {
    const formatter = createCodexStderrFormatter();

    const lines = formatter.processChunk(`Reading prompt from stdin...
OpenAI Codex v0.125.0 (research preview)
--------
workdir: /repo
model: gpt-4o
provider: openai
approval: never
sandbox: workspace-write
session id: abc
--------
user
Some normal prompt text.
ERROR: {"type":"error","status":401,"error":{"type":"invalid_request_error","message":"api key not valid"}}
`);

    expect(lines).toEqual([
      'ERROR: {"type":"error","status":401,"error":{"type":"invalid_request_error","message":"api key not valid"}}'
    ]);
  });

  it('formats exec lines after the separator as tool emoji', () => {
    const formatter = createCodexStderrFormatter();

    const lines = formatter.processChunk(`Reading prompt from stdin...
OpenAI Codex v0.125.0 (research preview)
--------
workdir: /repo
model: gpt-4o
provider: openai
approval: never
sandbox: workspace-write
session id: abc
--------
user
Some prompt.
exec /bin/bash -lc 'ls -la' in /repo succeeded in 0.5s:
file output
`);

    expect(lines).toEqual(['🔧 ls -la']);
  });
});
