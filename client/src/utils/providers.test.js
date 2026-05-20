import { describe, it, expect } from 'vitest';
import {
  CODEX_CONFIGURED_DEFAULT,
  filterSelectableModels,
  isTuiProvider,
  isCliProvider,
  isProcessProvider,
  providerTypeClass,
} from './providers.js';

describe('filterSelectableModels', () => {
  it('drops the codex-configured-default sentinel', () => {
    expect(filterSelectableModels(['gpt-4', CODEX_CONFIGURED_DEFAULT, 'gpt-5'])).toEqual(['gpt-4', 'gpt-5']);
  });

  it('returns an empty array for null/undefined input', () => {
    expect(filterSelectableModels(null)).toEqual([]);
    expect(filterSelectableModels(undefined)).toEqual([]);
  });

  it('passes lists through unchanged when no sentinel present', () => {
    expect(filterSelectableModels(['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('provider type predicates', () => {
  const tui = { type: 'tui' };
  const cli = { type: 'cli' };
  const api = { type: 'api' };

  it('isTuiProvider matches only tui providers', () => {
    expect(isTuiProvider(tui)).toBe(true);
    expect(isTuiProvider(cli)).toBe(false);
    expect(isTuiProvider(api)).toBe(false);
  });

  it('isCliProvider matches only cli providers', () => {
    expect(isCliProvider(cli)).toBe(true);
    expect(isCliProvider(tui)).toBe(false);
    expect(isCliProvider(api)).toBe(false);
  });

  it('isProcessProvider matches cli and tui but not api', () => {
    expect(isProcessProvider(cli)).toBe(true);
    expect(isProcessProvider(tui)).toBe(true);
    expect(isProcessProvider(api)).toBe(false);
  });

  it('all predicates safely return false for nullish input', () => {
    expect(isTuiProvider(null)).toBe(false);
    expect(isTuiProvider(undefined)).toBe(false);
    expect(isCliProvider(null)).toBe(false);
    expect(isProcessProvider(null)).toBe(false);
  });
});

describe('providerTypeClass', () => {
  it('returns blue chip for cli', () => {
    expect(providerTypeClass('cli')).toBe('bg-blue-500/20 text-blue-400');
  });

  it('returns emerald chip for tui', () => {
    expect(providerTypeClass('tui')).toBe('bg-emerald-500/20 text-emerald-400');
  });

  it('falls back to purple chip for api/unknown', () => {
    expect(providerTypeClass('api')).toBe('bg-purple-500/20 text-purple-400');
    expect(providerTypeClass('mystery')).toBe('bg-purple-500/20 text-purple-400');
  });
});
