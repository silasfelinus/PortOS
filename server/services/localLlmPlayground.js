import { ServerError } from '../lib/errorHandler.js';
import { createRun, finalizeRunRecord } from './runner.js';
import { ensureBackendProvider } from './localLlm.js';
import { getProviderById } from './providers.js';
import { markProviderAvailable } from './providerStatus.js';
import { ensureProviderReady as ensureOllamaProviderReady } from './ollamaManager.js';

const PROVIDER_BY_BACKEND = { ollama: 'ollama', lmstudio: 'lmstudio' };

function buildPrompt({ systemPrompt, prompt }) {
  const system = String(systemPrompt || '').trim();
  if (!system) return prompt;
  return `System instructions:\n${system}\n\nUser prompt:\n${prompt}`;
}

function summarizeTimings({ startedAt, firstChunkAt, endedAt, text }) {
  const totalMs = endedAt - startedAt;
  const ttftMs = firstChunkAt ? firstChunkAt - startedAt : null;
  const chars = text.length;
  const charsPerSecond = totalMs > 0 ? chars / (totalMs / 1000) : chars;
  return {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    ttftMs,
    totalMs,
    chars,
    charsPerSecond: Number(charsPerSecond.toFixed(2)),
  };
}

function buildMessages({ systemPrompt, prompt }) {
  const system = String(systemPrompt || '').trim();
  return [
    ...(system ? [{ role: 'system', content: system }] : []),
    { role: 'user', content: prompt },
  ];
}

async function resolveLocalProvider(backend) {
  const providerId = PROVIDER_BY_BACKEND[backend];
  if (!providerId) {
    throw new ServerError(`Unsupported local LLM backend: ${backend}`, { status: 400, code: 'VALIDATION_ERROR' });
  }

  await ensureBackendProvider(backend);
  const provider = await getProviderById(providerId);
  if (!provider) {
    throw new ServerError(`Local provider "${providerId}" is not configured`, { status: 503, code: 'LOCAL_LLM_PROVIDER_MISSING' });
  }
  if (provider.type !== 'api') {
    throw new ServerError(`Local provider "${providerId}" must be an API provider`, { status: 503, code: 'LOCAL_LLM_PROVIDER_INVALID' });
  }
  await markProviderAvailable(provider.id).catch(() => {});
  return provider;
}

async function streamChatCompletion({ provider, backend, modelId, prompt, systemPrompt, temperature, maxTokens, signal, onChunk }) {
  if (backend === 'ollama') {
    const ready = await ensureOllamaProviderReady(provider).catch((err) => ({ success: false, error: err.message }));
    if (!ready.success) {
      throw new Error(`Ollama is not running and PortOS could not start it: ${ready.error || 'unknown error'}`);
    }
  }

  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  const response = await fetch(`${provider.endpoint}/chat/completions`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: modelId,
      messages: buildMessages({ systemPrompt, prompt }),
      stream: true,
      temperature,
      max_tokens: maxTokens,
      ...(Number(provider.numCtx) > 0 ? { num_ctx: Number(provider.numCtx) } : {}),
    }),
  }).catch((err) => ({ ok: false, status: 0, error: err.message }));

  if (!response.ok) {
    const body = response.text ? await response.text().catch(() => '') : response.error || '';
    throw new Error(`Provider returned ${response.status || 0}: ${body || response.error || response.statusText || 'request failed'}`);
  }

  if (!response.body?.getReader) {
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    if (text) onChunk(text);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';
  let reasoning = '';

  const consumeLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line.startsWith('data: ')) return;
    const data = line.slice(6).trim();
    if (!data || data === '[DONE]' || data === '✅') return;
    const parsed = JSON.parse(data);
    const delta = parsed?.choices?.[0]?.delta;
    const text = delta?.content || '';
    if (text) {
      output += text;
      onChunk(text);
    }
    if (delta?.reasoning) reasoning += delta.reasoning;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) consumeLine(line);
  }
  if (buffer.trim()) consumeLine(buffer);

  if (!output.trim() && reasoning.trim()) {
    output = reasoning;
    onChunk(reasoning);
  }
  return output;
}

export async function runLocalLlmTest({
  backend,
  modelId,
  prompt,
  systemPrompt = '',
  temperature = 0.3,
  maxTokens = 1000,
  timeoutMs = 300000,
}) {
  const provider = await resolveLocalProvider(backend);
  const fullPrompt = buildPrompt({ systemPrompt, prompt });
  const startedAt = Date.now();
  let firstChunkAt = null;
  let runId = null;

  try {
    const run = await createRun({
      providerId: provider.id,
      model: modelId,
      prompt: fullPrompt,
      source: 'local-llm-playground',
      timeout: timeoutMs,
    });
    runId = run.runId;
    if (run.usedFallback || run.provider?.id !== provider.id) {
      throw new Error(`Local LLM playground refused fallback provider for ${provider.id}`);
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    const text = await streamChatCompletion({
      provider,
      backend,
      modelId,
      prompt,
      systemPrompt,
      temperature,
      maxTokens,
      signal: controller.signal,
      onChunk: (chunk) => {
        if (!firstChunkAt && chunk) firstChunkAt = Date.now();
      },
    }).finally(() => clearTimeout(timeoutHandle));

    const endedAt = Date.now();
    await finalizeRunRecord({ runId, output: text, exitCode: 0, success: true, startTime: startedAt });
    return {
      backend,
      modelId,
      providerId: provider.id,
      runId,
      text,
      timings: summarizeTimings({ startedAt, firstChunkAt, endedAt, text }),
      options: { temperature, maxTokens, timeoutMs },
    };
  } catch (err) {
    const endedAt = Date.now();
    const error = err?.name === 'AbortError' ? `Timed out after ${timeoutMs}ms` : err?.message || 'Local LLM test failed';
    if (runId) {
      await finalizeRunRecord({
        runId,
        output: '',
        exitCode: 1,
        success: false,
        error,
        startTime: startedAt,
      }).catch(() => {});
    }
    return {
      backend,
      modelId,
      providerId: provider.id,
      runId,
      error,
      timings: summarizeTimings({ startedAt, firstChunkAt, endedAt, text: '' }),
      options: { temperature, maxTokens, timeoutMs },
    };
  }
}

export async function compareLocalLlmModels({ targets, prompt, mode = 'round-robin', options = {} }) {
  const runOne = (target) => runLocalLlmTest({ ...options, ...target, prompt });
  const results = [];

  if (mode === 'parallel') {
    return {
      mode,
      prompt,
      results: await Promise.all(targets.map(runOne)),
    };
  }

  for (const target of targets) {
    results.push(await runOne(target));
  }
  return { mode: 'round-robin', prompt, results };
}
