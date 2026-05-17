import { useCallback, useEffect, useState } from 'react';
import { listMediaAnnotations, setMediaAnnotation } from '../services/api';
import socket from '../services/socket';
import toast from '../components/ui/Toast';

// Per-entry: `own`/`others` from the server, plus back-compat aliases
// (`starred`/`note`/`updatedAt` = local author) and `anyNote` for the
// card-level "has notes" indicator (true when any author has a note).
function enrich(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const own = entry.own || null;
  const others = Array.isArray(entry.others) ? entry.others : [];
  return {
    own,
    others,
    starred: !!own?.starred,
    note: own?.note ?? '',
    updatedAt: own?.updatedAt ?? null,
    anyStarred: !!own?.starred || others.some((o) => o.starred),
    anyNote: !!(own?.note) || others.some((o) => o.note),
  };
}

function enrichAll(raw) {
  const out = {};
  for (const [key, entry] of Object.entries(raw || {})) {
    const e = enrich(entry);
    if (e) out[key] = e;
  }
  return out;
}

export function useMediaAnnotations() {
  const [annotations, setAnnotations] = useState({});

  useEffect(() => {
    let cancelled = false;
    listMediaAnnotations().then(
      (res) => { if (!cancelled) setAnnotations(enrichAll(res?.annotations)); },
      () => { /* fallback to empty map — non-fatal */ },
    );
    return () => { cancelled = true; };
  }, []);

  // Mirror server broadcasts so a note/star toggle in one view (or browser tab,
  // or a peer's machine via the sharing pipeline) shows up in every other open
  // consumer. The originator also receives this; the server entry is
  // authoritative and overrides the optimistic merge.
  useEffect(() => {
    const onUpdate = ({ key, entry }) => {
      if (!key) return;
      setAnnotations((prev) => {
        const next = { ...prev };
        const enriched = enrich(entry);
        if (enriched) next[key] = enriched;
        else delete next[key];
        return next;
      });
    };
    socket.on('media:annotation:updated', onUpdate);
    return () => socket.off('media:annotation:updated', onUpdate);
  }, []);

  const updateAnnotation = useCallback(async (key, patch) => {
    let prior;
    setAnnotations((prev) => {
      prior = prev[key];
      const priorOwn = prior?.own ?? null;
      const mergedOwn = {
        authorName: priorOwn?.authorName ?? '',
        starred: 'starred' in patch ? patch.starred : (priorOwn?.starred ?? false),
        note: 'note' in patch ? patch.note : (priorOwn?.note ?? ''),
        updatedAt: new Date().toISOString(),
      };
      const others = prior?.others ?? [];
      const ownEmpty = !mergedOwn.starred && !mergedOwn.note;
      const nextEntry = enrich({
        own: ownEmpty ? null : mergedOwn,
        others,
      });
      const next = { ...prev };
      if (!nextEntry || (!nextEntry.own && nextEntry.others.length === 0)) delete next[key];
      else next[key] = nextEntry;
      return next;
    });
    const res = await setMediaAnnotation(key, patch).catch((err) => {
      toast.error(err?.message || 'Failed to save annotation');
      setAnnotations((prev) => {
        const reverted = { ...prev };
        if (prior) reverted[key] = prior;
        else delete reverted[key];
        return reverted;
      });
      return null;
    });
    return res?.entry ?? null;
  }, []);

  // Reads prior starred state from the functional setter so the callback's
  // identity doesn't change on every annotations update (otherwise every
  // MediaCard receives a new `onToggleStar` prop after each star flip).
  const toggleStar = useCallback((item) => {
    if (!item?.key) return;
    setAnnotations((prev) => {
      updateAnnotation(item.key, { starred: !prev[item.key]?.own?.starred });
      return prev;
    });
  }, [updateAnnotation]);

  return { annotations, toggleStar, updateAnnotation };
}
