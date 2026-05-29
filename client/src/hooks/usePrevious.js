import { useEffect, useRef } from 'react';

/**
 * Returns the value from the previous render. On the first render, returns
 * `initialValue` (default `undefined`).
 *
 * Useful for "did this prop/state just change?" comparisons where the previous
 * value is needed to decide whether to fire a side effect. The snapshot is
 * updated in a `useEffect`, so within a render the returned value reflects the
 * prior committed value — exactly the contract a compare-and-act block expects.
 */
export function usePrevious(value, initialValue) {
  const ref = useRef(initialValue);
  useEffect(() => { ref.current = value; }, [value]);
  return ref.current;
}
