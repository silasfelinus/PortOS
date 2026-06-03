// Pure, deterministic helpers for CyberCity's "goal monuments" (roadmap 2.7): each
// life goal renders as a structure in a northeast monument district. Active goals are
// construction sites (scaffolded/partial towers whose build completeness tracks
// progress); completed goals are polished, fully-built monuments that shimmer; stalled
// goals (active but with no recent progress) and abandoned goals read dim. The goal
// list is capped to a sensible row; the rest are summarized by an overflow marker. No
// three.js / React imports so the topology is unit-testable (mirrors cityFederation.js
// / cityHealthTower.js).

export const MONUMENTS = {
  // Northeast monument district — a row centered around [30, 0, -40], clear of the
  // vault (x≈-34), task-queue (x≈+34), voice ([0,0,-40]), health ([48,0,28]),
  // AI core ([0,0,0]), and productivity district (SW).
  base: [30, 0, -40], // center of the row
  spacing: 9, // x-distance between adjacent monuments
  z: -40, // shared depth of the row
  maxMonuments: 8, // cap; goals beyond this fold into an overflow marker
  minHeight: 2, // floor height so even a 0%-progress site reads as a small structure
  fullHeight: 12, // height of a completed (100%) monument
  baseWidth: 2.4,
};

// Status → visual treatment. `dim` collapses opacity + glow so stalled/abandoned goals
// recede; `built` flags a finished monument (drives the polished material + shimmer).
const STATUS_STYLES = {
  completed: { color: '#22c55e', opacity: 1, intensity: 0.7, dim: false, built: true }, // port-success
  active: { color: '#3b82f6', opacity: 0.92, intensity: 0.4, dim: false, built: false }, // port-accent — under construction
  stalled: { color: '#f59e0b', opacity: 0.55, intensity: 0.18, dim: true, built: false }, // port-warning, dimmed
  abandoned: { color: '#64748b', opacity: 0.32, intensity: 0.08, dim: true, built: false }, // slate, dimmed
};

const DEFAULT_STYLE = STATUS_STYLES.active;

const clamp01 = (n) => Math.max(0, Math.min(1, n));

// Days since the most recent progressHistory entry (or createdAt as a fallback).
// Returns null when there's nothing to measure from, so callers can distinguish
// "no signal" from a real recency.
export function daysSinceLastProgress(goal, now = Date.now()) {
  const history = Array.isArray(goal?.progressHistory) ? goal.progressHistory : [];
  let latest = null;
  for (const entry of history) {
    const t = entry?.date ? Date.parse(entry.date) : NaN;
    if (Number.isFinite(t) && (latest === null || t > latest)) latest = t;
  }
  if (latest === null) {
    const created = goal?.createdAt ? Date.parse(goal.createdAt) : NaN;
    if (Number.isFinite(created)) latest = created;
  }
  if (latest === null) return null;
  return Math.max(0, (now - latest) / (1000 * 60 * 60 * 24));
}

// Derive the *effective* status used for visualization. The stored status enum is
// active | completed | abandoned (server: goalStatusEnum). "stalled" is a derived
// state — an active, not-yet-complete goal with no progress in STALL_DAYS — so the
// monument visibly dims when a goal goes quiet. Threshold is conservative.
export const STALL_DAYS = 45;

export function effectiveGoalStatus(goal, now = Date.now()) {
  const raw = goal?.status;
  if (raw === 'completed') return 'completed';
  if (raw === 'abandoned') return 'abandoned';
  // Treat anything else as active for styling purposes.
  const progress = Number.isFinite(goal?.progress) ? goal.progress : 0;
  if (progress >= 100) return 'completed';
  const idleDays = daysSinceLastProgress(goal, now);
  if (idleDays !== null && idleDays >= STALL_DAYS) return 'stalled';
  return 'active';
}

// Build completeness 0..1: completed monuments are always fully built; everything else
// tracks `progress` (clamped). A present-but-zero progress reads as a 1-floor stub, not
// nothing, so a freshly-created goal still shows on the row.
export function buildCompleteness(goal, status) {
  if (status === 'completed') return 1;
  const progress = Number.isFinite(goal?.progress) ? goal.progress : 0;
  return clamp01(progress / 100);
}

// Map one goal to its placed monument view-model. `index` is the slot in the row (0-based);
// `count` is how many monuments are actually placed, so the row is centered on MONUMENTS.base.
export function placeMonument(goal, index, count, now = Date.now()) {
  const status = effectiveGoalStatus(goal, now);
  const style = STATUS_STYLES[status] || DEFAULT_STYLE;
  const completeness = buildCompleteness(goal, status);
  const height = MONUMENTS.minHeight + completeness * (MONUMENTS.fullHeight - MONUMENTS.minHeight);

  // Center the row: slot 0 sits at the leftmost, the middle slot aligns with base.x.
  const offset = (index - (count - 1) / 2) * MONUMENTS.spacing;
  const x = MONUMENTS.base[0] + offset;

  return {
    id: goal?.id || `goal-${index}`,
    title: typeof goal?.title === 'string' && goal.title ? goal.title : 'Untitled Goal',
    status,
    progress: Number.isFinite(goal?.progress) ? clamp01(goal.progress / 100) * 100 : 0,
    completeness, // 0..1 — fraction of the monument that is "built"
    color: style.color,
    opacity: style.opacity,
    intensity: style.intensity,
    dim: style.dim,
    built: style.built,
    height,
    width: MONUMENTS.baseWidth,
    position: [x, 0, MONUMENTS.z],
  };
}

// Full derived view-model for the component. `goals` is the raw goals list (the API
// returns `{ goals: [...] }`; callers should pass `data?.goals`). A missing / non-array
// input yields an empty district rather than a crash. Goals beyond MONUMENTS.maxMonuments
// fold into an `overflow` marker placed just past the end of the row.
export function computeGoalMonuments(goals, now = Date.now()) {
  const list = Array.isArray(goals) ? goals.filter((g) => g && typeof g === 'object') : [];

  // Stable ordering so the row doesn't reshuffle across refetches: completed first
  // (trophies up front), then active, then stalled, then abandoned; ties broken by id.
  const order = { completed: 0, active: 1, stalled: 2, abandoned: 3 };
  const ranked = list
    .map((goal) => ({ goal, status: effectiveGoalStatus(goal, now) }))
    .sort((a, b) => {
      const sa = order[a.status] ?? 9;
      const sb = order[b.status] ?? 9;
      if (sa !== sb) return sa - sb;
      return String(a.goal?.id || '').localeCompare(String(b.goal?.id || ''));
    });

  const visible = ranked.slice(0, MONUMENTS.maxMonuments);
  const overflowCount = Math.max(0, ranked.length - visible.length);

  const monuments = visible.map(({ goal }, index) =>
    placeMonument(goal, index, visible.length, now)
  );

  // Overflow marker sits one slot past the right end of the row.
  let overflow = null;
  if (overflowCount > 0) {
    const offset = (visible.length - (visible.length - 1) / 2) * MONUMENTS.spacing;
    overflow = {
      count: overflowCount,
      position: [MONUMENTS.base[0] + offset, 0, MONUMENTS.z],
    };
  }

  const completedCount = ranked.filter((r) => r.status === 'completed').length;
  const activeCount = ranked.filter((r) => r.status === 'active').length;

  return {
    base: MONUMENTS.base,
    monuments,
    overflow,
    total: ranked.length,
    completedCount,
    activeCount,
    hasData: ranked.length > 0,
  };
}
