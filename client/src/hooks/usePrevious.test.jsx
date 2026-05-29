import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePrevious } from './usePrevious';

describe('usePrevious', () => {
  it('returns the initial value on the first render', () => {
    const { result } = renderHook(() => usePrevious('a', 'initial'));
    expect(result.current).toBe('initial');
  });

  it('returns undefined when no initial value is supplied', () => {
    const { result } = renderHook(() => usePrevious('a'));
    expect(result.current).toBeUndefined();
  });

  it('returns the previous render value on subsequent renders', () => {
    const { result, rerender } = renderHook(({ v }) => usePrevious(v, 'initial'), {
      initialProps: { v: 'a' },
    });
    expect(result.current).toBe('initial');

    rerender({ v: 'b' });
    expect(result.current).toBe('a');

    rerender({ v: 'c' });
    expect(result.current).toBe('b');
  });

  it('still returns the prior value across a re-render with the same value', () => {
    const { result, rerender } = renderHook(({ v }) => usePrevious(v), {
      initialProps: { v: 1 },
    });

    rerender({ v: 2 });
    expect(result.current).toBe(1);

    // Same value re-render: ref-update effect only fires when the dep changes,
    // so the snapshot stays at the previously-rendered value.
    rerender({ v: 2 });
    expect(result.current).toBe(2);
  });
});
