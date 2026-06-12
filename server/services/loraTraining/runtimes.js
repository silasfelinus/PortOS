/**
 * LoRA training runtime routing + argument/config builders. Pure — no I/O.
 *
 * Two runtimes ship:
 *   - 'mflux' — FLUX.1-dev MLX training via mflux's own dreambooth CLI,
 *     wrapped by scripts/train_mflux_lora.py (runs in the user's mflux venv,
 *     the same python the image renders use).
 *   - 'flux2' — FLUX.2 Klein diffusers+peft training via the vendored
 *     scripts/train_flux2_lora.py (runs in ~/.portos/venv-flux2).
 *
 * FLUX.2 training ALWAYS targets the bf16 base repos — never the SDNQ/int8
 * quantized inference repos (no useful gradients through quant layers). The
 * trained LoRA still loads onto quantized pipelines of the same size
 * variant because the transformer hidden dims match.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { RUNNER_FAMILIES, isFlux2, flux2VariantFromModel } from '../../lib/runners.js';

export const TRAINING_RUNTIMES = Object.freeze({ MFLUX: 'mflux', FLUX2: 'flux2' });

export const TRAINING_DEFAULTS = Object.freeze({
  steps: 1000,
  rank: 16,
  learningRate: 0.0001,
  resolution: 512,
  checkpointEvery: 250,
  sampleEvery: 250,
});

// bf16 training bases per FLUX.2 size variant. Inference may run quantized
// repos; training resolves to these regardless of which flux2-* model id
// the user picked.
export const FLUX2_TRAIN_REPOS = Object.freeze({
  '4b': 'black-forest-labs/FLUX.2-klein-4B',
  '9b': 'black-forest-labs/FLUX.2-klein-9B',
});

/**
 * Resolve which training runtime a base model id routes to. `models` is the
 * getImageModels() registry (injected so this stays pure/testable).
 */
export function resolveTrainingRuntime(baseModelId, models) {
  const entry = (models || []).find((m) => m.id === baseModelId);
  if (!entry) {
    throw new ServerError(`Unknown image model: ${baseModelId}`, {
      status: 400, code: 'TRAINING_UNSUPPORTED_MODEL',
    });
  }
  if (isFlux2(entry)) {
    const variant = flux2VariantFromModel(entry);
    if (!variant || !FLUX2_TRAIN_REPOS[variant]) {
      throw new ServerError(
        `Cannot determine FLUX.2 size variant for ${baseModelId} — training needs a klein-4B/9B model`,
        { status: 400, code: 'TRAINING_UNSUPPORTED_MODEL' },
      );
    }
    return { runtime: TRAINING_RUNTIMES.FLUX2, entry, variant, trainRepo: FLUX2_TRAIN_REPOS[variant] };
  }
  // mflux family (no `runner` field). Only FLUX.1-dev trains — schnell is
  // guidance-distilled and not a supported mflux fine-tune target.
  if (!entry.runner && entry.id === 'dev') {
    return { runtime: TRAINING_RUNTIMES.MFLUX, entry, variant: null, trainRepo: null };
  }
  throw new ServerError(
    `LoRA training supports FLUX.1-dev (mflux) and FLUX.2 Klein (flux2) — not ${baseModelId}`,
    { status: 400, code: 'TRAINING_UNSUPPORTED_MODEL' },
  );
}

/** Runner family stamped into the trained LoRA's sidecar per runtime. */
export const runnerFamilyForRuntime = (runtime) =>
  (runtime === TRAINING_RUNTIMES.FLUX2 ? RUNNER_FAMILIES.FLUX2 : RUNNER_FAMILIES.MFLUX);

const mergedParams = (params = {}) => ({ ...TRAINING_DEFAULTS, ...params });

/**
 * Build the mflux dreambooth train-config JSON. The wrapper script hands
 * this to `python -m mflux.dreambooth --train-config <file>`. mflux trains
 * in epochs over the example set; we translate the requested step budget
 * into epochs (steps / images, min 1) so "steps" means the same thing
 * across both runtimes. Shape follows mflux's documented dreambooth config;
 * the wrapper tolerates unknown-key errors by surfacing mflux's own
 * message (USER_ERROR) rather than guessing.
 */
export function buildMfluxTrainConfig({
  params = {},
  triggerWord,
  samplePrompt = null,
  datasetImagesDir,
  manifestImages = [],
  checkpointsDir,
}) {
  const p = mergedParams(params);
  if (!manifestImages.length) {
    throw new ServerError('mflux train config needs at least one example image', {
      status: 400, code: 'VALIDATION_ERROR',
    });
  }
  const totalSteps = p.steps;
  const epochs = Math.max(1, Math.round(totalSteps / manifestImages.length));
  return {
    model: 'dev',
    seed: Number.isInteger(p.seed) ? p.seed : 42,
    steps: 20,
    guidance: 3.0,
    quantize: null,
    width: p.resolution,
    height: p.resolution,
    training_loop: { num_epochs: epochs, batch_size: 1 },
    optimizer: { name: 'AdamW', learning_rate: p.learningRate },
    save: {
      output_path: checkpointsDir,
      checkpoint_frequency: p.checkpointEvery > 0 ? p.checkpointEvery : totalSteps,
    },
    instrumentation: {
      plot_frequency: 0,
      generate_image_frequency: p.sampleEvery > 0 ? p.sampleEvery : 0,
      validation_prompt: samplePrompt || `${triggerWord} portrait, neutral background`,
    },
    lora_layers: {
      transformer_blocks: {
        block_range: { start: 0, end: 19 },
        layer_types: ['attn.to_q', 'attn.to_k', 'attn.to_v', 'attn.to_out'],
        lora_rank: p.rank,
      },
    },
    examples: {
      path: datasetImagesDir,
      images: manifestImages.map((img) => ({ image: img.file, prompt: img.caption })),
    },
  };
}

/** Argv for the mflux wrapper script. */
export function buildMfluxTrainArgs({ scriptPath, configPath, runDir, totalSteps, resumeCheckpoint = null }) {
  const args = [
    scriptPath,
    '--train-config', configPath,
    '--output-dir', runDir,
    '--total-steps', String(totalSteps),
  ];
  if (resumeCheckpoint) args.push('--resume-checkpoint', resumeCheckpoint);
  return args;
}

/** Argv for the vendored FLUX.2 trainer. */
export function buildFlux2TrainArgs({
  scriptPath,
  trainRepo,
  manifestPath,
  runDir,
  triggerWord,
  params = {},
  samplePrompt = null,
  resumeFrom = null,
}) {
  if (!trainRepo || !/^black-forest-labs\//.test(trainRepo)) {
    // Belt-and-suspenders: training against a quantized repo silently
    // produces garbage gradients — refuse anything but the bf16 bases.
    throw new ServerError(`FLUX.2 training requires a bf16 base repo (got: ${trainRepo})`, {
      status: 400, code: 'TRAINING_UNSUPPORTED_MODEL',
    });
  }
  const p = mergedParams(params);
  const args = [
    scriptPath,
    '--model-repo', trainRepo,
    '--manifest', manifestPath,
    '--output-dir', runDir,
    '--trigger-word', triggerWord,
    '--steps', String(p.steps),
    '--rank', String(p.rank),
    '--lr', String(p.learningRate),
    '--resolution', String(p.resolution),
    '--checkpoint-every', String(p.checkpointEvery),
    '--sample-every', String(p.sampleEvery),
    '--sample-prompt', samplePrompt || `${triggerWord} portrait, neutral background`,
    '--seed', String(Number.isInteger(p.seed) ? p.seed : 42),
    '--device', 'auto',
  ];
  if (resumeFrom) args.push('--resume-from', resumeFrom);
  return args;
}
