/**
 * Local LLM orchestration — unifies the Ollama and LM Studio backends behind
 * one shape so the UI can list / search / install / delete models and migrate
 * or switch the active backend (mirroring the Docker↔native Postgres flow).
 *
 * The active backend is recorded in `.env` as `LLM_BACKEND` (parallel to
 * `PGMODE`), so it survives restarts and is readable by the setup script. The
 * matching aiToolkit provider (`ollama` / `lmstudio`) is enabled whenever a
 * backend becomes active.
 *
 * Weights are NOT interchangeable on disk between the two backends, so
 * "migrate" re-provisions the equivalent model on the target backend (via the
 * cross-backend catalog) and then flips the active marker.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../lib/fileUtils.js'
import { isBackend, mapModelToBackend } from '../lib/localLlmCatalog.js'
import * as ollamaManager from './ollamaManager.js'
import * as lmStudioManager from './lmStudioManager.js'
import { getProviderById, updateProvider } from './providers.js'

const execFileAsync = promisify(execFile)
const ENV_PATH = join(PATHS.root, '.env')
const DEFAULT_BACKEND = 'ollama'

// aiToolkit provider id that pairs with each backend.
const PROVIDER_ID = { ollama: 'ollama', lmstudio: 'lmstudio' }

// ---- active-backend marker (.env LLM_BACKEND) --------------------------------

function readEnv() {
  const result = {}
  let content = ''
  try { content = readFileSync(ENV_PATH, 'utf8') } catch { return result }
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx === -1) continue
    let value = trimmed.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[trimmed.slice(0, idx).trim()] = value
  }
  return result
}

/** The active local-LLM backend, read fresh from `.env` each call. */
export function getBackend() {
  const fromEnv = readEnv().LLM_BACKEND || process.env.LLM_BACKEND
  return isBackend(fromEnv) ? fromEnv : DEFAULT_BACKEND
}

function writeBackend(backend) {
  let content = ''
  try { content = readFileSync(ENV_PATH, 'utf8') } catch { /* no .env yet */ }
  if (/^LLM_BACKEND=/m.test(content)) {
    content = content.replace(/^LLM_BACKEND=.*/m, `LLM_BACKEND=${backend}`)
  } else {
    content = `LLM_BACKEND=${backend}\n${content}`
  }
  writeFileSync(ENV_PATH, content)
}

/**
 * Enable the aiToolkit provider that pairs with `backend`, so the active local
 * backend is actually usable for runs. Best-effort: a misconfigured provider
 * store must not crash a boot-time or migrate call.
 */
export async function ensureBackendProvider(backend) {
  const id = PROVIDER_ID[backend]
  if (!id) return
  const provider = await getProviderById(id).catch(() => null)
  if (provider && !provider.enabled) {
    const enabled = await updateProvider(id, { enabled: true })
      .then(() => true)
      .catch((err) => {
        console.error(`⚠️ Failed to enable ${id} provider: ${err.message}`)
        return false
      })
    if (enabled) console.log(`🔌 Enabled ${id} provider for active local LLM backend`)
  }
}

// ---- backend capability probes ----------------------------------------------

async function commandExists(cmd, args) {
  return execFileAsync(cmd, args, { timeout: 5_000 }).then(() => true).catch(() => false)
}

const manager = (backend) => (backend === 'ollama' ? ollamaManager : lmStudioManager)

/** Normalize each backend's installed-model shape into one card shape. */
function normalizeModels(backend, models) {
  if (backend === 'ollama') {
    return models.map((m) => ({
      id: m.id, name: m.name, size: m.size ?? null,
      params: m.params || null, quantization: m.quantization || null, family: m.family || null
    }))
  }
  return models.map((m) => ({
    id: m.id, name: m.id, size: null,
    params: null, quantization: m.quantization || null, family: m.arch || null
  }))
}

/** Installed models for a backend, normalized. */
export async function listModels(backend) {
  if (!isBackend(backend)) return []
  const raw = backend === 'ollama'
    ? await ollamaManager.getInstalledModels(true)
    : await lmStudioManager.getAvailableModels()
  return normalizeModels(backend, raw)
}

/**
 * Combined status for both backends plus the active marker.
 */
export async function getStatus() {
  const [ollamaStatus, ollamaCli, lmStudioStatus, lmsCli, lmStudioModels] = await Promise.all([
    ollamaManager.getStatus(),
    commandExists('ollama', ['--version']),
    lmStudioManager.getStatus(),
    commandExists('lms', ['version']),
    listModels('lmstudio').catch(() => [])  // already normalized
  ])

  return {
    backend: getBackend(),
    ollama: {
      installed: ollamaCli || ollamaStatus.available,
      available: ollamaStatus.available,
      version: ollamaStatus.version,
      baseUrl: ollamaStatus.baseUrl,
      modelCount: ollamaStatus.modelCount,
      models: normalizeModels('ollama', ollamaStatus.models)
    },
    lmstudio: {
      installed: lmsCli || lmStudioStatus.available,
      available: lmStudioStatus.available,
      hasCli: lmsCli,
      baseUrl: lmStudioStatus.baseUrl,
      modelCount: lmStudioModels.length,
      models: lmStudioModels
    }
  }
}

// ---- install / delete --------------------------------------------------------

/**
 * Install (pull/download) a model on a backend.
 * @param {(p) => void} [onProgress] - streaming progress (Ollama only)
 */
export async function installModel(backend, modelId, onProgress) {
  if (!isBackend(backend)) return { success: false, error: `Unknown backend: ${backend}` }
  if (backend === 'ollama') {
    return ollamaManager.pullModel(modelId, onProgress)
  }
  // LM Studio: prefer the `lms` CLI (real download), fall back to the REST hook.
  if (await commandExists('lms', ['version'])) {
    // `lms get` streams substantial progress to stdout; the default 1MB
    // maxBuffer overflows and surfaces as a false install failure (see
    // voice/bootstrap.js which uses the same 64MB ceiling for `lms get`).
    const r = await execFileAsync('lms', ['get', '-y', modelId], { timeout: 0, maxBuffer: 64 * 1024 * 1024 })
      .then(() => ({ ok: true })).catch((err) => ({ _err: err.stderr || err.message }))
    if (r._err) return { success: false, error: r._err, modelId }
    lmStudioManager.resetCache()
    return { success: true, modelId }
  }
  return lmStudioManager.downloadModel(modelId)
}

/**
 * Delete an installed model from a backend.
 */
export async function deleteModel(backend, modelId) {
  if (!isBackend(backend)) return { success: false, error: `Unknown backend: ${backend}` }
  if (backend === 'ollama') {
    return ollamaManager.deleteModel(modelId)
  }
  // LM Studio has no delete in its REST API — use the `lms` CLI if present.
  if (await commandExists('lms', ['version'])) {
    const r = await execFileAsync('lms', ['rm', modelId, '-y'], { timeout: 30_000 })
      .then(() => ({ ok: true })).catch((err) => ({ _err: err.stderr || err.message }))
    if (r._err) return { success: false, error: r._err, modelId }
    lmStudioManager.resetCache()
    return { success: true, modelId }
  }
  return { success: false, error: 'Deleting LM Studio models requires the `lms` CLI. Remove it from the LM Studio app instead.', modelId }
}

// ---- switch / migrate --------------------------------------------------------

/**
 * Flip the active backend without moving any models.
 */
export async function switchBackend(to) {
  if (!isBackend(to)) return { success: false, error: `Unknown backend: ${to}` }
  writeBackend(to)
  await ensureBackendProvider(to)
  console.log(`🔀 Active local LLM backend → ${to}`)
  return { success: true, backend: to }
}

/**
 * Migrate to a backend: re-provision the source backend's installed models on
 * the target (weights aren't portable), then flip the active marker. Per-model
 * results are reported; an individual failure doesn't abort the switch.
 *
 * @param {string} to - target backend
 * @param {(p: { event: string, message: string }) => void} [onProgress]
 */
export async function migrateBackend(to, onProgress = () => {}) {
  if (!isBackend(to)) return { success: false, error: `Unknown backend: ${to}` }
  const from = to === 'ollama' ? 'lmstudio' : 'ollama'

  onProgress({ event: 'start', message: `Reading models installed on ${from}…` })
  const sourceModels = await listModels(from)

  const results = []
  for (const model of sourceModels) {
    const { targetId, exact } = mapModelToBackend(from, model.id, to)
    if (!targetId) {
      results.push({ source: model.id, target: null, status: 'skipped', reason: 'no known equivalent' })
      onProgress({ event: 'start', message: `Skipped ${model.id} — no known ${to} equivalent` })
      continue
    }
    onProgress({ event: 'start', message: `Installing ${targetId} on ${to}${exact ? '' : ' (best-effort)'}…` })
    const r = await installModel(to, targetId, (p) => {
      if (p?.percent != null) onProgress({ event: 'start', message: `Pulling ${targetId}: ${p.percent}%` })
    })
    results.push({ source: model.id, target: targetId, status: r.success ? 'installed' : 'failed', reason: r.error })
  }

  writeBackend(to)
  await ensureBackendProvider(to)

  const installed = results.filter((r) => r.status === 'installed').length
  const failed = results.filter((r) => r.status === 'failed').length
  onProgress({ event: 'complete', message: `Migrated to ${to} — ${installed} installed, ${failed} failed, ${results.length - installed - failed} skipped` })
  console.log(`🔀 Migrated local LLM backend → ${to} (${installed} installed, ${failed} failed)`)
  return { success: true, backend: to, results }
}
