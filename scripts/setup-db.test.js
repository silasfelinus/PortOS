import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// setup-db.js executes top-level setup logic on import (it's a CLI entrypoint),
// so we can't import it without running the whole flow. Following the repo
// convention for pure-logic coverage, we copy the menu-choice resolver inline
// and assert its post-Phase-1 contract: only Docker (1) and Native (2) are
// offered — file (the deprecated "3") is no longer a normal menu choice.
//
// Keep this in sync with promptStorageChoice() in setup-db.js.
function resolveMenuChoice(answer) {
  const trimmed = String(answer).trim();
  if (trimmed === '2') return 'native';
  return 'exit'; // 1 or default = they want docker, so exit to install it
}

describe('setup-db menu choice resolver (Phase 1: Postgres mandatory)', () => {
  it('maps "2" to native', () => {
    expect(resolveMenuChoice('2')).toBe('native');
  });

  it('maps "1" (and default/empty) to docker exit', () => {
    expect(resolveMenuChoice('1')).toBe('exit');
    expect(resolveMenuChoice('')).toBe('exit');
    expect(resolveMenuChoice('  ')).toBe('exit');
  });

  it('no longer offers file storage as a numbered choice — "3" is not "file"', () => {
    expect(resolveMenuChoice('3')).not.toBe('file');
    // Any out-of-range answer falls through to the docker-install path.
    expect(resolveMenuChoice('3')).toBe('exit');
    expect(resolveMenuChoice('file')).toBe('exit');
  });

  // Guard against drift: setup-db.js runs its CLI flow on import so we can't
  // import promptStorageChoice directly. Instead assert the real source still
  // matches the inline copy's contract — the [1/2] prompt is present and no
  // numbered "file" branch was re-added. If promptStorageChoice changes, this
  // forces the copy above to be updated in lockstep.
  it('real setup-db.js source matches the inline resolver contract', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'setup-db.js'), 'utf8');
    expect(src).toContain("Enter choice [1/2]:");
    expect(src).toContain("if (trimmed === '2') resolve('native');");
    expect(src).not.toMatch(/resolve\('file'\)/);
  });
});
