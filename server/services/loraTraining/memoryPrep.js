/**
 * Memory preparation for LoRA training runs.
 *
 * Training shares the Apple-Silicon unified-memory pool with every other
 * resident model server (ollama, LM Studio) and with PortOS itself. A run that
 * oversubscribes the pool swap-thrashes — ~21 GB of swap was live during the
 * GPU watchdog-timeout reboots documented in
 * docs/research/2026-06-13-mflux-training-watchdog-panic.md. Before spawning a
 * trainer we (1) unload resident LLMs to reclaim their memory and (2) measure
 * the real available headroom so the caller can size the run config to what's
 * actually free and refuse to start (rather than crash mid-run) when the pool
 * is too tight.
 *
 * Everything here is best-effort and never throws — a failed unload or an
 * unreadable vm_stat must not block training; it just yields a more
 * conservative (smaller) memory budget.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { platform, freemem, totalmem } from 'os';
import { getLoadedModels as ollamaLoadedModels, unloadModel as ollamaUnload } from '../ollamaManager.js';
import { getLoadedModels as lmStudioLoadedModels, unloadModel as lmStudioUnload } from '../lmStudioManager.js';

const execFileAsync = promisify(execFile);
const GB = 2 ** 30;

// Headroom floor: below this even a 4-bit 4B run risks swap-thrash, so refuse
// to start rather than reboot the box. Tuned for the smallest supported run;
// larger variants are protected by the budget-derived quantize/low_ram tiers.
export const TRAINING_MIN_HEADROOM_GB = 24;

/**
 * Best-effort: unload every model currently resident in ollama and LM Studio so
 * its unified memory returns to the pool before a training run. Each unload is
 * independent — failures (server down, model already expired) are swallowed.
 * Returns the list of freed model labels for logging. Never throws.
 */
export async function unloadResidentModels() {
  const unloaded = [];

  const ollamaLoaded = await ollamaLoadedModels().catch(() => []);
  for (const m of ollamaLoaded) {
    const name = m?.name || m?.id;
    if (!name) continue;
    const res = await ollamaUnload(name).catch(() => null);
    if (res?.unloaded) unloaded.push(`ollama:${name}`);
  }

  const lmLoaded = await lmStudioLoadedModels(true).catch(() => []);
  for (const m of lmLoaded) {
    if (!m?.id) continue;
    const res = await lmStudioUnload(m.id).catch(() => null);
    if (res?.success) unloaded.push(`lmstudio:${m.id}`);
  }

  return unloaded;
}

const parsePageSize = (out) => {
  const m = out.match(/page size of (\d+) bytes/);
  return m ? Number(m[1]) : 4096;
};

/**
 * Parse `vm_stat` for the memory macOS can actually hand to a new process —
 * free + inactive + speculative + purgeable pages (the same buckets Activity
 * Monitor reclaims under pressure). Node's freemem() counts only truly-free
 * pages and so wildly understates available unified memory on macOS, which
 * keeps most RAM as reclaimable cache. Returns GB, or null if unparseable.
 */
async function darwinAvailableGb() {
  const { stdout } = await execFileAsync('vm_stat');
  const pageSize = parsePageSize(stdout);
  const pages = (label) => {
    const m = stdout.match(new RegExp(`${label}:\\s+(\\d+)\\.`));
    return m ? Number(m[1]) : 0;
  };
  const available = pages('Pages free') + pages('Pages inactive')
    + pages('Pages speculative') + pages('Pages purgeable');
  if (!available) return null;
  return (available * pageSize) / GB;
}

/**
 * Memory the OS can realistically give a training run right now, in GB. Uses
 * vm_stat on darwin (unified-memory-aware), falling back to freemem() on other
 * platforms or any failure. Never throws.
 */
export async function getAvailableMemoryGb() {
  if (platform() === 'darwin') {
    const v = await darwinAvailableGb().catch(() => null);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return freemem() / GB;
}

/**
 * Reclaim memory and report the budget for sizing/gating a training run:
 *   - unloaded: labels of resident models freed
 *   - availableGb: memory free after unloading
 *   - totalGb: physical RAM
 *   - budgetGb: what training may use (available, clamped to physical) — feed
 *     this to deriveMfluxMemoryConfig so the quantize/low_ram tier reflects
 *     real headroom, not raw RAM. Never throws.
 */
export async function prepareMemoryForTraining() {
  const unloaded = await unloadResidentModels().catch(() => []);
  const availableGb = await getAvailableMemoryGb().catch(() => 0);
  const totalGb = totalmem() / GB;
  const budgetGb = Math.min(totalGb, availableGb);
  return { unloaded, availableGb, totalGb, budgetGb };
}
