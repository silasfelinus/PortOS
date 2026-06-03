import { describe, it, expect } from 'vitest';
import { runTestsInputSchema, runMultiTestsInputSchema } from './digitalTwinValidation.js';

// Regression guard: the client API wrappers default `testIds` to `null` for a
// "run all tests" request. A bare `.optional()` rejects null and would 400
// every UI-triggered run — the values-alignment panel always sends null.
describe('runTestsInputSchema testIds null-tolerance', () => {
  it('accepts testIds: null (run-all sentinel) and normalizes it away', () => {
    const parsed = runTestsInputSchema.parse({ providerId: 'p', model: 'm', testIds: null });
    expect(parsed.testIds).toBeUndefined();
  });

  it('accepts an explicit array of test ids', () => {
    const parsed = runTestsInputSchema.parse({ providerId: 'p', model: 'm', testIds: [1, 2] });
    expect(parsed.testIds).toEqual([1, 2]);
  });

  it('accepts an omitted testIds', () => {
    expect(runTestsInputSchema.parse({ providerId: 'p', model: 'm' }).testIds).toBeUndefined();
  });

  it('still rejects malformed test ids', () => {
    expect(runTestsInputSchema.safeParse({ providerId: 'p', model: 'm', testIds: ['x'] }).success).toBe(false);
  });

  it('tolerates null testIds on the multi-model schema too', () => {
    const parsed = runMultiTestsInputSchema.parse({
      providers: [{ providerId: 'p', model: 'm' }],
      testIds: null
    });
    expect(parsed.testIds).toBeUndefined();
  });
});
