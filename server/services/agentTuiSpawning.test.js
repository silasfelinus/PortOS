import { describe, it, expect } from 'vitest';
import { buildTuiSpawnConfig } from './agentTuiSpawning.js';

describe('agent TUI spawning', () => {
  it('builds a codex TUI command without a model flag for the configured-default sentinel', () => {
    const config = buildTuiSpawnConfig({
      id: 'codex-tui',
      name: 'Codex TUI',
      type: 'tui',
      command: 'codex',
      args: []
    }, 'codex-configured-default');

    expect(config.command).toBe('codex');
    expect(config.args).toEqual([]);
    expect(config.commandLine).toBe('codex');
  });

  it('quotes TUI arguments and carries idle timing config', () => {
    const config = buildTuiSpawnConfig({
      id: 'claude-code-tui',
      name: 'Claude TUI',
      type: 'tui',
      command: 'claude',
      args: ['--dangerously-skip-permissions', '--add-dir', '/tmp/with space'],
      tuiPromptDelayMs: 1000,
      tuiIdleTimeoutMs: 30000
    }, 'claude-sonnet');

    expect(config.args).toEqual([
      '--dangerously-skip-permissions',
      '--add-dir',
      '/tmp/with space',
      '--model',
      'claude-sonnet'
    ]);
    expect(config.commandLine).toBe("claude --dangerously-skip-permissions --add-dir '/tmp/with space' --model claude-sonnet");
    expect(config.promptDelayMs).toBe(1000);
    expect(config.idleTimeoutMs).toBe(30000);
  });

  it('falls back to the default command via id heuristic when command is omitted', () => {
    const codexConfig = buildTuiSpawnConfig({ id: 'my-codex-instance', type: 'tui' }, null);
    expect(codexConfig.command).toBe('codex');

    const claudeConfig = buildTuiSpawnConfig({ id: 'whatever', type: 'tui' }, null);
    expect(claudeConfig.command).toBe('claude');
  });

  it('applies default prompt-delay and idle-timeout when the provider omits them', () => {
    const config = buildTuiSpawnConfig({ id: 'codex-tui', command: 'codex', type: 'tui' }, null);
    expect(config.promptDelayMs).toBe(2500);
    expect(config.idleTimeoutMs).toBe(180000);
  });

  it('omits the --model flag when model is null/empty', () => {
    const config = buildTuiSpawnConfig({ id: 'codex-tui', command: 'codex', type: 'tui', args: [] }, null);
    expect(config.args).toEqual([]);
    expect(config.commandLine).toBe('codex');
  });
});
