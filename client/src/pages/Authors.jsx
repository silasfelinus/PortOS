/**
 * Authors page — manage reusable author personas.
 *
 * An Author is a creative persona used as a series' cover byline and as the
 * prompt source for a book-cover author headshot. Each carries a name, writing
 * style, bio, a physical description + style direction for the headshot, and an
 * optional headshot image pointer.
 *
 * Master-detail: a selectable list on the left, an editor on the right. Picking
 * an author loads it into the editor; "New Author" opens a blank create form.
 */

import { useEffect, useMemo, useState } from 'react';
import { FilePen, Plus, Loader2, Trash2, Save } from 'lucide-react';
import toast from '../components/ui/Toast';
import {
  listAuthors, createAuthor, updateAuthor, deleteAuthor,
  AUTHOR_NAME_MAX, AUTHOR_WRITING_STYLE_MAX, AUTHOR_BIO_MAX,
  AUTHOR_PHYSICAL_DESCRIPTION_MAX, AUTHOR_HEADSHOT_STYLE_MAX, AUTHOR_HEADSHOT_IMAGE_URL_MAX,
} from '../services/api';

const emptyForm = () => ({
  name: '', writingStyle: '', bio: '', physicalDescription: '', headshotStyle: '', headshotImageUrl: '',
});

const formFromAuthor = (a) => ({
  name: a.name || '',
  writingStyle: a.writingStyle || '',
  bio: a.bio || '',
  physicalDescription: a.physicalDescription || '',
  headshotStyle: a.headshotStyle || '',
  headshotImageUrl: a.headshotImageUrl || '',
});

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wider text-gray-500 mb-1">{label}</span>
      {children}
      {hint ? <span className="block text-[11px] text-gray-500 mt-1">{hint}</span> : null}
    </label>
  );
}

export default function Authors() {
  const [authors, setAuthors] = useState([]);
  const [loading, setLoading] = useState(true);
  // selectedId === 'new' is create mode; a real id is edit mode; null is idle.
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    listAuthors()
      .then((list) => setAuthors(Array.isArray(list) ? list : []))
      .catch((err) => toast.error(err.message || 'Failed to load authors'))
      .finally(() => setLoading(false));
  }, []);

  const isCreate = selectedId === 'new';
  const selected = useMemo(
    () => (isCreate || !selectedId ? null : authors.find((a) => a.id === selectedId) || null),
    [authors, selectedId, isCreate],
  );

  const selectAuthor = (a) => {
    setSelectedId(a.id);
    setForm(formFromAuthor(a));
    setConfirmDelete(false);
  };

  const startCreate = () => {
    setSelectedId('new');
    setForm(emptyForm());
    setConfirmDelete(false);
  };

  const handleSave = async () => {
    const name = form.name.trim();
    if (!name) { toast.error('Author name is required'); return; }
    setSaving(true);
    const payload = { ...form, name };
    if (isCreate) {
      const created = await createAuthor(payload).catch((err) => {
        toast.error(err.message || 'Failed to create author');
        return null;
      });
      setSaving(false);
      if (!created) return;
      setAuthors((prev) => [...prev, created].sort((a, b) => (a.name || '').localeCompare(b.name || '')));
      setSelectedId(created.id);
      toast.success(`Created "${created.name}"`);
    } else {
      const updated = await updateAuthor(selectedId, payload).catch((err) => {
        toast.error(err.message || 'Failed to save author');
        return null;
      });
      setSaving(false);
      if (!updated) return;
      setAuthors((prev) => prev
        .map((a) => (a.id === updated.id ? updated : a))
        .sort((a, b) => (a.name || '').localeCompare(b.name || '')));
      toast.success('Saved');
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    const prior = authors;
    setAuthors((prev) => prev.filter((a) => a.id !== selected.id));
    setSelectedId(null);
    setConfirmDelete(false);
    await deleteAuthor(selected.id).catch((err) => {
      toast.error(err.message || 'Delete failed');
      setAuthors(prior);
    });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <FilePen className="w-6 h-6 text-port-accent" />
          <h1 className="text-2xl font-bold text-white">Authors</h1>
        </div>
        <button
          type="button"
          onClick={startCreate}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent hover:bg-port-accent/90 text-white text-sm font-medium"
        >
          <Plus size={16} aria-hidden="true" />
          New Author
        </button>
      </div>

      <p className="text-sm text-gray-400 mb-6">
        Author personas are reusable across series — the cover byline plus the writing voice, bio, and the
        physical description + style used to generate a book-cover author headshot. Link one to a series from
        the Series Pipeline.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4">
        <div className="bg-port-card border border-port-border rounded-lg p-2">
          {loading ? (
            <div className="text-gray-500 text-sm p-2">Loading…</div>
          ) : authors.length === 0 ? (
            <div className="text-gray-500 text-sm p-2">No authors yet. Click <span className="text-port-accent">New Author</span>.</div>
          ) : (
            <ul className="space-y-1">
              {authors.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => selectAuthor(a)}
                    className={`w-full text-left px-3 py-2 rounded text-sm truncate ${
                      a.id === selectedId ? 'bg-port-accent/20 text-white' : 'text-gray-300 hover:bg-port-bg'
                    }`}
                  >
                    {a.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-port-card border border-port-border rounded-lg p-4">
          {!isCreate && !selected ? (
            <div className="text-gray-500 text-sm">Select an author to edit, or create a new one.</div>
          ) : (
            <div className="space-y-3">
              <Field label="Name">
                <input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Jane Doe"
                  maxLength={AUTHOR_NAME_MAX}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                  autoFocus
                />
              </Field>
              <Field label="Writing style" hint="Voice / tone / craft notes — fed into stage prompts.">
                <textarea
                  value={form.writingStyle}
                  onChange={(e) => setForm((f) => ({ ...f, writingStyle: e.target.value }))}
                  rows={4}
                  maxLength={AUTHOR_WRITING_STYLE_MAX}
                  placeholder="Spare, noir-tinged prose; short declarative sentences; dry wit."
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
                />
              </Field>
              <Field label="Bio" hint="About-the-author blurb for the back cover.">
                <textarea
                  value={form.bio}
                  onChange={(e) => setForm((f) => ({ ...f, bio: e.target.value }))}
                  rows={4}
                  maxLength={AUTHOR_BIO_MAX}
                  placeholder="Jane Doe is the author of…"
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
                />
              </Field>
              <Field label="Physical description" hint="Subject of the cover headshot — appearance, age, expression.">
                <textarea
                  value={form.physicalDescription}
                  onChange={(e) => setForm((f) => ({ ...f, physicalDescription: e.target.value }))}
                  rows={3}
                  maxLength={AUTHOR_PHYSICAL_DESCRIPTION_MAX}
                  placeholder="Woman in her 40s, silver-streaked dark hair, warm gaze, slight smile."
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
                />
              </Field>
              <Field label="Headshot style" hint="Art / photography direction for the headshot render.">
                <textarea
                  value={form.headshotStyle}
                  onChange={(e) => setForm((f) => ({ ...f, headshotStyle: e.target.value }))}
                  rows={3}
                  maxLength={AUTHOR_HEADSHOT_STYLE_MAX}
                  placeholder="Studio portrait, soft Rembrandt lighting, muted background, 85mm."
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
                />
              </Field>
              <Field label="Headshot image URL" hint="Optional — a chosen/generated headshot to use on covers.">
                <input
                  value={form.headshotImageUrl}
                  onChange={(e) => setForm((f) => ({ ...f, headshotImageUrl: e.target.value }))}
                  placeholder="/images/…  or  https://…"
                  maxLength={AUTHOR_HEADSHOT_IMAGE_URL_MAX}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                />
              </Field>

              <div className="flex items-center gap-2 pt-1 flex-wrap">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || !form.name.trim()}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  {isCreate ? 'Create' : 'Save'}
                </button>
                {!isCreate && selected ? (
                  confirmDelete ? (
                    <span className="inline-flex items-center gap-2 text-sm">
                      <span className="text-port-error">Delete this author?</span>
                      <button type="button" onClick={handleDelete} className="px-2 py-1 rounded bg-port-error/20 text-port-error hover:bg-port-error/30">
                        Yes, delete
                      </button>
                      <button type="button" onClick={() => setConfirmDelete(false)} className="px-2 py-1 rounded text-gray-400 hover:text-white">
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-gray-400 hover:text-port-error text-sm"
                    >
                      <Trash2 size={14} /> Delete
                    </button>
                  )
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
