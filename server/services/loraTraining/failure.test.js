import { describe, it, expect } from 'vitest';
import { classifyTrainingFailure } from './failure.js';

describe('classifyTrainingFailure', () => {
  it('prefers the trainer-reported USER_ERROR', () => {
    const out = classifyTrainingFailure({
      userError: { kind: 'DATASET_ERROR', message: 'manifest contains no images' },
      stderrTail: ['CUDA out of memory'], // would otherwise classify as OOM
    });
    expect(out).toEqual({ code: 'DATASET_ERROR', message: 'manifest contains no images' });
  });

  it('classifies OOM variants', () => {
    for (const line of ['MPS backend out of memory', 'CUDA out of memory. Tried to allocate']) {
      expect(classifyTrainingFailure({ stderrTail: [line] }).code).toBe('OOM');
    }
  });

  it('classifies missing modules and HF auth', () => {
    expect(classifyTrainingFailure({ stderrTail: ["ModuleNotFoundError: No module named 'peft'"] }).code)
      .toBe('MODULE_NOT_FOUND');
    expect(classifyTrainingFailure({ stderrTail: ['GatedRepoError: 403'] }).code).toBe('HF_AUTH');
  });

  it('flags SIGKILL as memory reclaim', () => {
    expect(classifyTrainingFailure({ signal: 'SIGKILL' }).code).toBe('KILLED');
  });

  it('falls back to a generic message with the stderr tail', () => {
    const out = classifyTrainingFailure({ exitCode: 1, stderrTail: ['Traceback', 'ValueError: bad shape'] });
    expect(out.code).toBe('TRAINING_FAILED');
    expect(out.message).toContain('ValueError: bad shape');
    expect(out.message).toContain('code 1');
  });
});
