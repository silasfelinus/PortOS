/**
 * Image Gen — SynthID-defeat regeneration (issue #912).
 *
 * The plain cleaner (`server/lib/imageClean.js`) only strips the C2PA `caBX`
 * chunk and runs median+sharpen — SynthID survives that by design. The only
 * honest defeat path is to round-trip the pixels through a generative model:
 * a short-step img2img pass on a LOCAL FLUX runner at low–moderate denoise
 * (~0.4) so composition holds but the per-pixel watermark signal is overwritten
 * by fresh sampling.
 *
 * Scope (per the issue): post-hoc, history-only — a second action next to
 * "Clean (aggressive)" in the lightbox, never auto-applied and never wired into
 * the active generation flow. Hardware-gated: it only runs when a local FLUX
 * runner is actually installed, so the UI hides the action otherwise.
 *
 * This module owns the backend-availability gate + the pure param assembly.
 * The render itself reuses the existing local img2img path — the route enqueues
 * a normal `kind: 'image'` job through `mediaJobQueue` (the GPU lane already
 * serializes MLX work; a separate "regen lane" would just contend for the same
 * runtime and OOM the box, so reusing the GPU lane is the correct shape). The
 * `regenOf` param threaded into `generateImage` stamps the lineage onto the
 * resulting sidecar (`regenerated`/`regenSteps`/`regenStrength`/`regenModelId`
 * + `cleanedFrom` for variant grouping).
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { getSettings } from '../settings.js';
import { getImageModels, isFlux2 } from '../../lib/mediaModels.js';
import { usesDiffusersRunner } from '../../lib/runners.js';
import { isFlux2VenvHealthy } from '../../lib/pythonSetup.js';
import { IMAGE_GEN_MODE } from './modes.js';

const IS_WIN = process.platform === 'win32';

// img2img denoise strength: lower = closer to the source (less watermark
// overwrite), higher = more of the image resampled. 0.4 is the issue's
// recommended midpoint — enough fresh sampling to overwrite the per-pixel
// signal while composition holds.
export const DEFAULT_REGEN_STRENGTH = 0.4;
export const REGEN_STRENGTH_MIN = 0.2;
export const REGEN_STRENGTH_MAX = 0.6;

// FLUX.2 + the diffusers-family runners (Z-Image / ERNIE / HiDream / Qwen) all
// share the FLUX.2 venv and implement img2img via `--image-path`.
export const modelUsesFluxVenv = (model) => isFlux2(model) || usesDiffusersRunner(model);

// Whether a model can do the img2img round-trip regen needs. FLUX.2/diffusers
// runners do i2i on every platform. The legacy mflux path does i2i on macOS
// (`mflux-generate --image-path`), but on Windows `imagine_win.py` silently
// drops the init-image args — a regen there would degrade to txt2img and
// produce an unrelated image, so it's excluded.
export function modelSupportsRegen(model) {
  if (!model) return false;
  if (modelUsesFluxVenv(model)) return true;
  return !IS_WIN;
}

function mfluxBinaryPresent(pythonPath) {
  if (!pythonPath) return false;
  return existsSync(join(dirname(pythonPath), IS_WIN ? 'mflux-generate.exe' : 'mflux-generate'));
}

// Order regen candidates: the source's own model first (style continuity on
// the round-trip), then prefer fast distilled models (`cfgDisabled` —
// Schnell / Klein / Turbo) for a snappy ~5–15s pass, then everything else.
// Pure — `models`/`sourceModelId` in, ordered list out.
export function orderRegenCandidates(models, sourceModelId) {
  const list = Array.isArray(models) ? models.filter(Boolean) : [];
  return [...list].sort((a, b) => {
    const aSrc = a.id === sourceModelId ? 0 : 1;
    const bSrc = b.id === sourceModelId ? 0 : 1;
    if (aSrc !== bSrc) return aSrc - bSrc;
    const aFast = a.cfgDisabled ? 0 : 1;
    const bFast = b.cfgDisabled ? 0 : 1;
    return aFast - bFast;
  });
}

// Resolve the local FLUX backend regen should use. Returns
// `{ available, model, pythonPath }` on success, or `{ available: false, reason }`
// with an actionable message when nothing runnable is installed (the hardware
// gate). Async because the FLUX.2 venv health probe spawns a process (cached).
export async function resolveRegenBackend({ sourceModelId } = {}) {
  const models = getImageModels();
  if (!models.length) {
    return { available: false, reason: 'No local image models are configured on this machine.' };
  }
  const settings = await getSettings().catch(() => null);
  const pythonPath = settings?.imageGen?.local?.pythonPath || null;
  const fluxVenvHealthy = await isFlux2VenvHealthy().catch(() => false);
  const mfluxReady = mfluxBinaryPresent(pythonPath);
  const candidates = orderRegenCandidates(models, sourceModelId).filter(modelSupportsRegen);
  for (const model of candidates) {
    if (modelUsesFluxVenv(model)) {
      if (fluxVenvHealthy) return { available: true, model, pythonPath };
    } else if (mfluxReady) {
      return { available: true, model, pythonPath };
    }
  }
  const reason = !fluxVenvHealthy && !mfluxReady
    ? 'No local FLUX runner is installed. Set up the FLUX.2 venv in Settings → Image Gen to enable image regeneration.'
    : 'No local FLUX model on this machine supports image-to-image regeneration.';
  return { available: false, reason };
}

// Slim shape for the UI gate — drives whether the lightbox shows the
// Regenerate action at all.
export async function getRegenAvailability() {
  const resolved = await resolveRegenBackend();
  return {
    available: resolved.available,
    modelId: resolved.model?.id || null,
    reason: resolved.available ? null : resolved.reason,
  };
}

// Read an image's pixel dimensions off disk. Used to size the regen render to
// match the source (img2img resizes the init image to width/height; a mismatch
// would distort composition). Returns null on a read/decode failure so the
// caller can fall back to the sidecar's recorded dimensions.
export async function readImageDimensions(absPath) {
  const meta = await sharp(absPath).metadata().catch(() => null);
  if (meta?.width && meta?.height) return { width: meta.width, height: meta.height };
  return null;
}

// Pure: assemble the mediaJobQueue params for a regen render. Reuses the source
// image's own prompt (falling back to a generic quality prompt when the source
// has no recorded prompt — e.g. an upload or an already-cleaned copy) so the
// round-trip preserves intent. `regenOf` is what stamps the sidecar lineage in
// `generateImage`. The validated `strength` is the img2img denoise; `steps`
// (optional) lets the caller pin a low count, otherwise the model default is
// used. Actual dimensions match the source.
export function buildRegenParams({ filename, sourceAbsPath, sourceMeta = {}, sourceDims = null, model, pythonPath, strength, steps }) {
  const dims = sourceDims
    || (sourceMeta.width && sourceMeta.height ? { width: sourceMeta.width, height: sourceMeta.height } : null);
  const prompt = typeof sourceMeta.prompt === 'string' && sourceMeta.prompt.trim()
    ? sourceMeta.prompt
    : 'high quality, highly detailed';
  const params = {
    mode: IMAGE_GEN_MODE.LOCAL,
    pythonPath,
    modelId: model.id,
    prompt,
    negativePrompt: typeof sourceMeta.negativePrompt === 'string' ? sourceMeta.negativePrompt : '',
    initImagePath: sourceAbsPath,
    initImageStrength: strength,
    regenOf: filename,
  };
  if (dims) {
    params.width = dims.width;
    params.height = dims.height;
  }
  if (steps != null) params.steps = steps;
  return params;
}
