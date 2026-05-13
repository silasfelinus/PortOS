import { request } from './apiCore.js';

export const WORLD_CATEGORIES = ['landscapes', 'environments', 'characters', 'structures', 'vehicles'];
export const WORLD_CATEGORY_KEY_MAX = 64;
export const COMPOSITE_PROMPT_MAX = 4000;
// Mirror of the bible-field caps in server/services/worldBuilder.js — used by
// the World Builder + Pipeline forms for maxLength enforcement on inputs.
export const WORLD_LOGLINE_MAX = 500;
export const WORLD_PREMISE_MAX = 4000;
export const WORLD_STYLE_NOTES_MAX = 4000;
// Mirror of INFLUENCE_ENTRY_MAX + INFLUENCES_PER_LIST_MAX in
// server/services/worldBuilder.js — used by the chip editor for maxLength
// enforcement and to bound paste-floods of refs.
export const WORLD_INFLUENCE_ENTRY_MAX = 120;
export const WORLD_INFLUENCES_PER_LIST_MAX = 30;

export const listWorlds = () => request('/world-builder');
export const getWorld = (id) => request(`/world-builder/${encodeURIComponent(id)}`);

export const createWorld = (data) => request('/world-builder', {
  method: 'POST',
  body: JSON.stringify(data),
});

export const updateWorld = (id, patch) => request(`/world-builder/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
});

export const deleteWorld = (id) => request(`/world-builder/${encodeURIComponent(id)}`, {
  method: 'DELETE',
});

export const expandWorld = ({
  starterPrompt, influences,
  preservedVariations, preservedCompositeSheets,
  providerId, model,
} = {}) => request('/world-builder/expand', {
  method: 'POST',
  body: JSON.stringify({
    starterPrompt, influences,
    preservedVariations, preservedCompositeSheets,
    providerId, model,
  }),
});

export const refineWorldPrompts = ({
  starterPrompt, stylePrompt, negativePrompt,
  logline, premise, styleNotes,
  influences,
  locked,
  feedback, providerId, model,
} = {}) => request('/world-builder/refine-prompts', {
  method: 'POST',
  body: JSON.stringify({
    starterPrompt, stylePrompt, negativePrompt,
    logline, premise, styleNotes,
    influences,
    locked,
    feedback, providerId, model,
  }),
});

// Mirror of LOCKABLE_FIELDS in server/services/worldBuilder.js — the lock UI
// iterates this so a new lockable field only needs adding in two places.
export const WORLD_LOCKABLE_FIELDS = [
  'starterPrompt',
  'stylePrompt',
  'negativePrompt',
  'logline',
  'premise',
  'styleNotes',
  'influences',
];

// Coerce whatever shape the server / draft / patch hands us into a strict
// `{ embrace: [], avoid: [] }` so consumers never have to guard undefined.
// The server has its own sanitizer (sanitizeInfluences) — this one just
// normalizes shape on the client side.
export const ensureInfluences = (raw) => ({
  embrace: Array.isArray(raw?.embrace) ? raw.embrace : [],
  avoid: Array.isArray(raw?.avoid) ? raw.avoid : [],
});

export const renderWorld = (id, options) => request(`/world-builder/${encodeURIComponent(id)}/render`, {
  method: 'POST',
  body: JSON.stringify(options || {}),
});

export const listWorldRuns = (id) => request(`/world-builder/${encodeURIComponent(id)}/runs`);
