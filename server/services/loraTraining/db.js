/**
 * LoRA training run records — PostgreSQL adapter (`lora_training_runs`).
 *
 * One row per run: id/status/character_id mirrored as columns for
 * filtering, the full record in `data` JSONB (returned verbatim — columns
 * are never read back). Single writer (the training service) per run, so
 * plain read-modify-write suffices; no row locking needed. Mirrors the
 * `creative_director_projects` adapter pattern.
 */

import { query } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';

const rowToRun = (row) => row?.data ?? null;

async function persist(run) {
  await query(
    `INSERT INTO lora_training_runs (id, status, character_id, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       character_id = EXCLUDED.character_id,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at`,
    [
      run.id,
      run.status,
      run.character?.entryId || null,
      JSON.stringify(run),
      run.createdAt || new Date().toISOString(),
      new Date().toISOString(),
    ],
  );
  return run;
}

export async function createRun(run) {
  return persist(run);
}

export async function getRun(id) {
  const result = await query('SELECT data FROM lora_training_runs WHERE id = $1', [id]);
  return rowToRun(result.rows[0]);
}

export async function getRunRequired(id) {
  const run = await getRun(id);
  if (!run) {
    throw new ServerError(`Training run not found: ${id}`, { status: 404, code: 'NOT_FOUND' });
  }
  return run;
}

/** Read-modify-write. `patch` is an object merged shallowly, or a function. */
export async function updateRun(id, patch) {
  const current = await getRunRequired(id);
  const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
  if (!next) return current;
  next.updatedAt = new Date().toISOString();
  return persist(next);
}

export async function listRuns({ status = null, characterId = null, datasetId = null, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (characterId) { params.push(characterId); where.push(`character_id = $${params.length}`); }
  if (datasetId) { params.push(datasetId); where.push(`data->>'datasetId' = $${params.length}`); }
  params.push(Math.max(1, Math.min(500, limit)));
  const result = await query(
    `SELECT data FROM lora_training_runs
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(rowToRun).filter(Boolean);
}

export async function deleteRun(id) {
  await query('DELETE FROM lora_training_runs WHERE id = $1', [id]);
  return { ok: true, id };
}

/** Runs persisted as queued/running — boot-time reconcile targets. */
export async function listActiveRuns() {
  const result = await query(
    `SELECT data FROM lora_training_runs WHERE status IN ('queued', 'running')`,
  );
  return result.rows.map(rowToRun).filter(Boolean);
}
