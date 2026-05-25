/**
 * Global Vitest setup — peer fan-out firewall.
 *
 * WHY: `createUniverse` / `createSeries` / `createIssue` fire a non-awaited
 * `autoSubscribeRecordToAllPeers` call after creation.  That path reads the
 * real `data/instances.json` via `getPeers()` and then issues live HTTP POSTs
 * to any registered peers (e.g. the user's `null` sync machine).  Without a
 * global guard, every `npm test` run creates spurious records on live peers.
 *
 * WHAT: This file is loaded by Vitest as a `setupFiles` entry (see
 * `vitest.config.js`).  It registers a global `vi.mock` for
 * `services/instances.js` that forces `getPeers` to return `[]` while
 * preserving all other real exports via `importActual`.  Uses the shared
 * `mockNoPeers` helper from `lib/mockPathsDataRoot.js` — the same factory
 * the existing point-fix mocks use — so the behavior is identical.
 *
 * SCOPE: The mock is applied before every test file.  All test files that
 * already call `vi.mock('./instances.js', …)` (or `vi.mock('../instances.js',
 * …)`) at their own file level will have their per-suite factory win over this
 * global one — Vitest resolves both to the same module path and the last
 * registered factory for a module wins per-suite.  Those existing point-fix
 * mocks therefore remain harmless and do not need to be removed.
 *
 * OPT-OUT (rare — only needed when a suite tests the real `instances.js`
 * implementation, such as `instances.test.js`):
 *
 *   Option A — cancel the global mock so the real module is used; mock its
 *   own dependencies instead to make behaviour deterministic:
 *
 *     vi.unmock('./instances.js');   // path relative to the test file; hoisted
 *
 *   Option B — keep the mock but replace getPeers with a vi.fn() so the suite
 *   can control per-test return values (used by syncOrchestrator, peerSync, …):
 *
 *     vi.mock('./instances.js', () => ({ getPeers: vi.fn(), … }));
 *
 *   Both forms are standard Vitest patterns; no helper or flag is needed.
 *   See `server/services/instances.test.js` (Option A) and the sharing/
 *   suites (Option B) for working examples.
 */

import { mockNoPeers } from './lib/mockPathsDataRoot.js';

// Path is relative to the project root (server/) as required by Vitest
// setupFiles resolution — it resolves to the same module as any
// `./instances.js` or `../instances.js` reference used in test files.
vi.mock('./services/instances.js', async (importOriginal) => {
  const actual = await importOriginal();
  return mockNoPeers(actual);
});
