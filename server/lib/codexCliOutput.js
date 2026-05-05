const STARTUP_FIELD_RE = /^(workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id):/i;
const RUNTIME_SIGNAL_RE = /^(ERROR:|exec\s+)/i;
const ERROR_SIGNAL_RE = /\b(invalid_request_error|not logged in|api key|unauthorized|forbidden|rate.?limit|quota exceeded|model .*not supported|billing|subscription)\b/i;

function shouldDropCodexLine(trimmed) {
  if (!trimmed) return true;
  if (trimmed === 'user') return true;
  if (/^-{4,}$/.test(trimmed)) return true;
  if (trimmed.startsWith('Reading prompt from stdin')) return true;
  if (trimmed.startsWith('OpenAI Codex v')) return true;
  if (STARTUP_FIELD_RE.test(trimmed)) return true;
  if (/WARN codex_analytics::client:/.test(trimmed)) return true;
  if (/WARN codex_core_plugins::manifest:/.test(trimmed)) return true;
  if (/WARN codex_core_skills::loader:/.test(trimmed)) return true;
  if (trimmed.startsWith('<') || trimmed.startsWith('{cFPWv:') || trimmed.includes('Cloudflare')) return true;
  return false;
}

function formatCodexRuntimeLine(trimmed) {
  if (trimmed.startsWith('exec ')) {
    const match = trimmed.match(/^exec\s+\S+\s+-lc\s+(['"])(.*?)\1/);
    const cmd = match ? match[2] : trimmed.split(' in /')[0];
    return `🔧 ${cmd}`;
  }
  if (trimmed.length > 300) return null;
  return trimmed;
}

export function createCodexStderrFormatter() {
  let lineBuffer = '';
  let sawRuntimeOutput = false;
  let suppressCommandOutput = false;

  const processLine = (line) => {
    const trimmed = line.trim();
    if (shouldDropCodexLine(trimmed)) return null;

    const isRuntimeSignal = RUNTIME_SIGNAL_RE.test(trimmed) || ERROR_SIGNAL_RE.test(trimmed);
    if (suppressCommandOutput && !isRuntimeSignal) return null;
    if (!sawRuntimeOutput && !isRuntimeSignal) return null;
    if (isRuntimeSignal) sawRuntimeOutput = true;
    if (trimmed.startsWith('exec ')) suppressCommandOutput = true;

    return formatCodexRuntimeLine(trimmed);
  };

  const processChunk = (rawData) => {
    const lines = [];
    lineBuffer += rawData;
    const parts = lineBuffer.split('\n');
    lineBuffer = parts.pop() || '';

    for (const part of parts) {
      const formatted = processLine(part);
      if (formatted) lines.push(formatted);
    }

    return lines;
  };

  const flush = () => {
    if (!lineBuffer) return [];
    const formatted = processLine(lineBuffer);
    lineBuffer = '';
    return formatted ? [formatted] : [];
  };

  return { processChunk, flush };
}
