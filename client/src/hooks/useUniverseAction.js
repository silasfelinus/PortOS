import { useCallback } from 'react';
import toast from '../components/ui/Toast';

// Scaffolding for LLM-driven universe mutations that follow the
// "guarded API call → setWorlds → stale-write-checked setDraft" pattern.
// Used by handlePromoteVariation + handleAutoSort in UniverseBuilder.jsx.
//
// handleGenerateInCategory is intentionally NOT a consumer — it does an
// eager local merge first and then a best-effort save, so the guard /
// loading-toast / required-savedId shape doesn't fit. Forcing it through
// would warp it for almost no shared scaffolding.
//
// `action(capturedId)` must pass `{ silent: true }` to its API helper so
// toasts only fire from this hook (per CLAUDE.md "Custom catch ⇒ silent").
// `onFreshResult(result, { capturedId })` runs only when the user is still
// on the same universe; return a string to use as the success toast.
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
