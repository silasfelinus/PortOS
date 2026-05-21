/**
 * Test for migration 010 — cos-agent-briefing.md drops the obsolete header
 * and role-play preamble.
 *
 * Picked up via the vitest include glob in server/vitest.config.js
 * (`../scripts/migrations/**\/*.test.js`).
 */
import { describe } from 'vitest';

import { runPromptMigrationTests } from './_testHelpers.js';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './010-simplify-cos-agent-briefing.js';

describe('migration 010 — cos-agent-briefing preamble cleanup', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-010-',
  });
});
