/**
 * Seed the three new intent-named built-in dashboard layouts into installs
 * that already have a persisted `data/dashboard-layouts.json`.
 *
 * Background:
 *   `server/services/dashboardLayouts.js#DEFAULT_LAYOUTS` ships
 *   `deep-work`, `health`, and `agent-watch` alongside the original four
 *   built-ins. `getState()` returns the sanitized persisted layouts whenever
 *   the file exists, so adding new built-ins in code only affects fresh
 *   installs — existing users never see them.
 *
 *   This migration walks `data/dashboard-layouts.json` and inserts any of
 *   the three new built-ins that aren't already present, with their
 *   server-side default grid. Re-runs detect each layout already exists by
 *   id and skip, so the migration is idempotent.
 *
 *   If the user previously deleted one of the new built-in ids (the
 *   `health` widget doesn't survive deletion of a built-in today because
 *   built-ins are guarded — but a hand-edit could remove it), we will
 *   re-seed it. This matches the behavior of the fresh-install path.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { INTENT_LAYOUTS } from '../../server/services/dashboardLayouts.js';

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'dashboard-layouts.json');
    const raw = await readFile(path, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📦 migration 030: no dashboard-layouts.json yet — fresh install will seed from defaults.`);
      return { updated: 0, reason: 'no-state' };
    }
    let doc;
    try { doc = JSON.parse(raw); } catch {
      console.log(`📦 migration 030: dashboard-layouts.json unreadable — skipping.`);
      return { updated: 0, reason: 'unreadable' };
    }
    if (!doc || !Array.isArray(doc.layouts)) {
      return { updated: 0, reason: 'no-layouts-array' };
    }

    const existingIds = new Set(doc.layouts.map((l) => l?.id).filter(Boolean));
    const toAdd = INTENT_LAYOUTS.filter((l) => !existingIds.has(l.id));
    if (toAdd.length === 0) {
      console.log(`📦 migration 030: intent layouts already present.`);
      return { updated: 0, reason: 'already-applied' };
    }

    doc.layouts.push(...toAdd.map((l) => ({ ...l, builtIn: true })));
    await writeFile(path, JSON.stringify(doc, null, 2));
    console.log(`📦 migration 030: seeded ${toAdd.length} intent layout(s) (${toAdd.map((l) => l.id).join(', ')}).`);
    return { updated: toAdd.length };
  },
};
