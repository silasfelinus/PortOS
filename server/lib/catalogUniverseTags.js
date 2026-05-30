/**
 * Friendly universe-tag transforms for catalog ingredients backfilled from
 * universe canon.
 *
 * The original bible→catalog backfill stamped MACHINE tags onto every promoted
 * character/place/object: a literal `from-universe` marker plus a
 * `universe:<universeId>` id tag. Those are unreadable in the Catalog UI (a raw
 * UUID is meaningless to a human) and they leak an internal id into the tag
 * taxonomy. The structured universe link is already durable in
 * `catalog_ingredient_refs` (refKind `universe`, role `canon-<kind>`), so the
 * tag does NOT need to carry the id for querying — the ref table owns that.
 *
 * These pure helpers replace the machine tags with the friendly universe NAME
 * tag (e.g. "My Cool Universe") while preserving every user-supplied tag. They
 * are used by:
 *   - the boot-time data repair (`server/scripts/repairUniverseTags.js`) that
 *     rewrites existing rows once per install, and
 *   - the bible→catalog backfill (`server/scripts/migrateBibleToCatalog.js`)
 *     so NEW promotions stamp the friendly tag from the start.
 *
 * Pure + dependency-free so they unit-test without a DB.
 */

// The legacy machine marker tag (no id).
export const LEGACY_UNIVERSE_MARKER_TAG = 'from-universe';

// Prefix of the legacy id-carrying tag (`universe:<universeId>`).
export const LEGACY_UNIVERSE_ID_TAG_PREFIX = 'universe:';

/**
 * True when `tag` is one of the legacy machine universe tags
 * (`from-universe` or `universe:<id>`). Case-insensitive on the marker; the
 * id-tag match is prefix-based so any `universe:<anything>` is caught.
 */
export function isLegacyUniverseTag(tag) {
  if (typeof tag !== 'string') return false;
  const t = tag.trim().toLowerCase();
  if (t === LEGACY_UNIVERSE_MARKER_TAG) return true;
  return t.startsWith(LEGACY_UNIVERSE_ID_TAG_PREFIX);
}

/**
 * Extract the universe id from a legacy `universe:<id>` tag, or null when the
 * tag isn't an id tag. The marker tag (`from-universe`) returns null — it
 * carries no id.
 */
export function universeIdFromLegacyTag(tag) {
  if (typeof tag !== 'string') return null;
  const t = tag.trim();
  if (!t.toLowerCase().startsWith(LEGACY_UNIVERSE_ID_TAG_PREFIX)) return null;
  const id = t.slice(LEGACY_UNIVERSE_ID_TAG_PREFIX.length).trim();
  return id || null;
}

/**
 * Compute the friendly tag set for an ingredient's tags.
 *
 * - Strips every legacy machine universe tag (`from-universe`, `universe:<id>`).
 * - For each distinct universe id found in those legacy id tags, appends the
 *   friendly universe NAME (resolved via `nameForId(id)`) when one resolves.
 * - Preserves every other (user-supplied) tag, in order, de-duplicated by
 *   `canonicalKey` against both the kept tags AND the names just added (so
 *   "My Universe" and "my universe" don't both appear).
 * - When a universe id can't be resolved to a name (deleted universe, missing
 *   lookup), the id tag is still dropped but no name is added — the structured
 *   ref remains the source of truth, and re-running the repair after the
 *   universe re-syncs picks the name up.
 *
 * Returns `{ tags, changed }`. `changed` is false when nothing was rewritten,
 * so callers can skip a no-op DB write.
 *
 * @param {string[]} tags          existing ingredient tags
 * @param {(id:string)=>string|null|undefined} nameForId   universe id → name
 * @param {(label:string)=>string} canonicalKey            tag dedup key fn
 */
export function friendlifyUniverseTags(tags, nameForId, canonicalKey) {
  const input = Array.isArray(tags) ? tags : [];
  const kept = [];
  const universeIds = [];
  let sawLegacy = false;

  for (const tag of input) {
    if (isLegacyUniverseTag(tag)) {
      sawLegacy = true;
      const id = universeIdFromLegacyTag(tag);
      if (id && !universeIds.includes(id)) universeIds.push(id);
      continue;
    }
    kept.push(tag);
  }

  // Resolve names for every distinct universe id; skip unresolved ones.
  const names = [];
  for (const id of universeIds) {
    const name = nameForId(id);
    if (typeof name === 'string' && name.trim()) names.push(name.trim());
  }

  // De-dup the friendly names against kept tags + each other.
  const seen = new Set(kept.map((t) => canonicalKey(t)));
  const addedNames = [];
  for (const name of names) {
    const key = canonicalKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    addedNames.push(name);
  }

  const result = [...kept, ...addedNames];
  // `changed` when we stripped any legacy tag OR added any friendly name.
  // (A row could carry `universe:<id>` whose name dedups against an existing
  // user tag — still changed, because the machine tag was removed.)
  const changed = sawLegacy || addedNames.length > 0;
  return { tags: result, changed };
}
