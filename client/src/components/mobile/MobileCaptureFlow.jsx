import { useState, useCallback, useRef, useEffect } from 'react';
import { Send, Check } from 'lucide-react';
import * as api from '../../services/api';
import toast from '../ui/Toast';
import VoiceCapture from '../brain/VoiceCapture';

// Flow 2 — one-tap voice/text Brain capture. Text area + the existing
// Web-Speech VoiceCapture button feeding /brain/capture. Optimized for a
// single thumb: big input, big send button, instant clear after capture.
export default function MobileCaptureFlow() {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const savedTimerRef = useRef(null);

  useEffect(() => () => clearTimeout(savedTimerRef.current), []);

  const onTranscript = useCallback((chunk) => {
    setText((prev) => (prev ? `${prev} ${chunk}`.trim() : chunk));
  }, []);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    // silent: this flow owns the error toast in the catch below.
    const result = await api.captureBrainThought(trimmed, undefined, undefined, { silent: true }).catch((err) => {
      toast.error(`Capture failed: ${err.message}`);
      return null;
    });
    setSaving(false);
    if (!result) return;
    setText('');
    setJustSaved(true);
    clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setJustSaved(false), 2000);
    toast.success('Captured to Brain');
  };

  return (
    <div className="space-y-4">
      <label htmlFor="mobile-capture" className="block text-sm text-gray-400">
        What&apos;s on your mind?
      </label>
      <textarea
        id="mobile-capture"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        placeholder="Type or tap the mic to speak…"
        className="w-full resize-none rounded-xl border border-port-border bg-port-card p-3 text-base text-white placeholder-gray-600 focus:border-port-accent focus:outline-none"
        autoFocus
      />
      <div className="flex items-center gap-3">
        <VoiceCapture onTranscript={onTranscript} disabled={saving} />
        <button
          onClick={submit}
          disabled={!text.trim() || saving}
          className="flex min-h-[52px] flex-1 items-center justify-center gap-2 rounded-xl bg-port-accent text-base font-semibold text-white disabled:opacity-40"
        >
          {justSaved ? <Check size={20} aria-hidden="true" /> : <Send size={18} aria-hidden="true" />}
          {justSaved ? 'Saved' : saving ? 'Saving…' : 'Capture'}
        </button>
      </div>
    </div>
  );
}
