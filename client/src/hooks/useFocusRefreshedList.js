import { useState, useEffect, useRef } from 'react';

// Shared sidebar-list fetch pattern: load once on mount, refresh on window
// focus (debounced 30s so tab-switching doesn't hammer the API), and guard
// against re-rendering the consumer when the list is unchanged via an
// id|name signature compare. Sorts by name (case-insensitive) so the caller
// always receives a stable, display-ready array.
//
// `fetchFn` must accept `{ silent: true }` (it owns its own error handling via
// the warn below, so the API helper should not also toast) and resolve to an
// array. Pass a stable function reference (a module-level `api.*` export is
// stable). The `signature`/`label` options are read through refs so an inline
// arrow doesn't re-arm the effect (and double-fetch) on every render.
const defaultSignature = (item) => `${item.id}|${item.name}`;
const byName = (a, b) =>
  (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });

export function useFocusRefreshedList(fetchFn, { signature = defaultSignature, label = 'list' } = {}) {
  const [items, setItems] = useState([]);
  const signatureRef = useRef(signature);
  signatureRef.current = signature;
  const labelRef = useRef(label);
  labelRef.current = label;
  useEffect(() => {
    let lastSuccessAt = 0;
    let cancelled = false;
    const sigOf = (list) => list.map((item) => signatureRef.current(item)).join('||');
    const load = () => {
      fetchFn({ silent: true })
        .then((result) => {
          if (cancelled) return;
          lastSuccessAt = Date.now();
          const next = (Array.isArray(result) ? result : []).slice().sort(byName);
          setItems((prev) => (sigOf(prev) === sigOf(next) ? prev : next));
        })
        .catch((err) => {
          console.warn(`⚠️ Sidebar ${labelRef.current} fetch failed: ${err?.message || err}`);
        });
    };
    load();
    const onFocus = () => {
      if (Date.now() - lastSuccessAt < 30_000) return;
      load();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [fetchFn]);
  return items;
}
