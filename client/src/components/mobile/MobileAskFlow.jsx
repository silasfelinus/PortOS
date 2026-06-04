import { useState, useRef, useCallback, useEffect } from 'react';
import { Send, Sparkles } from 'lucide-react';
import * as api from '../../services/api';
import toast from '../ui/Toast';

const NOW_PROMPT = 'What should I do right now?';

// Flow 3 — "what should I do now?" Ask. Streams a single turn against
// /api/ask in 'advise' mode. A one-tap suggestion chip fills the canonical
// "what should I do now" question so the answer is reachable in two taps
// (open flow → tap chip), or the user can type their own question.
export default function MobileAskFlow() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [streaming, setStreaming] = useState(false);
  const controllerRef = useRef(null);
  const mountedRef = useRef(true);

  // Abort any in-flight stream when the flow unmounts (back to hub / nav away).
  useEffect(() => () => { mountedRef.current = false; controllerRef.current?.abort(); }, []);

  const ask = useCallback(async (q) => {
    const trimmed = (q ?? question).trim();
    if (!trimmed || streaming) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setAnswer('');
    setStreaming(true);
    const chunks = [];
    await api.streamAskTurn(
      { question: trimmed, mode: 'advise' },
      {
        signal: controller.signal,
        onEvent: ({ event, data }) => {
          if (controller.signal.aborted) return;
          if (event === 'delta' && data.text) {
            chunks.push(data.text);
            setAnswer(chunks.join(''));
          } else if (event === 'error') {
            toast.error(data.error || 'Ask failed');
          }
        },
      },
    ).catch((err) => {
      if (err.name !== 'AbortError') toast.error(err.message || 'Ask failed');
    });
    // Skip the state write if the flow unmounted mid-stream.
    if (mountedRef.current) setStreaming(false);
  }, [question, streaming]);

  return (
    <div className="space-y-4">
      <button
        onClick={() => { setQuestion(NOW_PROMPT); ask(NOW_PROMPT); }}
        disabled={streaming}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-port-accent/40 bg-port-accent/10 px-4 py-3 text-base font-semibold text-port-accent disabled:opacity-50"
      >
        <Sparkles size={18} aria-hidden="true" />
        {NOW_PROMPT}
      </button>

      <form onSubmit={(e) => { e.preventDefault(); ask(); }} className="flex items-end gap-2">
        <label htmlFor="mobile-ask" className="sr-only">Ask your digital twin</label>
        <textarea
          id="mobile-ask"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={2}
          placeholder="Ask anything…"
          className="flex-1 resize-none rounded-xl border border-port-border bg-port-card p-3 text-base text-white placeholder-gray-600 focus:border-port-accent focus:outline-none"
        />
        <button
          type="submit"
          disabled={!question.trim() || streaming}
          className="flex min-h-[52px] items-center justify-center rounded-xl bg-port-accent px-5 text-white disabled:opacity-40"
          aria-label="Ask"
        >
          <Send size={18} aria-hidden="true" />
        </button>
      </form>

      {(answer || streaming) && (
        <div className="rounded-xl border border-port-border bg-port-card p-4 text-base leading-relaxed text-gray-200 whitespace-pre-wrap">
          {answer || <span className="text-gray-500">Thinking…</span>}
          {streaming && answer && <span className="ml-0.5 animate-pulse">▋</span>}
        </div>
      )}
    </div>
  );
}
