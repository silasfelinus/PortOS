/**
 * Catalog page — index of Creative Ingredients.
 *
 * Lists every ingredient (character/place/object/idea/scene/concept) the user
 * has captured into the catalog. Type chips along the top filter by kind and
 * show the per-type count from `/api/catalog/stats`. The "+ New" inline form
 * mirrors the Pipeline series-create pattern; "Ingest" links to the paste-and-
 * extract page. Delete uses an armed two-click confirm (no window.confirm).
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, Plus, Search, FileInput, Trash2, Loader2 } from 'lucide-react';
import toast from '../components/ui/Toast';
import {
  listCatalogIngredients,
  createCatalogIngredient,
  deleteCatalogIngredient,
  getCatalogStats,
} from '../services/apiCatalog';

const TYPES = [
  { id: 'character', label: 'Character', color: 'bg-blue-500/20 text-blue-300 border-blue-500/40' },
  { id: 'place',     label: 'Place',     color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' },
  { id: 'object',    label: 'Object',    color: 'bg-amber-500/20 text-amber-300 border-amber-500/40' },
  { id: 'idea',      label: 'Idea',      color: 'bg-purple-500/20 text-purple-300 border-purple-500/40' },
  { id: 'scene',     label: 'Scene',     color: 'bg-pink-500/20 text-pink-300 border-pink-500/40' },
  { id: 'concept',   label: 'Concept',   color: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40' },
];

const TYPE_BY_ID = Object.fromEntries(TYPES.map((t) => [t.id, t]));

// Per-type primary content key used by the inline "New" form, so users can
// capture the body in one step instead of bouncing into the editor. Mirrors
// the labels in CatalogIngredient.jsx — characters land in `physicalDescription`
// (canon shape), place/object in `description`, light types in `summary`.
const PRIMARY_CONTENT_KEY = {
  character: 'physicalDescription',
  place: 'description',
  object: 'description',
  idea: 'summary',
  scene: 'summary',
  concept: 'summary',
};
// Display label per content key — driven from PRIMARY_CONTENT_KEY so a future
// type→key remapping automatically picks up the right label and the form
// label can't silently lie about where content lands on submit.
const PRIMARY_CONTENT_LABEL = {
  physicalDescription: 'Physical Description',
  description: 'Description',
  summary: 'Summary',
};

// Pull a short snippet from the type-specific payload — first hit wins,
// trimmed and ellipsised to ~120 chars. Characters use `physicalDescription`
// (canon shape), so check it first to avoid rendering empty rows for
// bible-backfilled characters whose only narrative text lives there.
function payloadSnippet(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const raw = payload.physicalDescription || payload.description || payload.summary || payload.notes || '';
  const text = String(raw).trim().replace(/\s+/g, ' ');
  if (text.length <= 120) return text;
  return `${text.slice(0, 117)}…`;
}

function TypeBadge({ type }) {
  const meta = TYPE_BY_ID[type];
  if (!meta) return null;
  return (
    <span className={`inline-block text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border ${meta.color}`}>
      {meta.label}
    </span>
  );
}

export default function Catalog() {
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedType, setSelectedType] = useState('');
  // Two-stage search: `searchInput` is what the user is typing; `q` is the
  // debounced value that actually drives the list fetch. 300ms gap.
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  // Inline create form. `content` is a single freeform textarea that lands in
  // the per-type primary content field on submit (physicalDescription for
  // character, description for place/object, summary for idea/scene/concept)
  // so users don't have to navigate to the editor just to capture the body.
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ type: 'character', name: '', content: '' });
  const [creating, setCreating] = useState(false);
  // Armed-row id for two-click delete (no window.confirm).
  const [armedId, setArmedId] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const loadStats = useCallback(() => {
    getCatalogStats({ silent: true })
      .then((s) => setStats(s || null))
      .catch(() => {});
  }, []);

  const loadItems = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    listCatalogIngredients({
      type: selectedType || undefined,
      q: q || undefined,
      limit: 200,
      silent: true,
    })
      .then((data) => {
        if (cancelled) return;
        setItems(Array.isArray(data?.items) ? data.items : []);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        toast.error(err?.message || 'Failed to load catalog');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedType, q]);

  useEffect(() => loadItems(), [loadItems]);
  useEffect(() => loadStats(), [loadStats]);

  const totalCount = stats?.total ?? items.length;
  const countForType = (id) => stats?.byType?.[id] || 0;

  const handleCreate = async (e) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) return;
    const content = form.content.trim();
    const payload = {};
    if (content) {
      payload[PRIMARY_CONTENT_KEY[form.type] || 'description'] = content;
    }
    setCreating(true);
    const created = await createCatalogIngredient({
      type: form.type,
      name,
      payload,
      tags: [],
    }, { silent: true }).catch((err) => {
      toast.error(err?.message || 'Failed to create ingredient');
      return null;
    });
    setCreating(false);
    if (!created) return;
    toast.success(`Created ${form.type} "${name}"`);
    closeForm();
    // Update list locally (CLAUDE.md: prefer state update over refetch) but
    // still refresh stats so the type-chip counts move.
    setItems((prev) => [created, ...prev]);
    loadStats();
  };

  const confirmDelete = async (it) => {
    setArmedId(null);
    // Capture the original index so a failed delete restores in place rather
    // than jumping the row to the top of the list.
    const originalIdx = items.findIndex((x) => x.id === it.id);
    setItems((prev) => prev.filter((x) => x.id !== it.id));
    await deleteCatalogIngredient(it.id, { silent: true }).catch((err) => {
      toast.error(err?.message || 'Delete failed');
      setItems((prev) => {
        if (prev.some((x) => x.id === it.id)) return prev;
        const next = [...prev];
        next.splice(Math.max(0, originalIdx), 0, it);
        return next;
      });
    });
    loadStats();
  };

  // Single reset path used by Cancel + toolbar toggle + post-submit so all
  // three "form dismissed" paths leave the same clean state — without this,
  // stale name/content text reappears the next time the form opens.
  const closeForm = () => {
    setForm((f) => ({ type: f.type, name: '', content: '' }));
    setShowForm(false);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Sparkles className="w-6 h-6 text-port-accent" aria-hidden="true" />
          <h1 className="text-2xl font-bold text-white">Catalog</h1>
          <span className="text-sm text-gray-500">
            {totalCount} ingredient{totalCount === 1 ? '' : 's'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/catalog/ingest"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-port-border bg-port-card hover:bg-port-bg text-white text-sm font-medium"
          >
            <FileInput size={16} aria-hidden="true" />
            Ingest
          </Link>
          <button
            type="button"
            onClick={() => (showForm ? closeForm() : setShowForm(true))}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent hover:bg-port-accent/90 text-white text-sm font-medium"
          >
            <Plus size={16} aria-hidden="true" />
            New
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button
          type="button"
          onClick={() => setSelectedType('')}
          className={`text-xs px-3 py-1.5 rounded-full border ${
            selectedType === ''
              ? 'bg-port-accent border-port-accent text-white'
              : 'border-port-border text-gray-300 hover:text-white'
          }`}
        >
          All <span className="ml-1 text-[10px] opacity-70">{totalCount}</span>
        </button>
        {TYPES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSelectedType(selectedType === t.id ? '' : t.id)}
            className={`text-xs px-3 py-1.5 rounded-full border ${
              selectedType === t.id
                ? 'bg-port-accent border-port-accent text-white'
                : 'border-port-border text-gray-300 hover:text-white'
            }`}
          >
            {t.label} <span className="ml-1 text-[10px] opacity-70">{countForType(t.id)}</span>
          </button>
        ))}
      </div>

      <div className="relative mb-6">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" aria-hidden="true" />
        <label htmlFor="catalog-search" className="sr-only">Search catalog</label>
        <input
          id="catalog-search"
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by name, tag, or text…"
          className="w-full pl-9 pr-3 py-2 bg-port-card border border-port-border rounded-lg text-white text-sm focus:outline-none focus:border-port-accent"
        />
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="mb-6 p-4 bg-port-card border border-port-border rounded-lg space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr] gap-3">
            <div>
              <label htmlFor="catalog-new-type" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
                Type
              </label>
              <select
                id="catalog-new-type"
                value={form.type}
                onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
              >
                {TYPES.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="catalog-new-name" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
                Name
              </label>
              <input
                id="catalog-new-name"
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Echo Saint"
                maxLength={200}
                autoFocus
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
              />
            </div>
          </div>
          <div>
            <label htmlFor="catalog-new-content" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
              {PRIMARY_CONTENT_LABEL[PRIMARY_CONTENT_KEY[form.type]] || 'Description'}
              <span className="normal-case text-gray-500"> (optional)</span>
            </label>
            <textarea
              id="catalog-new-content"
              rows={4}
              value={form.content}
              onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
              placeholder="Capture the idea here — you can flesh it out in the editor."
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm focus:outline-none focus:border-port-accent"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={closeForm}
              className="px-3 py-2 rounded-lg text-gray-400 hover:text-white text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating || !form.name.trim()}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
            >
              {creating ? <Loader2 size={14} className="animate-spin" /> : null}
              Create
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="text-gray-500 text-sm">Loading catalog…</div>
      ) : items.length === 0 ? (
        <div className="bg-port-card border border-port-border rounded-lg p-8 text-center">
          <p className="text-sm text-gray-400">
            {q || selectedType
              ? 'No ingredients match the current filter.'
              : 'Your catalog is empty. Paste a scrap on the Ingest page or create one manually.'}
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {items.map((it) => {
            const armed = armedId === it.id;
            const name = it.name || '(untitled)';
            // The card is one big Link so clicking anywhere (name, badge, tags,
            // snippet, empty body) opens the editor. The delete control sits in
            // absolute-positioned overlay so it intercepts clicks before they
            // bubble to the link.
            return (
              <li key={it.id} className="relative bg-port-card border border-port-border rounded-lg hover:border-port-accent/60 transition-colors">
                <Link
                  to={`/catalog/${encodeURIComponent(it.type)}/${encodeURIComponent(it.id)}`}
                  className={`flex flex-col gap-2 p-3 min-h-[88px] ${armed ? 'pr-32' : 'pr-10'}`}
                >
                  <span className="block text-white font-medium truncate">{name}</span>
                  <span className="flex items-center gap-1.5 flex-wrap">
                    <TypeBadge type={it.type} />
                    {(it.tags || []).slice(0, 4).map((tag) => (
                      <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-port-bg border border-port-border text-gray-400">
                        {tag}
                      </span>
                    ))}
                  </span>
                  {payloadSnippet(it.payload) ? (
                    <span className="text-xs text-gray-400 line-clamp-3">{payloadSnippet(it.payload)}</span>
                  ) : null}
                </Link>
                <div className="absolute top-2 right-2">
                  {/* The delete control is a sibling of the <Link>, not a
                      descendant, so a click on these buttons never traverses
                      the anchor — no preventDefault/stopPropagation needed. */}
                  {armed ? (
                    <span className="inline-flex items-center gap-1 text-xs bg-port-card border border-port-border rounded px-1 py-0.5 shadow-sm">
                      <span className="text-gray-400 pl-1">Delete?</span>
                      <button
                        type="button"
                        onClick={() => confirmDelete(it)}
                        className="px-2 py-0.5 rounded bg-port-error/20 text-port-error hover:bg-port-error/30 font-medium"
                      >
                        Yes
                      </button>
                      <button
                        type="button"
                        onClick={() => setArmedId(null)}
                        className="px-2 py-0.5 rounded text-gray-400 hover:text-white"
                      >
                        No
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setArmedId(it.id)}
                      className="p-1.5 rounded text-gray-500 hover:text-port-error bg-port-card"
                      aria-label={`Delete ${name}`}
                      title="Delete ingredient"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
