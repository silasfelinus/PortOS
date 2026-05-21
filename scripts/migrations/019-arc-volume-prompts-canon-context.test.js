/**
 * Test for migration 019 — arc/volume prompt templates gain {{worldCanonText}}
 * (gated by {{#hasLinkedWorld}}).
 *
 * Picked up via the vitest include glob in server/vitest.config.js
 * (`../scripts/migrations/**\/*.test.js`).
 */
import { describe } from 'vitest';

import { runPromptMigrationTests } from './_testHelpers.js';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './019-arc-volume-prompts-canon-context.js';

describe('migration 019 — arc/volume prompt canon context', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-019-',
  });
});
