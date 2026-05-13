import { useState } from 'react';
import { X } from 'lucide-react';
import { WORLD_INFLUENCE_ENTRY_MAX, WORLD_INFLUENCES_PER_LIST_MAX } from '../../services/api';

const TONE_CLASS = {
  success: 'bg-port-success/15 text-port-success border-port-success/40',
  error: 'bg-port-error/15 text-port-error border-port-error/40',
  accent: 'bg-port-accent/20 text-port-accent border-port-accent/40',
};

/**
 * Chip input for an influence list (embrace or avoid). Used by both the
 * inline World Builder editor and the Refine modal — extracting one
 * implementation keeps Enter/comma/paste/Backspace behavior, dedupe rules,
 * and per-entry caps in lockstep across both surfaces.
 *
 * `readOnly` collapses the editor to a plain chip preview (no input, no X
 * buttons) so locked influences render with the same chrome.
 */
export default function InfluenceChipsInput({
  tokens,
  onChange,
  tone = 'accent',
  placeholder = 'Add reference, press Enter',
  readOnly = false,
  emptyLabel = '(none)',
}) {
  const [input, setInput] = useState('');
  const safe = Array.isArray(tokens) ? tokens : [];
  const toneClass = TONE_CLASS[tone] || TONE_CLASS.accent;

  if (readOnly && safe.length === 0) {
    return <div className="text-[11px] text-gray-600">{emptyLabel}</div>;
  }

  const commit = (raw) => {
    const incoming = (raw || '')
      .split(/[,\n]/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => t.slice(0, WORLD_INFLUENCE_ENTRY_MAX));
    if (!incoming.length) return;
    const seen = new Set(safe.map((v) => v.toLowerCase()));
    const next = [...safe];
    for (const t of incoming) {
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(t);
      if (next.length >= WORLD_INFLUENCES_PER_LIST_MAX) break;
    }
    onChange(next);
    setInput('');
  };

  const removeAt = (idx) => onChange(safe.filter((_, i) => i !== idx));

  return (
    <div className={`flex flex-wrap items-center gap-1.5 p-2 bg-port-bg border border-port-border rounded ${readOnly ? 'opacity-70' : ''}`}>
      {safe.map((v, idx) => (
        <span
          key={`${v}-${idx}`}
          className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full border ${toneClass}`}
        >
          {v}
          {!readOnly && (
            <button
              type="button"
              onClick={() => removeAt(idx)}
              className="text-current/70 hover:text-current"
              aria-label={`Remove ${v}`}
            >
              <X size={11} />
            </button>
          )}
        </span>
      ))}
      {!readOnly && safe.length < WORLD_INFLUENCES_PER_LIST_MAX && (
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit(input);
            } else if (e.key === 'Backspace' && !input && safe.length) {
              onChange(safe.slice(0, -1));
            }
          }}
          onBlur={() => commit(input)}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            if (text && /[,\n]/.test(text)) {
              e.preventDefault();
              commit(text);
            }
          }}
          placeholder={placeholder}
          maxLength={WORLD_INFLUENCE_ENTRY_MAX}
          className="flex-1 min-w-[120px] bg-transparent text-sm text-white placeholder-gray-500 focus:outline-none"
        />
      )}
      {!readOnly && safe.length >= WORLD_INFLUENCES_PER_LIST_MAX && (
        <span className="text-[11px] text-gray-500">Max {WORLD_INFLUENCES_PER_LIST_MAX} reached</span>
      )}
    </div>
  );
}
