import { useCallback } from 'react';
import toast from '../components/ui/Toast';

// Scaffolding for LLM-driven universe mutations that follow the
// "guarded API call → setWorlds → stale-write-checked setDraft" pattern.
//
// Used by handlePromoteVariation + handleAutoSort in UniverseBuilder.jsx.
// Both: (1) require the universe to be saved, (2) need a page-level
// re-entrancy guard, (3) show a loading toast that flips to success/error,
// (4) always update the cached worlds list when the server returns a new
// universe (even across navigation), and (5) only mutate the local draft
// when the user is still on the same universe (stale-write guard).
//
// handleGenerateInCategory is intentionally NOT a consumer — it does an
// eager local merge first and then a best-effort save, so the guard /
// loading-toast / required-savedId shape doesn't fit. Extracting just its
// setWorlds line through this hook would be more abstraction than savings.
//
// Contract for `action`:
//   - Receives `capturedId` (the selectedId at call time).
//   - Pass `{ silent: true }` to the underlying API helper so toasts only
//     fire from this hook (per CLAUDE.md "Custom catch ⇒ silent: true").
//   - Resolve with `{ universe, ... }`; reject with an Error whose message
//     is user-displayable.
//
// Contract for `onFreshResult`:
//   - Called only when the user is still on the same universe at result time.
//   - Caller does its own selective `setDraft` here (different actions touch
//     different fields — promote rewrites canon arrays + one category, autoSort
//     rewrites only reclassified buckets).
//   - Return a string to use as the success toast, or null/void to suppress it.
export default function useUniverseAction({ selectedId, mountedRef, setWorlds }) {
  return useCallback(async function runUniverseAction({
    ref,
    setBusy,
    loadingMessage,
    errorPrefix = 'Action failed',
    notSavedMessage = 'Save the universe first',
    action,
    onFreshResult,
  }) {
    if (!selectedId) {
      toast.error(notSavedMessage);
      return null;
    }
    if (ref?.current) return null;
    if (ref) ref.current = true;
    setBusy?.(true);
    const capturedId = selectedId;
    const toastId = loadingMessage ? toast.loading(loadingMessage) : null;

    const result = await action(capturedId).catch((e) => {
      if (toastId) toast.dismiss(toastId);
      toast.error(`${errorPrefix}: ${e.message}`);
      return null;
    });

    if (mountedRef.current) {
      if (ref) ref.current = false;
      setBusy?.(false);
    }

    if (!result?.universe) {
      if (toastId) toast.dismiss(toastId);
      return result;
    }

    // Always update the cached worlds list — even if the user navigated
    // away mid-flight, the persisted shape changed and other surfaces
    // (list page, palette) should see it.
    const updated = result.universe;
    setWorlds((prev) => {
      const without = prev.filter((w) => w.id !== updated.id);
      return [updated, ...without];
    });

    if (!mountedRef.current || capturedId !== selectedId) {
      if (toastId) toast.dismiss(toastId);
      return result;
    }

    const successMessage = onFreshResult ? onFreshResult(result, { capturedId }) : null;
    if (toastId) toast.dismiss(toastId);
    if (typeof successMessage === 'string' && successMessage) toast.success(successMessage);
    return result;
  }, [selectedId, mountedRef, setWorlds]);
}
