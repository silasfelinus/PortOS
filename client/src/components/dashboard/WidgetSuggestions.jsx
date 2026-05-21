import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { WIDGETS } from './widgetRegistry.jsx';

// Surfaces "Add <Widget>?" chips for widgets whose data source is populated
// (gate(state) returns true) but that aren't in `presentWidgetIds`.
// Dismissal is per-mount; persistence is deferred until the suggestion
// catalog outgrows the 3 gated widgets we ship today.
export default function WidgetSuggestions({ presentWidgetIds, dashboardState, onAdd }) {
  const [dismissed, setDismissed] = useState(() => new Set());
  // Only one in-flight save at a time. Without this, two rapid clicks each
  // compute their merge from the same stale `presentWidgetIds`, and the
  // second PUT's payload drops the first added widget. Gating on submission
  // forces the second click to wait for the parent's `presentWidgetIds` to
  // refresh after the first save resolves.
  const [submitting, setSubmitting] = useState(false);

  const suggestions = useMemo(() => {
    if (!Array.isArray(presentWidgetIds)) return [];
    const present = new Set(presentWidgetIds);
    return WIDGETS.filter((w) => {
      if (!w.gate) return false;
      if (present.has(w.id)) return false;
      if (dismissed.has(w.id)) return false;
      return Boolean(w.gate(dashboardState));
    });
  }, [presentWidgetIds, dashboardState, dismissed]);

  if (suggestions.length === 0) return null;

  const dismiss = (id) => setDismissed((prev) => {
    const next = new Set(prev);
    next.add(id);
    return next;
  });

  const add = (id) => {
    if (submitting) return;
    setSubmitting(true);
    Promise.resolve(onAdd(id))
      .catch(() => {})
      .finally(() => setSubmitting(false));
  };

  return (
    <div className="rounded-lg border border-port-border bg-port-card/60 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-400 uppercase tracking-wide pr-1">Suggested</span>
        {suggestions.map((w) => (
          <span key={w.id} className="inline-flex items-center gap-1 rounded-full border border-port-accent/40 bg-port-accent/10 pl-2 pr-1 py-0.5 text-xs text-gray-200">
            <button
              type="button"
              onClick={() => add(w.id)}
              disabled={submitting}
              className="inline-flex items-center gap-1 text-port-accent hover:text-white disabled:opacity-50 disabled:cursor-wait"
              aria-label={`Add ${w.label} to layout`}
            >
              <Plus size={12} aria-hidden="true" />
              <span>Add {w.label}?</span>
            </button>
            <button
              type="button"
              onClick={() => dismiss(w.id)}
              disabled={submitting}
              className="p-0.5 rounded text-gray-500 hover:text-gray-300 disabled:opacity-50"
              aria-label={`Dismiss ${w.label} suggestion`}
              title="Hide this suggestion"
            >
              <X size={11} aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
