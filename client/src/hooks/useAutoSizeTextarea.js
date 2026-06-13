import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Grow a <textarea> to fit its content so the field never scrolls or has to be
 * hand-resized. Attach the returned `ref` to the textarea; the height is
 * recomputed before paint whenever `value` changes. `resize` is returned for
 * the rare case the content changes without `value` (e.g. a font/width reflow)
 * — call it from a ResizeObserver or after a programmatic mutation.
 *
 * Set a floor with a `min-h-*` class on the textarea (CSS `min-height` floors
 * the inline height this hook sets), and pair it with `resize-none` /
 * `overflow-hidden` so the browser scrollbar never appears.
 */
export default function useAutoSizeTextarea(value) {
  const ref = useRef(null);
  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useLayoutEffect(() => { resize(); }, [value, resize]);
  return [ref, resize];
}
