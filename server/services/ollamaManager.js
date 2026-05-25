/**
 * Ollama Manager Service
 *
 * Manages a local Ollama install over its native HTTP API (default
 * http://localhost:11434). Mirrors lmStudioManager.js so server/services/
 * localLlm.js can treat both backends through one shape: availability probe,
 * installed-model listing, streaming pulls, and deletes.
 *
 * Ollama's REST surface (not OpenAI-compatible):
 *   GET    /api/version  → { version }
 *   GET    /api/tags     → { models: [{ name, size, details, modified_at }] }
 *   GET    /api/ps       → { models: [...] }  (loaded into memory)
 *   POST   /api/pull     → NDJSON stream { status, total?, completed? }
 *   DELETE /api/delete   → { name }
 */

import { fetchWithTimeout } from '../lib/fetchWithTimeout.js'

const AVAILABILITY_CACHE_TTL_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
// Short probe — degrade to "no Ollama" fast rather than block on a cold check.
const AVAILABILITY_PROBE_TIMEOUT_MS = 5_000

const DEFAULT_CONFIG = {
  // Ollama uses OLLAMA_HOST (host:port, no scheme) by convention; also accept
  // an explicit OLLAMA_URL. Normalize to a scheme + no trailing slash + no /v1.
  baseUrl: normalizeBaseUrl(process.env.OLLAMA_URL || process.env.OLLAMA_HOST || 'http://localhost:11434'),
  timeout: DEFAULT_REQUEST_TIMEOUT_MS
}

function normalizeBaseUrl(raw) {
  let url = String(raw || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '')
  if (url && !/^https?:\/\//i.test(url)) url = `http://${url}`
  return url || 'http://localhost:11434'
}

let config = { ...DEFAULT_CONFIG }
let isAvailable = null
let installedModels = []
let lastCheckAt = null

const status = { lastError: null, lastSuccessAt: null, consecutiveErrors: 0 }

async function ollamaRequest(endpoint, options = {}) {
  const { timeout, headers, ...rest } = options
  const response = await fetchWithTimeout(`${config.baseUrl}${endpoint}`, {
    ...rest,
    headers: { 'Content-Type': 'application/json', ...headers }
  }, timeout ?? config.timeout)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`)
  }
  return response.json()
}

/**
 * Check if Ollama is reachable (cached for AVAILABILITY_CACHE_TTL_MS).
 */
async function checkOllamaAvailable() {
  const now = Date.now()
  if (lastCheckAt && now - lastCheckAt < AVAILABILITY_CACHE_TTL_MS && isAvailable !== null) {
    return isAvailable
  }
  try {
    await ollamaRequest('/api/version', { timeout: AVAILABILITY_PROBE_TIMEOUT_MS })
    isAvailable = true
    status.lastSuccessAt = now
    status.consecutiveErrors = 0
    status.lastError = null
    lastCheckAt = now
    return true
  } catch (err) {
    isAvailable = false
    status.lastError = err.message
    status.consecutiveErrors++
    lastCheckAt = now
    return false
  }
}

/**
 * List installed models from /api/tags.
 * @returns {Promise<Array<{ id, name, size, family, params, quantization, modifiedAt }>>}
 */
async function getInstalledModels(forceRefresh = false) {
  if (!forceRefresh && installedModels.length > 0) return installedModels
  if (!(await checkOllamaAvailable())) return []

  const data = await ollamaRequest('/api/tags').catch(() => null)
  if (!data?.models) return []

  installedModels = data.models.map((m) => ({
    id: m.name || m.model,
    name: m.name || m.model,
    size: m.size ?? null,
    family: m.details?.family || null,
    params: m.details?.parameter_size || null,
    quantization: m.details?.quantization_level || null,
    modifiedAt: m.modified_at || null
  }))
  return installedModels
}

async function getVersion() {
  const data = await ollamaRequest('/api/version', { timeout: AVAILABILITY_PROBE_TIMEOUT_MS }).catch(() => null)
  return data?.version || null
}

/**
 * Pull a model, streaming progress. Resolves once the pull finishes.
 * @param {string} modelId
 * @param {(p: { status: string, percent: number|null, completed?: number, total?: number }) => void} [onProgress]
 * @returns {Promise<{ success: boolean, modelId: string, error?: string }>}
 */
async function pullModel(modelId, onProgress) {
  if (!(await checkOllamaAvailable())) {
    return { success: false, error: 'Ollama not available', modelId }
  }
  console.log(`📥 Ollama pull: ${modelId}`)

  // No timeout — multi-GB pulls take minutes; the stream is the lifecycle.
  const response = await fetchWithTimeout(`${config.baseUrl}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: modelId, stream: true })
  }, 0).catch((err) => ({ _err: err.message }))

  if (response._err || !response.ok || !response.body) {
    const error = response._err || `pull failed: ${response.status} ${response.statusText}`
    console.error(`⚠️ Ollama pull failed for ${modelId}: ${error}`)
    return { success: false, error, modelId }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let lastError = null

  // Ollama streams newline-delimited JSON progress frames. Read via getReader()
  // to match the rest of the codebase's streaming-fetch convention.
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      const frame = safeParse(line)
      if (!frame) continue
      if (frame.error) lastError = frame.error
      if (typeof onProgress === 'function') {
        const percent = frame.total > 0 && frame.completed >= 0
          ? Math.round((frame.completed / frame.total) * 100)
          : null
        onProgress({ status: frame.status || '', percent, completed: frame.completed, total: frame.total })
      }
    }
  }

  if (lastError) {
    return { success: false, error: lastError, modelId }
  }
  installedModels = []  // bust cache so the new model shows on next list
  console.log(`✅ Ollama pull complete: ${modelId}`)
  return { success: true, modelId }
}

function safeParse(line) {
  try { return JSON.parse(line) } catch { return null }
}

/**
 * Delete an installed model (DELETE /api/delete).
 */
async function deleteModel(modelId) {
  if (!(await checkOllamaAvailable())) {
    return { success: false, error: 'Ollama not available', modelId }
  }
  const result = await ollamaRequest('/api/delete', {
    method: 'DELETE',
    body: JSON.stringify({ name: modelId }),
    timeout: 15_000
  }).then(() => ({ ok: true })).catch((err) => ({ _err: err.message }))

  if (result._err) {
    return { success: false, error: result._err, modelId }
  }
  installedModels = []
  console.log(`🗑️ Ollama deleted: ${modelId}`)
  return { success: true, modelId }
}

/**
 * Aggregate status for the unified local-LLM UI.
 */
async function getStatus() {
  const available = await checkOllamaAvailable()
  const models = available ? await getInstalledModels(true) : []
  return {
    available,
    baseUrl: config.baseUrl,
    version: available ? await getVersion() : null,
    modelCount: models.length,
    models,
    lastError: status.lastError,
    consecutiveErrors: status.consecutiveErrors
  }
}

export {
  getInstalledModels,
  pullModel,
  deleteModel,
  getStatus
}
