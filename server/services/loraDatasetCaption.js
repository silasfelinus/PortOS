/**
 * LoRA dataset captioning — vision-LLM auto-captions with SSE progress.
 *
 * Sequential loop (vision backends are local; concurrency 1) over the
 * dataset's ready images: read file → base64 data URL →
 * `describeImageDataUrl` (the same provider pathway the voice agent's
 * ui_describe_visually tool uses) → trigger-word prefix → persist.
 * Progress streams over the shared per-job SSE helpers; the client
 * subscribes via `GET /api/lora-datasets/:id/caption-runs/:runId/events`
 * and refetches the dataset on the terminal frame.
 *
 * Provider resolution: request override → `settings.loraTraining.captionProviderId`
 * → 'lmstudio' (the default local vision backend).
 */

import { readFile } from 'fs/promises';
import { ServerError } from '../lib/errorHandler.js';
import { shortId } from '../lib/fileUtils.js';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { prefixCaption } from '../lib/loraDataset.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../lib/sseUtils.js';
import { describeImageDataUrl } from './visionTest.js';
import { getSettings } from './settings.js';
import { getDataset, updateDataset, datasetImagePath } from './loraDatasets.js';

export const CAPTION_PROMPT = [
  'Describe the person or character in this image for image-generation training:',
  'pose, camera angle, expression, clothing, visible accessories, and framing',
  '(full body / bust / close-up). Reply with ONE comma-separated list of short',
  'fragments. Do not mention art style, the character\'s name, or that this is',
  'an illustration.',
].join(' ');

const CAPTION_MAX_TOKENS = 300;

// runId → { clients: [], lastPayload } — same shape the imageGen/videoGen
// SSE helpers operate on.
const captionRuns = new Map();

export const attachCaptionSseClient = (runId, res) => attachSse(captionRuns, runId, res);

const emit = (runId, payload) => {
  const run = captionRuns.get(runId);
  if (run) broadcastSse(run, payload);
};

/**
 * Start a caption run. Returns `{ runId, total }` immediately; the loop
 * runs detached. `imageIds` limits the run to specific images (single
 * re-caption = one-element array); `overwrite: false` skips images that
 * already have a caption.
 */
export async function startCaptionRun(datasetId, {
  imageIds = null, providerId = null, model = null, overwrite = false,
} = {}) {
  const dataset = await getDataset(datasetId);
  const wanted = new Set(Array.isArray(imageIds) && imageIds.length ? imageIds : null);
  const targets = dataset.images.filter((img) => {
    if (img.status !== 'ready') return false;
    if (wanted.size && !wanted.has(img.id)) return false;
    if (!overwrite && !wanted.size && img.caption) return false;
    return true;
  });
  if (!targets.length) {
    throw new ServerError('No images to caption (all captioned, or none ready)', {
      status: 409, code: 'LORA_DATASET_NOTHING_TO_CAPTION',
    });
  }

  const settings = await getSettings();
  const resolvedProvider = providerId || settings?.loraTraining?.captionProviderId || 'lmstudio';
  const resolvedModel = model || settings?.loraTraining?.captionModel || undefined;

  const runId = uuidv4();
  captionRuns.set(runId, { clients: [], lastPayload: null });
  console.log(`🏷️ Caption run ${shortId(runId)} — dataset=${shortId(datasetId)} images=${targets.length} provider=${resolvedProvider}`);

  // Detached loop — runs outside the request lifecycle, so each iteration
  // wraps its fallible work in try/catch (the async-boundary exception to
  // the no-try/catch rule) and failures route into the SSE error frames.
  (async () => {
    let done = 0;
    let failed = 0;
    for (const img of targets) {
      let caption = null;
      try {
        const bytes = await readFile(datasetImagePath(datasetId, img.file));
        const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
        const text = await describeImageDataUrl({
          dataUrl,
          prompt: CAPTION_PROMPT,
          providerId: resolvedProvider,
          model: resolvedModel,
          maxTokens: CAPTION_MAX_TOKENS,
        });
        caption = prefixCaption(dataset.triggerWord, text);
      } catch (err) {
        failed += 1;
        console.error(`❌ Caption failed [${shortId(runId)} ${img.id}]: ${err?.message || err}`);
        emit(runId, { type: 'progress', done, total: targets.length, imageId: img.id, error: String(err?.message || err) });
        continue;
      }
      try {
        await updateDataset(datasetId, (current) => ({
          ...current,
          images: current.images.map((i) => (i.id === img.id
            ? { ...i, caption, captionSource: 'vision', captionedAt: new Date().toISOString() }
            : i)),
        }));
      } catch (err) {
        failed += 1;
        console.error(`❌ Caption persist failed [${shortId(runId)} ${img.id}]: ${err?.message || err}`);
        emit(runId, { type: 'progress', done, total: targets.length, imageId: img.id, error: String(err?.message || err) });
        continue;
      }
      done += 1;
      emit(runId, { type: 'progress', done, total: targets.length, imageId: img.id, caption });
    }
    const terminal = failed && !done
      ? { type: 'error', message: `All ${failed} caption(s) failed — check the vision provider (${resolvedProvider})` }
      : { type: 'complete', done, failed, total: targets.length };
    emit(runId, terminal);
    console.log(`🏷️ Caption run ${shortId(runId)} finished — ${done}/${targets.length} captioned, ${failed} failed`);
    closeJobAfterDelay(captionRuns, runId);
  })();

  return { runId, total: targets.length, provider: resolvedProvider };
}
