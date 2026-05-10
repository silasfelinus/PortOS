/**
 * Civitai LoRA suggestions — pre-scans top LoRAs per runner family
 * (mflux / flux2 / z-image) so users land on /media/loras with a curated
 * "quick-install" list instead of a blank install form.
 *
 * Cached in-memory with a 1-hour TTL. The cache survives the lifetime of
 * the server process — first request after a restart fetches fresh.
 * Each runner family is cached independently so a Z-Image search returning
 * zero doesn't block re-fetching mflux/flux2.
 */

import {
  baseModelToRunner,
  fetchCivitaiModel,
  pickPreviewImage,
  pickVersion,
  searchCivitaiLoras,
  extractSamplePrompt,
} from '../lib/civitai.js';
import { resolveCivitaiKey } from './loras.js';

const TTL_MS = 60 * 60 * 1000; // 1 hour
const RUNNER_FAMILIES = ['mflux', 'flux2', 'z-image'];

// Hand-curated picks that always lead the suggestion panel regardless of
// whether they crack Civitai's "Most Downloaded" leaderboard. Compat per
// runner is DERIVED from the model's actual modelVersions[].baseModel at
// fetch time — no need to keep a manual "runnerFamilies" list in sync with
// what the creator has actually published.
const CURATED_SUGGESTIONS = [
  { modelId: 1155749, note: 'Hyperdetailed colored-pencil illustration look — published for multiple base models.' },
  { modelId: 832858, note: 'Stylized anime-art rendering.' },
  { modelId: 1349631, note: 'Dark Ghibli-fairytale aesthetic — moody storybook scenes.' },
  { modelId: 551903, note: 'Ars Midjourney watercolor — soft, painterly fills with bleeding edges.' },
];

// runnerFamily -> { fetchedAt: number, items: SuggestionCard[] }
const cache = new Map();

// Shape one Civitai model into the lightweight suggestion-card payload the
// /media/loras UI consumes. Defensive: any field can be missing on Civitai.
const buildCard = (model) => {
  if (!model || typeof model !== 'object') return null;
  const version = pickVersion(model, null);
  if (!version) return null;
  const file = (() => {
    // pickPrimaryFile throws when no .safetensors — for a suggestion card we
    // tolerate that and skip the entry rather than poison the whole list.
    const files = Array.isArray(version.files) ? version.files : [];
    const safetensors = files.filter((f) => /\.safetensors$/i.test(f?.name || ''));
    return safetensors.find((f) => f.primary) || safetensors[0] || null;
  })();
  if (!file) return null;
  const previewImage = pickPreviewImage(version);
  const baseModel = version.baseModel || null;
  return {
    modelId: model.id,
    versionId: version.id,
    name: model.name || '(unnamed)',
    description: typeof model.description === 'string' ? model.description.slice(0, 240) : '',
    creator: model.creator?.username || null,
    baseModel,
    runnerFamily: baseModelToRunner(baseModel),
    triggerWords: Array.isArray(version.trainedWords) ? version.trainedWords : [],
    samplePrompt: extractSamplePrompt(version),
    previewImageUrl: previewImage?.url || null,
    downloads: model.stats?.downloadCount ?? null,
    rating: model.stats?.rating ?? null,
    nsfw: !!model.nsfw,
    fileSizeKB: file.sizeKB ?? null,
    civitaiUrl: `https://civitai.com/models/${model.id}?modelVersionId=${version.id}`,
    // The same URL we'd accept on /api/loras/install — the UI passes this
    // back without re-deriving so adding new URL shapes later only changes
    // one place.
    installUrl: `https://civitai.com/models/${model.id}?modelVersionId=${version.id}`,
  };
};

// For a curated entry: walk all `modelVersions[]` (not just the primary)
// to collect every runner family the model has a published version for.
// `runnerFamilies` on the returned card is what the UI uses to badge
// "works on Flux 1, Flux 2, Z-Image."
const buildCuratedCard = (model, note) => {
  const card = buildCard(model);
  if (!card) return null;
  const versions = Array.isArray(model?.modelVersions) ? model.modelVersions : [];
  const families = new Set();
  for (const v of versions) {
    const fam = baseModelToRunner(v?.baseModel);
    if (fam) families.add(fam);
  }
  return {
    ...card,
    note: note || '',
    curated: true,
    runnerFamilies: [...families],
  };
};

const now = () => Date.now();

// Fetch + build curated cards. Each curated entry hits the metadata
// endpoint independently; one failure (404 / network) doesn't poison the
// rest. Returns the cards in CURATED_SUGGESTIONS order.
const fetchCurated = async ({ fetchImpl }) => {
  const apiKey = await resolveCivitaiKey();
  const out = await Promise.all(CURATED_SUGGESTIONS.map(async ({ modelId, note }) => {
    const model = await fetchCivitaiModel(modelId, { apiKey, fetchImpl })
      .catch((err) => {
        console.log(`⚠️ Curated suggestion ${modelId} fetch failed: ${err?.message || err}`);
        return null;
      });
    if (!model) return null;
    return buildCuratedCard(model, note);
  }));
  return out.filter(Boolean);
};

// Curated cache is independent from the per-runner cache — same TTL, same
// stale-fallback behavior on a fetch failure.
let curatedCache = null;

const getCurated = async ({ fetchImpl, force = false }) => {
  if (!force && curatedCache && now() - curatedCache.fetchedAt < TTL_MS) return curatedCache.items;
  const items = await fetchCurated({ fetchImpl }).catch((err) => {
    console.log(`⚠️ Curated suggestions fetch failed: ${err?.message || err}`);
    return curatedCache?.items || [];
  });
  curatedCache = { fetchedAt: now(), items };
  return items;
};

const fetchSuggestionsFor = async (runnerFamily, { fetchImpl, limit, force = false } = {}) => {
  const cached = cache.get(runnerFamily);
  if (!force && cached && now() - cached.fetchedAt < TTL_MS) return cached.items;
  const apiKey = await resolveCivitaiKey();
  // Civitai's API doesn't strictly require auth for SFW LoRA search but a
  // configured key gets cleaner ranking and avoids anonymous rate limits.
  const items = await searchCivitaiLoras({
    runnerFamily,
    limit,
    apiKey,
    fetchImpl,
  });
  const cards = items.map(buildCard).filter(Boolean);
  cache.set(runnerFamily, { fetchedAt: now(), items: cards });
  return cards;
};

// Public API. Returns:
//   - curated:  hand-picked cards (always shown first; multi-runner badged)
//   - runners:  per-family top-N from Civitai's search endpoint
// Never throws on partial failure — a Z-Image search returning zero or a
// transient curated 404 shouldn't kill the whole panel.
export const getSuggestions = async ({ fetchImpl, limit = 12, force = false } = {}) => {
  const [curated, runnerEntries] = await Promise.all([
    getCurated({ fetchImpl, force }),
    Promise.all(RUNNER_FAMILIES.map(async (family) => {
      const cards = await fetchSuggestionsFor(family, { fetchImpl, limit, force })
        .catch((err) => {
          console.log(`⚠️ Civitai suggestion fetch failed for ${family}: ${err?.message || err}`);
          return cache.get(family)?.items || [];
        });
      return [family, cards];
    })),
  ]);
  return {
    curated,
    runners: Object.fromEntries(runnerEntries),
    fetchedAt: new Date().toISOString(),
  };
};

// Test seam — clear all caches between tests.
export const _resetSuggestionsCache = () => {
  cache.clear();
  curatedCache = null;
};
