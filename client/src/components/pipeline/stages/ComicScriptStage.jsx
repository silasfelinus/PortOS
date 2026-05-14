/**
 * Merged Comic Script + Comic Pages editor. The full markdown still lives on
 * `stages.comicScript.output` and the parsed page records still live on
 * `stages.comicPages.pages[]` — this component just folds them into one
 * page-by-page view: each page is an editable markdown slice on the left and
 * a full-page render on the right. Panels are still parsed internally so the
 * render prompt stays high-quality, but they're never shown.
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Sparkles, ImageIcon, Save, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import toast from '../../ui/Toast';
import {
  generatePipelineStage,
  extractPipelineComicPages,
  generatePipelineComicPage,
  updatePipelineComicPage,
  updatePipelineIssue,
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGE_STATUS_LABEL as STATUS_LABEL,
  PIPELINE_STAGE_STATUS_COLOR as STATUS_COLOR,
} from '../../../services/api';
import MediaJobThumb from '../MediaJobThumb';

// Reconstructs a page's markdown from its parsed `panels[]`. Used as a
// fallback for pages persisted BEFORE the parser started preserving rawText —
// without it those pages would render as empty textareas, and a Save click
// would PATCH an empty rawText and silently wipe the panels.
function panelsToMarkdown(panels, pageNumber) {
  const lines = [`## Page ${pageNumber}`, ''];
  (panels || []).forEach((p, i) => {
    lines.push(`### Panel ${i + 1}`);
    if (p.description) lines.push(`**Description:** ${p.description}`);
    if (p.caption) lines.push(`**Caption:** ${p.caption}`);
    if (Array.isArray(p.dialogue) && p.dialogue.length) {
      lines.push('**Dialogue:**');
      for (const d of p.dialogue) {
        const line = (d.line || '').trim();
        if (line) lines.push(`- ${(d.character || 'CHAR').trim() || 'CHAR'}: "${line}"`);
      }
    }
    if (p.sfx) lines.push(`**SFX:** ${p.sfx}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}

export default function ComicScriptStage({ issue, series, onStageUpdate }) {
  const script = issue.stages?.comicScript || { status: 'empty', output: '' };
  const comicPages = issue.stages?.comicPages || { status: 'empty', pages: [] };
  const pages = Array.isArray(comicPages.pages) ? comicPages.pages : [];
  const hasScript = !!(script.output || '').trim();

  const [localGenerating, setLocalGenerating] = useState(false);
  const [serverGenerating, setServerGenerating] = useState(script.status === 'generating');
  // Sync with auto-run status pushed in from outside this component.
  useEffect(() => { setServerGenerating(script.status === 'generating'); }, [script.status]);
  const generating = localGenerating || serverGenerating;
  const [extracting, setExtracting] = useState(false);
  const [showSource, setShowSource] = useState(false);

  const overrides = {
    providerId: series?.llm?.provider || undefined,
    model: series?.llm?.model || undefined,
  };

  // Re-generate the comic script from prose and immediately split it into
  // pages. Auto-extract follows generate so the user never sees the raw
  // concatenated markdown unless they expand the source-details panel.
  const handleGenerate = async () => {
    setLocalGenerating(true);
    const result = await generatePipelineStage(issue.id, 'comicScript', overrides)
      .catch((err) => { toast.error(err.message || 'Generation failed'); return null; });
    if (!result) { setLocalGenerating(false); return; }
    onStageUpdate?.('comicScript', result.stage);
    const extracted = await extractPipelineComicPages(issue.id, { force: true })
      .catch((err) => { toast.error(`Page split failed: ${err.message}`); return null; });
    setLocalGenerating(false);
    if (extracted) {
      onStageUpdate?.('comicPages', extracted.stage);
      toast.success(`Generated and split into ${extracted.pageCount} page${extracted.pageCount === 1 ? '' : 's'}`);
    }
  };

  const handleExtract = async () => {
    setExtracting(true);
    const extracted = await extractPipelineComicPages(issue.id, { force: pages.length > 0 })
      .catch((err) => { toast.error(err.message || 'Page split failed'); return null; });
    setExtracting(false);
    if (extracted) {
      onStageUpdate?.('comicPages', extracted.stage);
      toast.success(`Split into ${extracted.pageCount} page${extracted.pageCount === 1 ? '' : 's'}`);
    }
  };

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-white">{PIPELINE_STAGE_LABELS.comicScript}</h2>
          <span className={`text-[10px] uppercase tracking-wider ${STATUS_COLOR[script.status] || 'text-gray-500'}`}>
            {STATUS_LABEL[script.status] || script.status}
          </span>
          {pages.length > 0 ? (
            <span className="text-xs text-gray-500">{pages.length} page{pages.length === 1 ? '' : 's'}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {hasScript && pages.length === 0 ? (
            <button
              type="button"
              onClick={handleExtract}
              disabled={extracting}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-card border border-port-border text-white text-sm hover:border-port-accent/50 disabled:opacity-40"
            >
              {extracting ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              Split into pages
            </button>
          ) : null}
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating || extracting}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
            title="Re-adapt the prose into a fresh comic script and split it into pages"
          >
            {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {hasScript ? 'Re-generate pages' : 'Generate pages'}
          </button>
        </div>
      </header>

      {pages.length === 0 && !hasScript ? (
        <p className="text-sm text-gray-400 italic">
          Generate the prose stage first, then click <em>Generate pages</em>. The LLM adapts the prose into a Marvel/DC-format script and we split it into editable pages.
        </p>
      ) : null}

      {pages.length === 0 && hasScript ? (
        <p className="text-sm text-gray-400 italic">
          Script generated but no pages parsed. Click <em>Split into pages</em> above.
        </p>
      ) : null}

      <ul className="space-y-4">
        {pages.map((page, pi) => (
          <PageRow
            key={pi}
            issue={issue}
            pageIndex={pi}
            page={page}
            onStageUpdate={onStageUpdate}
          />
        ))}
      </ul>

      {hasScript ? (
        <details
          className="rounded border border-port-border bg-port-card/40"
          open={showSource}
          onToggle={(e) => setShowSource(e.currentTarget.open)}
        >
          <summary className="px-3 py-2 text-xs uppercase tracking-wider text-gray-500 cursor-pointer flex items-center gap-2 hover:text-white">
            {showSource ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Full comic script (markdown source)
          </summary>
          <pre className="px-3 py-2 text-xs text-gray-300 whitespace-pre-wrap font-mono border-t border-port-border">
            {script.output}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function PageRow({ issue, pageIndex, page, onStageUpdate }) {
  const rawText = useMemo(
    () => page.rawText || panelsToMarkdown(page.panels, pageIndex + 1),
    [page.rawText, page.panels, pageIndex],
  );
  const [draft, setDraft] = useState(rawText);
  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState(false);
  // Sync local edits with parent updates (re-extract / re-render persist).
  useEffect(() => { setDraft(rawText); }, [rawText]);
  const dirty = draft !== rawText;

  const handleSave = async () => {
    setSaving(true);
    const res = await updatePipelineComicPage(issue.id, pageIndex, { rawText: draft })
      .catch((err) => { toast.error(err.message || 'Save failed'); return null; });
    setSaving(false);
    if (res) {
      onStageUpdate?.('comicPages', res.stage);
      toast.success(`Page ${pageIndex + 1} saved (${res.page?.panels?.length || 0} panel${res.page?.panels?.length === 1 ? '' : 's'} parsed)`);
    }
  };

  const handleRender = async () => {
    setRendering(true);
    const res = await generatePipelineComicPage(issue.id, pageIndex, {})
      .catch((err) => { toast.error(err.message || 'Render failed'); return null; });
    setRendering(false);
    if (res) {
      onStageUpdate?.('comicPages', res.stage);
      toast.success(`Page ${pageIndex + 1} render queued`);
    }
  };

  const handleDelete = async () => {
    const next = (issue.stages?.comicPages?.pages || []).filter((_, i) => i !== pageIndex);
    const patched = await updatePipelineIssue(issue.id, {
      stages: { comicPages: { status: next.length ? 'edited' : 'empty', pages: next } },
    }).catch((err) => { toast.error(err.message || 'Delete failed'); return null; });
    if (patched) {
      onStageUpdate?.('comicPages', patched.stages.comicPages, patched);
      toast.success(`Page ${pageIndex + 1} deleted`);
    }
  };

  return (
    <li className="rounded-lg border border-port-border bg-port-card/40">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-port-border">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-gray-500">Page {pageIndex + 1}</span>
          <span className="text-[10px] text-gray-600">{page.panels?.length || 0} panel{page.panels?.length === 1 ? '' : 's'}</span>
          {dirty ? <span className="text-[10px] text-port-warning">unsaved</span> : null}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-port-bg border border-port-border text-white hover:border-port-accent/50 disabled:opacity-40"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            Save
          </button>
          <button
            type="button"
            onClick={handleRender}
            disabled={rendering || dirty}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-port-accent text-white font-medium disabled:opacity-40"
            title={dirty ? 'Save changes before rendering' : 'Queue a full-page render for this page'}
          >
            {rendering ? <Loader2 size={12} className="animate-spin" /> : <ImageIcon size={12} />}
            Render
          </button>
          <button
            type="button"
            onClick={handleDelete}
            className="p-1 text-gray-500 hover:text-port-error"
            aria-label={`Delete page ${pageIndex + 1}`}
            title="Delete page"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      <div className="grid md:grid-cols-2 gap-3 p-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={18}
          spellCheck={false}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-xs font-mono leading-relaxed"
          placeholder={`## Page ${pageIndex + 1}\n\n### Panel 1\n**Description:** ...`}
        />
        <div className="flex items-center justify-center bg-port-bg border border-port-border rounded min-h-[200px]">
          {page.imageJobId ? (
            <MediaJobThumb jobId={page.imageJobId} label={`Page ${pageIndex + 1}`} size="md" />
          ) : (
            <span className="text-xs text-gray-500 italic">No render yet — click <em>Render</em>.</span>
          )}
        </div>
      </div>
    </li>
  );
}
