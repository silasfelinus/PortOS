/**
 * LoRA training engine — run lifecycle + python trainer spawn.
 *
 * Routed through mediaJobQueue's GPU lane as `kind: 'training'` (training
 * shares the Metal/MLX runtime with renders, so serialization is correct).
 * The queue owns job status / SSE / watchdog / cancel escalation; this
 * module owns the run RECORD (PostgreSQL `lora_training_runs`), the child
 * process, artifact collection under `data/training-runs/<runId>/`, and
 * trained-LoRA registration into `data/loras/`.
 *
 * Spawn/cancel mirrors videoGen/local.js: SIGTERM → 8s SIGKILL escalation,
 * PYTHONUNBUFFERED, safeChildProcessEnv + hfTokenEnv, caffeinate on darwin.
 * The trainers checkpoint on SIGTERM, so a cancel keeps its progress.
 */

import { spawn } from 'child_process';
import { copyFile, mkdir, stat, writeFile } from 'fs/promises';
import { join, basename } from 'path';
import { platform } from 'os';
import { PATHS, ensureDir, atomicWrite, shortId } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { v4 as uuidv4 } from '../../lib/uuid.js';
import { hfTokenEnv } from '../../lib/hfToken.js';
import { safeChildProcessEnv } from '../../lib/processEnv.js';
import { getImageModels } from '../../lib/mediaModels.js';
import { resolveFlux2Python, isFlux2VenvHealthy } from '../../lib/pythonSetup.js';
import { getSettings } from '../settings.js';
import { enqueueJob, getJob, mediaJobEvents } from '../mediaJobQueue/index.js';
import { updateDataset } from '../loraDatasets.js';
import { trainingEvents } from './events.js';
import {
  TRAINING_DEFAULTS,
  TRAINING_RUNTIMES,
  buildFlux2TrainArgs,
  buildMfluxTrainArgs,
  buildMfluxTrainConfig,
  resolveTrainingRuntime,
} from './runtimes.js';
import { makeTrainingLineHandler } from './progress.js';
import { classifyTrainingFailure } from './failure.js';
import { buildTrainedSidecar, trainedLoraFilename } from './sidecar.js';
import { validateDatasetReady } from './dataset.js';
import * as runsDb from './db.js';

export { listRuns, getRun, getRunRequired, deleteRun } from './db.js';
export { trainingEvents } from './events.js';

const TRAINER_SCRIPTS = {
  [TRAINING_RUNTIMES.MFLUX]: join(PATHS.root, 'scripts', 'train_mflux_lora.py'),
  [TRAINING_RUNTIMES.FLUX2]: join(PATHS.root, 'scripts', 'train_flux2_lora.py'),
};

export const runDir = (runId) => join(PATHS.trainingRuns, runId);
export const runSamplesDir = (runId) => join(runDir(runId), 'samples');

// GPU lane serializes training with renders, so at most one trainer child
// exists at a time. Keyed by jobId anyway so a stale cancel can't kill a
// newer run.
let activeProcess = null;
let activeJobId = null;

export const cancel = (jobId) => {
  if (!activeProcess || (jobId && activeJobId !== jobId)) return false;
  const proc = activeProcess;
  proc.kill('SIGTERM');
  // Keep activeProcess set until 'close' clears it — the trainer may spend
  // a few seconds writing its cancel checkpoint. Escalate after 8s.
  setTimeout(() => {
    if (activeProcess === proc && proc.exitCode === null && proc.signalCode === null) {
      console.log('⚠️ training child ignored SIGTERM — escalating to SIGKILL');
      proc.kill('SIGKILL');
    }
  }, 8000).unref?.();
  return true;
};

/** Merge order: code defaults ← settings slice ← request params. */
const mergeParams = (settings, requestParams = {}) => ({
  ...TRAINING_DEFAULTS,
  ...(settings?.loraTraining?.defaults || {}),
  ...requestParams,
});

/**
 * Route-facing run launcher. Validates dataset readiness + runtime health,
 * creates the run record, and enqueues the training job. Returns
 * `{ runId, jobId, position }` (202-shaped).
 */
export async function startTrainingRun({ datasetId, baseModelId, name = null, params = {} }) {
  const routing = resolveTrainingRuntime(baseModelId, getImageModels());
  const { dataset } = await validateDatasetReady(datasetId);
  const settings = await getSettings();

  let pythonPath = null;
  if (routing.runtime === TRAINING_RUNTIMES.FLUX2) {
    const healthy = await isFlux2VenvHealthy();
    if (!healthy) {
      throw new ServerError(
        'FLUX.2 python environment is not ready — run `bash scripts/setup-image-video.sh` (FLUX.2 option) first',
        { status: 412, code: 'FLUX2_VENV_MISSING' },
      );
    }
  } else {
    pythonPath = settings?.imageGen?.local?.pythonPath || null;
    if (!pythonPath) {
      throw new ServerError(
        'mflux python environment is not configured — set Settings → Image Gen → Local python path (or run `bash scripts/setup-image-video.sh`)',
        { status: 412, code: 'MFLUX_VENV_MISSING' },
      );
    }
  }

  const mergedParams = mergeParams(settings, params);
  const runId = uuidv4();
  const run = {
    id: runId,
    jobId: null,
    status: 'queued',
    runtime: routing.runtime,
    baseModelId,
    fluxVariant: routing.variant,
    trainRepo: routing.trainRepo,
    name: name || null,
    character: dataset.character,
    datasetId,
    triggerWord: dataset.triggerWord,
    params: mergedParams,
    progress: { step: 0, totalSteps: mergedParams.steps, loss: null, lastCheckpointStep: null },
    artifacts: { dir: `training-runs/${runId}`, checkpoints: [], samples: [] },
    output: { loraFilename: null, finalLoss: null },
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  };
  await runsDb.createRun(run);

  const queued = enqueueJob({
    kind: 'training',
    owner: 'lora-training',
    params: {
      runId,
      runtime: routing.runtime,
      datasetId,
      characterId: dataset.character.entryId,
      characterName: dataset.character.name,
      triggerWord: dataset.triggerWord,
      baseModelId,
      steps: mergedParams.steps,
      rank: mergedParams.rank,
      pythonPath,
    },
  });
  await runsDb.updateRun(runId, { jobId: queued.jobId });
  await updateDataset(datasetId, (current) => ({
    ...current,
    status: 'training',
    training: { ...current.training, lastJobId: queued.jobId, lastRunId: runId },
  })).catch((err) => console.error(`❌ dataset training-status stamp failed: ${err?.message}`));

  console.log(`🏋️ Training run ${shortId(runId)} queued — ${routing.runtime}/${baseModelId} dataset=${shortId(datasetId)} job=${shortId(queued.jobId)}`);
  return { runId, jobId: queued.jobId, position: queued.position, status: 'queued' };
}

const emitFailed = (jobId, error) => trainingEvents.emit('failed', { generationId: jobId, error });

const flipDatasetAfterRun = (datasetId, { trained, loraFilename = null }) =>
  updateDataset(datasetId, (current) => ({
    ...current,
    status: trained ? 'trained' : 'draft',
    training: {
      ...current.training,
      ...(trained ? { loraFilename, completedAt: new Date().toISOString() } : {}),
    },
  })).catch((err) => console.error(`❌ dataset post-run stamp failed: ${err?.message}`));

/**
 * Queue-worker entry — `mediaJobQueue.runJob` calls this for kind
 * 'training'. Resolves the trainer binary + args, spawns, parses the line
 * protocol into trainingEvents, and finalizes (LoRA registration or
 * failure classification) on close. Terminal status flows through the
 * queue's dispatcher; this function resolves once the child is spawned
 * (the queue awaits the terminal event separately).
 */
export async function runTraining({ jobId, runId, pythonPath = null }) {
  const fail = (message) => {
    console.error(`❌ training [${shortId(jobId)}] ${message}`);
    emitFailed(jobId, message);
  };

  const run = await runsDb.getRun(runId);
  if (!run) return fail(`run record missing: ${runId}`);

  // Re-validate — the dataset may have been edited/deleted while queued.
  let manifest;
  try {
    ({ manifest } = await validateDatasetReady(run.datasetId));
  } catch (err) {
    await runsDb.updateRun(runId, { status: 'failed', error: err.message }).catch(() => {});
    return fail(err.message);
  }

  const dir = runDir(runId);
  const checkpointsDir = join(dir, 'checkpoints');
  const samplesDir = join(dir, 'samples');
  await mkdir(checkpointsDir, { recursive: true });
  await mkdir(samplesDir, { recursive: true });

  let bin;
  let args;
  if (run.runtime === TRAINING_RUNTIMES.FLUX2) {
    bin = resolveFlux2Python();
    if (!bin) {
      await runsDb.updateRun(runId, { status: 'failed', error: 'FLUX.2 venv missing' }).catch(() => {});
      return fail('FLUX.2 python environment disappeared — re-run scripts/setup-image-video.sh');
    }
    const manifestPath = join(dir, 'manifest.json');
    await atomicWrite(manifestPath, {
      triggerWord: manifest.triggerWord,
      images: manifest.images.map((img) => ({ path: img.path, caption: img.caption })),
    });
    args = buildFlux2TrainArgs({
      scriptPath: TRAINER_SCRIPTS.flux2,
      trainRepo: run.trainRepo,
      manifestPath,
      runDir: dir,
      triggerWord: run.triggerWord,
      params: run.params,
      samplePrompt: run.params?.samplePrompt || null,
    });
  } else {
    bin = pythonPath;
    if (!bin) {
      await runsDb.updateRun(runId, { status: 'failed', error: 'mflux python path not configured' }).catch(() => {});
      return fail('mflux python path not configured — set it in Settings → Image Gen');
    }
    const config = buildMfluxTrainConfig({
      params: run.params,
      triggerWord: run.triggerWord,
      samplePrompt: run.params?.samplePrompt || null,
      datasetImagesDir: manifest.imagesDir,
      manifestImages: manifest.images,
      checkpointsDir,
    });
    const configPath = join(dir, 'mflux-train.json');
    await atomicWrite(configPath, config);
    args = buildMfluxTrainArgs({
      scriptPath: TRAINER_SCRIPTS.mflux,
      configPath,
      runDir: dir,
      totalSteps: run.params?.steps || TRAINING_DEFAULTS.steps,
    });
  }

  await runsDb.updateRun(runId, { status: 'running', startedAt: new Date().toISOString() });
  trainingEvents.emit('status', { generationId: jobId, message: `Starting ${run.runtime} training (${run.params.steps} steps)` });

  const childEnv = safeChildProcessEnv(await hfTokenEnv());
  delete childEnv.PYTHONPATH;
  childEnv.PYTHONUNBUFFERED = '1';

  console.log(`🏋️ training [${shortId(jobId)}] spawn ${basename(bin)} ${run.runtime} steps=${run.params.steps} rank=${run.params.rank} images=${manifest.images.length}`);
  const proc = spawn(bin, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  activeProcess = proc;
  activeJobId = jobId;

  // Keep the Mac awake for the duration of the training child (display can
  // sleep; system must not). Best-effort — caffeinate exits with the child.
  if (platform() === 'darwin' && proc.pid) {
    const caf = spawn('caffeinate', ['-dis', '-w', String(proc.pid)], { stdio: 'ignore' });
    caf.on('error', () => {});
    caf.unref();
  }

  // Debounced run-record progress mirror (~2s). Per-step DB writes from a
  // hot loop are the high-frequency-write anti-pattern; SSE is the live
  // channel, the row is the durable snapshot.
  let progressDirty = null;
  let progressTimer = null;
  const scheduleProgressPersist = (patch) => {
    progressDirty = { ...progressDirty, ...patch };
    if (progressTimer) return;
    progressTimer = setTimeout(() => {
      progressTimer = null;
      const flushing = progressDirty;
      progressDirty = null;
      runsDb.updateRun(runId, (current) => ({
        ...current,
        progress: { ...current.progress, ...flushing.progress },
        artifacts: {
          ...current.artifacts,
          ...(flushing.checkpoint ? { checkpoints: [...current.artifacts.checkpoints, flushing.checkpoint] } : {}),
          ...(flushing.sample ? { samples: [...current.artifacts.samples, flushing.sample] } : {}),
        },
      })).catch((err) => console.error(`❌ training [${shortId(jobId)}] progress persist failed: ${err?.message}`));
    }, 2000);
    progressTimer.unref?.();
  };

  const { handleLine, getState } = makeTrainingLineHandler({
    jobId,
    totalSteps: run.params.steps,
    emit: (event, payload) => {
      trainingEvents.emit(event, payload);
      if (event === 'progress' && typeof payload.step === 'number') {
        scheduleProgressPersist({ progress: { step: payload.step, totalSteps: payload.totalSteps } });
      }
    },
    onCheckpoint: (path, step) => scheduleProgressPersist({
      checkpoint: { step, path: basename(path) },
      progress: { lastCheckpointStep: step },
    }),
    onSample: (path) => scheduleProgressPersist({ sample: basename(path) }),
    sampleUrl: (path) => `/api/lora-training/runs/${runId}/samples/${basename(path)}`,
  });

  const makeSplitter = (stream) => {
    let buf = '';
    return (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        // try/catch: this runs inside a child-process data callback — an
        // uncaught throw here would crash the server process.
        try { handleLine(buf.slice(0, idx), stream); } catch (err) {
          console.error(`❌ training [${shortId(jobId)}] line handler failed: ${err?.message}`);
        }
        buf = buf.slice(idx + 1);
      }
    };
  };
  proc.stdout.on('data', makeSplitter('stdout'));
  proc.stderr.on('data', makeSplitter('stderr'));

  proc.on('error', (err) => {
    if (activeProcess === proc) { activeProcess = null; activeJobId = null; }
    fail(`trainer spawn failed: ${err.message}`);
  });

  proc.on('close', (code, signal) => {
    if (activeProcess === proc) { activeProcess = null; activeJobId = null; }
    if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
    // Async finalize wrapped so a rejection can't escape the event handler
    // (unhandled rejection kills the process on Node ≥15).
    finalizeTraining({ jobId, runId, code, signal, state: getState() }).catch((err) => {
      console.error(`❌ training [${shortId(jobId)}] finalize failed: ${err?.message}`);
      fail(`finalize failed: ${err?.message}`);
    });
  });
}

async function finalizeTraining({ jobId, runId, code, signal, state }) {
  const run = await runsDb.getRun(runId);
  const job = getJob(jobId);
  const canceled = !!job?.cancelRequested;

  if (code === 0 && state.result?.adapter_path) {
    const filename = trainedLoraFilename({
      name: run?.name, characterName: run?.character?.name, runId,
    });
    await ensureDir(PATHS.loras);
    await copyFile(state.result.adapter_path, join(PATHS.loras, filename));
    const sizeBytes = await stat(join(PATHS.loras, filename)).then((s) => s.size).catch(() => null);
    const lastSample = run?.artifacts?.samples?.length
      ? `/api/lora-training/runs/${runId}/samples/${run.artifacts.samples[run.artifacts.samples.length - 1]}`
      : null;
    const sidecar = buildTrainedSidecar({
      run, result: state.result, filename, previewImageUrl: lastSample, sizeBytes,
    });
    await writeFile(join(PATHS.loras, `${filename}.metadata.json`), JSON.stringify(sidecar, null, 2) + '\n');
    await runsDb.updateRun(runId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      output: {
        loraFilename: filename,
        finalLoss: Number.isFinite(state.result.final_loss) ? state.result.final_loss : null,
      },
    });
    await flipDatasetAfterRun(run.datasetId, { trained: true, loraFilename: filename });
    console.log(`✅ training [${shortId(jobId)}] complete — registered ${filename}`);
    trainingEvents.emit('completed', {
      generationId: jobId, runId, loraFilename: filename, filename,
    });
    return;
  }

  if (canceled) {
    // Queue's cancelRequested flips the failed event into a clean cancel;
    // record keeps the checkpoint lineage for a future resume.
    await runsDb.updateRun(runId, { status: 'canceled', completedAt: new Date().toISOString(), error: 'Canceled' })
      .catch(() => {});
    await flipDatasetAfterRun(run?.datasetId, { trained: false });
    trainingEvents.emit('failed', { generationId: jobId, error: 'Canceled' });
    return;
  }

  const { code: failCode, message } = classifyTrainingFailure({
    stderrTail: state.stderrTail, exitCode: code, signal, userError: state.userError,
  });
  await runsDb.updateRun(runId, {
    status: 'failed', completedAt: new Date().toISOString(), error: message, errorCode: failCode,
  }).catch(() => {});
  await flipDatasetAfterRun(run?.datasetId, { trained: false });
  console.error(`❌ training [${shortId(jobId)}] ${failCode}: ${message}`);
  trainingEvents.emit('failed', { generationId: jobId, error: message });
}

/**
 * Boot reconcile + terminal-state mirror. Called from server/index.js after
 * initMediaJobQueue(). Any run persisted as queued/running whose job isn't
 * live in the queue is marked failed (the queue does the same for its own
 * interrupted jobs — this keeps the two stores agreeing). Also subscribes
 * to mediaJobEvents so a queue-side cancel (user hits cancel while QUEUED,
 * which never reaches runTraining) still lands in the run record.
 */
export async function initLoraTraining() {
  const active = await runsDb.listActiveRuns().catch((err) => {
    console.error(`❌ loraTraining boot reconcile failed: ${err?.message}`);
    return [];
  });
  for (const run of active) {
    const job = run.jobId ? getJob(run.jobId) : null;
    if (!job || ['failed', 'canceled', 'completed'].includes(job.status)) {
      await runsDb.updateRun(run.id, {
        status: 'failed', error: 'interrupted by restart', completedAt: new Date().toISOString(),
      }).catch(() => {});
      await flipDatasetAfterRun(run.datasetId, { trained: false });
      console.log(`🧹 training run ${shortId(run.id)} marked failed (interrupted by restart)`);
    }
  }

  // Queued-job cancels never reach runTraining, so mirror them here.
  mediaJobEvents.on('canceled', (job) => {
    if (job?.kind !== 'training' || !job?.params?.runId) return;
    runsDb.getRun(job.params.runId).then((run) => {
      if (!run || ['completed', 'failed', 'canceled'].includes(run.status)) return null;
      return runsDb.updateRun(run.id, {
        status: 'canceled', completedAt: new Date().toISOString(), error: job.error || 'Canceled',
      }).then(() => flipDatasetAfterRun(run.datasetId, { trained: false }));
    }).catch((err) => console.error(`❌ training cancel mirror failed: ${err?.message}`));
  });
  console.log('🏋️ loraTraining initialized');
}
