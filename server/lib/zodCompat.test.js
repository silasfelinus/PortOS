import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { partialWithoutDefaults } from './zodCompat.js';

describe('partialWithoutDefaults', () => {
  const base = z.object({
    enabled: z.boolean().default(false),
    debounceMs: z.number().int().min(800).max(30_000).default(2500),
    note: z.string().optional().default(''),
    nick: z.string().nullable().default('anon'),
    name: z.string().min(1), // no default
  });

  it('omits keys the caller did not send (no injected defaults)', () => {
    const schema = partialWithoutDefaults(base);
    expect(schema.parse({})).toEqual({});
    expect(schema.parse({ debounceMs: 3000 })).toEqual({ debounceMs: 3000 });
  });

  it('preserves field bounds/refinements after stripping the default', () => {
    const schema = partialWithoutDefaults(base);
    expect(schema.safeParse({ debounceMs: 100 }).success).toBe(false); // < min
    expect(schema.safeParse({ enabled: 'yes' }).success).toBe(false); // not boolean
    expect(schema.safeParse({ name: '' }).success).toBe(false); // min(1)
  });

  it('keeps optional/nullable wrappers while removing the default', () => {
    const schema = partialWithoutDefaults(base);
    // optional() field: sending null is rejected (not nullable), absent is fine
    expect(schema.safeParse({ note: 'hi' }).success).toBe(true);
    // nullable() field: explicit null is accepted, but no default is injected
    expect(schema.parse({ nick: null })).toEqual({ nick: null });
    expect(schema.parse({})).toEqual({});
  });

  it('makes every field optional (like .partial())', () => {
    const schema = partialWithoutDefaults(base);
    // `name` has no default and no .optional() on the base, but partial makes it optional
    expect(schema.safeParse({}).success).toBe(true);
  });

  it('contrasts with Zod 4 .partial(), which keeps inner defaults', () => {
    // Documents the behavior this helper exists to avoid: stock .partial()
    // still injects the defaults for omitted fields in Zod 4.
    expect(base.partial().parse({})).toMatchObject({ enabled: false, debounceMs: 2500 });
    // The helper does not:
    expect(partialWithoutDefaults(base).parse({})).toEqual({});
  });
});
