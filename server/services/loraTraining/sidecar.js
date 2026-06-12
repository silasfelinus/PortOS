/**
 * Trained-LoRA sidecar builder — pure. Mirrors the Civitai sidecar shape
 * (`lib/civitai.js#buildSidecar`) so `listLoras()` surfaces a trained LoRA
 * with zero picker changes, plus a `source: 'trained'` marker, the
 * character identity block, and the training lineage.
 */

import { slugifyForFilename } from '../../lib/civitai.js';
import { TRAINING_RUNTIMES, runnerFamilyForRuntime } from './runtimes.js';

/** `lora-trained-<slug>-<runId8>.safetensors` — runId suffix prevents collisions. */
export function trainedLoraFilename({ name, characterName, runId }) {
  const slug = slugifyForFilename(name || characterName || 'character');
  return `lora-trained-${slug}-${String(runId).replace(/-/g, '').slice(0, 8)}.safetensors`;
}

export function buildTrainedSidecar({ run, result = {}, filename, previewImageUrl = null, sizeBytes = null }) {
  const runtime = run.runtime;
  const params = run.params || {};
  return {
    filename,
    name: run.name || `${run.character?.name || 'Character'} (trained)`,
    description: `Trained in PortOS · ${params.steps ?? '?'} steps · rank ${params.rank ?? '?'} · dataset ${run.datasetId}`,
    source: 'trained',
    character: run.character || null,
    datasetId: run.datasetId || null,
    runId: run.id,
    civitai: null,
    runnerFamily: runnerFamilyForRuntime(runtime),
    // '4b' | '9b' for flux2 (composeCompatKey → flux2-4b/flux2-9b in the
    // picker); null for mflux (bare 'mflux' compat key).
    fluxVariant: runtime === TRAINING_RUNTIMES.FLUX2 ? (run.fluxVariant || null) : null,
    triggerWords: run.triggerWord ? [run.triggerWord] : [],
    recommendedScale: 1.0,
    training: {
      baseModelId: run.baseModelId,
      runtime,
      steps: params.steps ?? null,
      rank: params.rank ?? null,
      learningRate: params.learningRate ?? null,
      resolution: params.resolution ?? null,
      seed: params.seed ?? null,
      finalLoss: Number.isFinite(result.final_loss) ? result.final_loss : null,
      trainedSteps: Number.isInteger(result.steps) ? result.steps : null,
    },
    file: { sizeKB: Number.isFinite(sizeBytes) ? Math.round(sizeBytes / 1024) : null, hashes: {}, downloadUrl: null },
    previewImageUrl,
    installedAt: new Date().toISOString(),
  };
}
