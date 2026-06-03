/**
 * CoS Runner — State persistence layer
 *
 * Owns the on-disk runner-state.json: atomic writes, serialized saves, and
 * loads. Kept self-contained (only fs + the shared fileUtils helper) so the
 * isolated `portos-cos` PM2 process stays standalone.
 */

import { join, dirname } from 'path';
import { writeFile, readFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { ensureDir, PATHS } from '../lib/fileUtils.js';

export const STATE_FILE = join(PATHS.cos, 'runner-state.json');

export const DEFAULT_STATE = { agents: {}, stats: { spawned: 0, completed: 0, failed: 0 } };

const freshState = () => ({ ...DEFAULT_STATE, agents: {}, stats: { ...DEFAULT_STATE.stats } });

// Serializes saves so concurrent writes can't interleave and corrupt the file.
let stateLock = Promise.resolve();

/**
 * Write state atomically using temp file + rename to prevent partial-write corruption
 */
export async function atomicWrite(filePath, data) {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  await writeFile(tmpPath, data);
  await rename(tmpPath, filePath);
}

/**
 * Load runner state from disk
 */
export async function loadState() {
  if (!existsSync(STATE_FILE)) return freshState();

  const content = await readFile(STATE_FILE, 'utf-8');
  if (!content || !content.trim()) return freshState();

  return JSON.parse(content);
}

/**
 * Save runner state to disk (serialized with atomic writes to prevent corruption)
 */
export function saveState(state) {
  stateLock = stateLock.then(async () => {
    const dir = dirname(STATE_FILE);
    if (!existsSync(dir)) await ensureDir(dir);
    await atomicWrite(STATE_FILE, JSON.stringify(state, null, 2));
  });
  return stateLock;
}
