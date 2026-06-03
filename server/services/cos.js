/**
 * Chief of Staff (CoS) Service
 *
 * Manages the autonomous agent manager that watches TASKS.md,
 * spawns sub-agents, and orchestrates task completion.
 *
 * Decomposed modules:
 * - cosState.js          — shared state management (loadState, saveState, config, mutex)
 * - cosAgents.js         — agent lifecycle (register, complete, archive, feedback)
 * - cosReports.js        — reports, briefings, and activity tracking
 * - cosEvents.js         — event emitter and logging
 * - cosHealthMonitor.js  — daemon health checks (PM2/memory, auto-restart)
 */

import { readFile, writeFile, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { getActiveProvider } from './providers.js';
import { isInternalTaskId } from '../lib/taskParser.js';
import { isAppOnCooldown, markAppReviewStarted, clearStaleActiveAgents } from './appActivity.js';
import { getActiveApps } from './apps.js';
import { getPerformanceSummary, checkAndRehabilitateSkippedTasks, getLearningInsights } from './taskLearning.js';
import { schedule as scheduleEvent, cancel as cancelEvent, getStats as getSchedulerStats, parseCronToNextRun } from './eventScheduler.js';
import { generateProactiveTasks as generateMissionTasks } from './missions.js';
import { generateTaskFromJob, recordJobExecution, recordJobGateSkip, isScriptJob, executeScriptJob, isShellJob, executeShellJob } from './autonomousJobs.js';
import { checkJobGate, hasGate } from './jobGates.js';
import { formatDuration, safeJSONParse } from '../lib/fileUtils.js';
import { addNotification, NOTIFICATION_TYPES } from './notifications.js';
import { getUserTimezone, getLocalParts, nextLocalTime, todayInTimezone } from '../lib/timezone.js';

// Shared state management (extracted to avoid circular deps)
import { loadState, saveState, withStateLock, ensureDirectories, isImprovementEnabled, AGENTS_DIR, REPORTS_DIR, SCRIPTS_DIR, ROOT_DIR, isDaemonRunning, setDaemonRunning } from './cosState.js';

// Events and logging (canonical source: cosEvents.js)
import { cosEvents, emitLog } from './cosEvents.js';
export { cosEvents, emitLog };

// Agent lifecycle (re-export for backward compat with `import * as cos`)
export { registerAgent, updateAgent, completeAgent, appendAgentOutput, getAgents, getAgentDates, getAgentsByDate, getAgent, getAgentPrompt, terminateAgent, pauseAgent, killAgent, sendBtwToAgent, getAgentProcessStats, cleanupZombieAgents, deleteAgent, submitAgentFeedback, getFeedbackStats, extractTaskType, archiveStaleAgents, clearCompletedAgents, pruneOldAgentArchives } from './cosAgents.js';

// Reports and activity (re-export for backward compat with `import * as cos`)
export { generateReport, getReport, getTodayReport, listReports, listBriefings, getBriefing, getLatestBriefing, getTodayActivity, getRecentTasks, formatRelativeTime } from './cosReports.js';

// Health monitoring (imported for internal use by start()/init() and re-exported
// for backward compat with `import * as cos` and the cos route handlers)
import { runHealthCheck, getHealthStatus } from './cosHealthMonitor.js';
export { runHealthCheck, getHealthStatus };

// Task store: CRUD + queue persistence (TASKS.md / COS-TASKS.md). Imported for
// internal use by evaluateTasks/dequeueNextTask/generators and re-exported for
// backward compat with `import * as cos` and the cos route handlers. The store
// emits `tasks:changed`; init() below turns that into tryImmediateSpawn /
// dequeueNextTask so the spawn-side logic stays here, not in the store.
import { firstLine, PRIORITY_VALUES, getUserTasks, getCosTasks, getAllTasks, getTasks, getTaskById, addTask, updateTask, deleteTask, reorderTasks, approveTask } from './cosTaskStore.js';
export { firstLine, getUserTasks, getCosTasks, getAllTasks, getTasks, getTaskById, addTask, updateTask, deleteTask, reorderTasks, approveTask };

const AGENT_ARCHIVE_RETENTION_DAYS = 90;
const RESUME_DEQUEUE_DELAY_MS = 500;
// CD recovery normally resolves in <100ms; hold start() at most this long so
// a stuck recovery doesn't block daemon boot indefinitely.
const CD_RECOVERY_BOOT_TIMEOUT_MS = 60_000;
// Initial idle-review queue kicks off after start() — far enough back that
// a fresh install isn't overwhelmed but close enough to not stall users.
const POST_STARTUP_QUEUE_DELAY_MS = 30_000;
// A task whose agent reported completed within this window is treated as
// "recently completed" and protected from resetOrphanedTasks's reaper.
const RECENT_COMPLETION_GRACE_MS = 60_000;

// Internal imports for functions used in this module
import { pruneOldAgentArchives, archiveStaleAgents as _archiveStaleAgents, loadAgentIndex } from './cosAgents.js';

// Task generation + evaluation engine (extracted to cosTaskGenerator.js).
// `evaluateTasks` and the generators emit `task:ready`; the spawn-side
// scheduler (dequeueNextTask / tryImmediateSpawn) below reacts to that. Most of
// these are imported for internal use by the scheduler; checkStagePrecondition
// and applyAppWorktreeDefault are re-exported for agentLifecycle.js and
// subAgentSpawner, and evaluateTasks for the cos route + `import * as cos`.
import {
  evaluateTasks,
  generateIdleReviewTask,
  queueEligibleImprovementTasks,
  generateSelfImprovementTaskForType,
  generateManagedAppImprovementTaskForType,
  blockIfExceedsMaxSpawns,
  countRunningAgentsByProject,
  isWithinProjectLimit,
  checkStagePrecondition,
  applyAppWorktreeDefault
} from './cosTaskGenerator.js';
export { evaluateTasks, checkStagePrecondition, applyAppWorktreeDefault };

/**
 * Get current CoS status
 */
export async function getStatus() {
  const state = await loadState();
  const provider = await getActiveProvider();
  const idx = await loadAgentIndex();

  // Count active agents from state
  const activeAgents = Object.values(state.agents).filter(a => a.status === 'running').length;
  const pausedAgents = Object.values(state.agents).filter(a => a.status === 'paused').length;

  // Derive tasksCompleted from union of index (disk) + state completed agents,
  // since state.stats.tasksCompleted can drift after state resets
  const stateCompletedIds = Object.keys(state.agents).filter(id => state.agents[id].status === 'completed');
  const stateOnlyCompleted = stateCompletedIds.filter(id => !idx.has(id)).length;
  const tasksCompleted = Math.max(state.stats.tasksCompleted, idx.size + stateOnlyCompleted);

  return {
    running: isDaemonRunning(),
    paused: state.paused || false,
    pausedAt: state.pausedAt,
    pauseReason: state.pauseReason,
    config: state.config,
    stats: { ...state.stats, tasksCompleted },
    activeAgents,
    pausedAgents,
    provider: provider ? { id: provider.id, name: provider.name } : null
  };
}

/**
 * Get current configuration
 */
export async function getConfig() {
  const state = await loadState();
  return state.config;
}

/**
 * Update configuration
 */
export async function updateConfig(updates) {
  const config = await withStateLock(async () => {
    const state = await loadState();
    state.config = { ...state.config, ...updates };
    await saveState(state);
    return state.config;
  });
  cosEvents.emit('config:changed', config);
  return config;
}

/**
 * Start the CoS daemon
 */
export async function start() {
  if (isDaemonRunning()) {
    emitLog('warn', 'CoS already running');
    return { success: false, error: 'Already running' };
  }

  emitLog('info', 'Starting Chief of Staff daemon...');

  const state = await withStateLock(async () => {
    const s = await loadState();
    s.running = true;
    await saveState(s);
    return s;
  });

  setDaemonRunning(true);

  // First clean up orphaned agents (agents marked running but no live process)
  const { cleanupOrphanedAgents } = await import('./subAgentSpawner.js');
  const cleanedAgents = await cleanupOrphanedAgents();
  if (cleanedAgents > 0) {
    emitLog('info', `Cleaned up ${cleanedAgents} orphaned agent(s)`);
  }

  // Wait for Creative Director boot recovery to finish retiring stale CD
  // tasks before we reset orphans. Without this gate, resetOrphanedTasks
  // would respawn stale CD treatment/evaluate tasks before recovery can
  // mark them `completed`, racing two agents on the same project. The
  // promise resolves whether recovery ran successfully, was a no-op (no
  // mid-flight projects), or wasn't called at all (markRecoveryDone is
  // exposed for that case). 60s ceiling — recovery on a healthy boot
  // resolves in <100ms, but we'd rather pay a slow-boot tax than reopen
  // the duplicate-agent race when initMediaJobQueue or earlier startup
  // steps stall.
  const { cdRecoveryDone } = await import('./creativeDirector/recovery.js');
  await Promise.race([
    cdRecoveryDone,
    new Promise((resolve) => setTimeout(resolve, CD_RECOVERY_BOOT_TIMEOUT_MS)),
  ]);

  // Then reset any orphaned in_progress tasks (no running agent)
  await resetOrphanedTasks();

  // Clear stale activeAgentId pointers in app-activity.json. Without this, an
  // idle-review agent that died across a restart (or a long-stale Feb-era state
  // file) leaves activeAgentId set forever — isAppOnCooldown treats that as
  // "agent still working" and queueEligibleImprovementTasks silently skips the
  // app every cycle. Re-load state since the orphan-cleanup steps above have
  // already mutated the on-disk agents map.
  const freshState = await loadState();
  const liveAgentIds = new Set(Object.keys(freshState.agents || {}));
  const { cleared: clearedActiveAgents } = await clearStaleActiveAgents(liveAgentIds).catch(() => ({ cleared: [] }));
  if (clearedActiveAgents.length > 0) {
    emitLog('info', `🧹 Cleared ${clearedActiveAgents.length} stale activeAgentId pointer(s) from app-activity`);
  }

  // Archive stale completed agents from state.json on startup
  const { archived } = await _archiveStaleAgents().catch(() => ({ archived: 0 }));
  if (archived > 0) {
    emitLog('info', `📦 Startup: archived ${archived} stale agent(s) from state`);
  }

  // Prune agent archives older than 90 days
  await pruneOldAgentArchives(AGENT_ARCHIVE_RETENTION_DAYS).catch(err =>
    console.warn(`⚠️ pruneOldAgentArchives failed: ${err?.message || err}`)
  );

  // Health check + orphan cleanup (15 min)
  scheduleEvent({
    id: 'cos-health-check',
    type: 'interval',
    intervalMs: state.config.healthCheckIntervalMs,
    handler: async () => {
      await runHealthCheck();
      const cleaned = await cleanupOrphanedAgents();
      if (cleaned > 0) {
        emitLog('info', `🧹 Periodic cleanup: ${cleaned} orphaned agent(s)`);
      }
      await resetOrphanedTasks();
      const { archived } = await _archiveStaleAgents().catch(() => ({ archived: 0 }));
      if (archived > 0) {
        emitLog('info', `📦 Auto-archived ${archived} stale agent(s) from state`);
      }
    },
    metadata: { description: 'CoS health check + orphan cleanup + agent archival' }
  });

  // Performance summary (10 min)
  scheduleEvent({
    id: 'cos-performance-summary',
    type: 'interval',
    intervalMs: 10 * 60 * 1000,
    handler: async () => {
      const perfSummary = await getPerformanceSummary().catch(() => null);
      if (perfSummary && perfSummary.totalCompleted > 0) {
        emitLog('info', `Performance: ${perfSummary.overallSuccessRate}% success over ${perfSummary.totalCompleted} tasks`, {
          successRate: perfSummary.overallSuccessRate,
          totalCompleted: perfSummary.totalCompleted,
          topPerformers: perfSummary.topPerformers.length,
          needsAttention: perfSummary.needsAttention.length
        });
      }
    },
    metadata: { description: 'CoS performance summary' }
  });

  // Learning insights (20 min)
  scheduleEvent({
    id: 'cos-learning-insights',
    type: 'interval',
    intervalMs: 20 * 60 * 1000,
    handler: async () => {
      const learningInsights = await getLearningInsights().catch(() => null);
      if (learningInsights?.recommendations?.length > 0) {
        const recommendations = learningInsights.recommendations.slice(0, 3);
        for (const rec of recommendations) {
          const level = rec.type === 'warning' ? 'warn' : rec.type === 'action' ? 'info' : 'debug';
          emitLog(level, `🧠 Learning: ${rec.message}`, { recommendationType: rec.type });
        }
        cosEvents.emit('learning:recommendations', {
          recommendations,
          insights: {
            bestPerforming: learningInsights.insights?.bestPerforming?.slice(0, 2) || [],
            worstPerforming: learningInsights.insights?.worstPerforming?.slice(0, 2) || [],
            commonErrors: learningInsights.insights?.commonErrors?.slice(0, 2) || []
          },
          totals: learningInsights.totals
        });
      }
    },
    metadata: { description: 'CoS learning insights' }
  });

  // Rehabilitation check (2 hours)
  scheduleEvent({
    id: 'cos-rehabilitation-check',
    type: 'interval',
    intervalMs: 2 * 60 * 60 * 1000,
    handler: async () => {
      const s = await loadState();
      const gracePeriodMs = (s.config.rehabilitationGracePeriodDays || 7) * 24 * 60 * 60 * 1000;
      const result = await checkAndRehabilitateSkippedTasks(gracePeriodMs).catch(() => ({ count: 0 }));
      if (result.count > 0) {
        emitLog('success', `Auto-rehabilitated ${result.count} skipped task type(s)`, {
          rehabilitated: result.rehabilitated?.map(r => r.taskType) || []
        });
      }
    },
    metadata: { description: 'CoS rehabilitation check for skipped tasks' }
  });

  // Register autonomous job schedules (individual timers per job)
  await registerJobSchedules();

  // Schedule improvement task checks based on next due time
  await scheduleNextImprovementCheck();

  // Run initial evaluation to pick up existing pending tasks, then health check
  // Skip improvement task generation on startup to avoid spawning agents on fresh installs
  emitLog('info', 'Running initial task evaluation...');
  await evaluateTasks({ initialStartup: true });
  await runHealthCheck();

  cosEvents.emit('status', { running: true });
  emitLog('success', 'CoS daemon started');

  // Queue due improvement tasks shortly after startup (not during initial eval
  // to avoid overwhelming fresh installs, but soon enough to not stall)
  setTimeout(() => {
    if (!isDaemonRunning()) return;
    loadState().then(async (state) => {
      if (!state.config.idleReviewEnabled) return;
      const cosTaskData = await getCosTasks();
      await queueEligibleImprovementTasks(state, cosTaskData);
      setImmediate(() => dequeueNextTask());
    }).catch(err => emitLog('warn', `Post-startup improvement queuing failed: ${err.message}`));
  }, POST_STARTUP_QUEUE_DELAY_MS);

  return { success: true };
}

/**
 * Stop the CoS daemon
 */
export async function stop() {
  if (!isDaemonRunning()) {
    return { success: false, error: 'Not running' };
  }

  // Cancel all scheduled events
  cancelEvent('cos-health-check');
  cancelEvent('cos-performance-summary');
  cancelEvent('cos-learning-insights');
  cancelEvent('cos-rehabilitation-check');
  cancelEvent('cos-improvement-check');
  await unregisterJobSchedules();

  await withStateLock(async () => {
    const state = await loadState();
    state.running = false;
    await saveState(state);
  });

  setDaemonRunning(false);
  cosEvents.emit('status', { running: false });
  return { success: true };
}

/**
 * Pause the CoS daemon (for always-on mode)
 * Daemon stays running but skips evaluations
 */
export async function pause(reason = null) {
  return withStateLock(async () => {
    const state = await loadState();

    if (state.paused) {
      return { success: false, error: 'Already paused' };
    }

    state.paused = true;
    state.pausedAt = new Date().toISOString();
    state.pauseReason = reason;
    await saveState(state);

    emitLog('info', `CoS paused${reason ? `: ${reason}` : ''}`);
    cosEvents.emit('status:paused', { paused: true, pausedAt: state.pausedAt, reason });
    return { success: true, pausedAt: state.pausedAt };
  });
}

/**
 * Resume the CoS daemon from pause
 */
export async function resume() {
  const result = await withStateLock(async () => {
    const state = await loadState();

    if (!state.paused) {
      return { success: false, error: 'Not paused' };
    }

    state.paused = false;
    state.pausedAt = null;
    state.pauseReason = null;
    await saveState(state);

    emitLog('info', 'CoS resumed');
    cosEvents.emit('status:resumed', { paused: false });
    return { success: true };
  });

  // Trigger immediate task dequeue on resume (outside lock to avoid holding it)
  if (result.success && isDaemonRunning()) {
    setTimeout(() => dequeueNextTask(), RESUME_DEQUEUE_DELAY_MS);
  }

  return result;
}

/**
 * Check if CoS is paused
 */
export async function isPaused() {
  const state = await loadState();
  return state.paused || false;
}

/**
 * Force-spawn a pending task by ID, bypassing cooldowns and evaluation intervals.
 */
export async function forceSpawnTask(taskId) {
  const task = await getTaskById(taskId);
  if (!task) return { error: 'Task not found' };
  if (task.status !== 'pending') return { error: `Task is ${task.status}, not pending` };
  if (task.approvalRequired) return { error: 'Task requires approval before it can be spawned' };

  const state = await loadState();
  if (state.paused) return { error: 'CoS daemon is paused — resume before force-spawning tasks' };
  const runningAgents = Object.values(state.agents).filter(a => a.status === 'running').length;
  if (runningAgents >= state.config.maxConcurrentAgents) {
    return { error: `No available agent slots (${runningAgents}/${state.config.maxConcurrentAgents})` };
  }

  cosEvents.emit('task:ready', { ...task, taskType: task.taskType || 'internal' });
  return { success: true, taskId };
}

/**
 * Reset orphaned in_progress tasks back to pending
 * (tasks marked in_progress but no running agent)
 */
async function resetOrphanedTasks() {
  const state = await loadState();
  const { user: userTaskData, cos: cosTaskData } = await getAllTasks();

  const runningAgentTaskIds = Object.values(state.agents)
    .filter(a => a.status === 'running')
    .map(a => a.taskId);

  // Also track tasks with recently-completed agents to avoid race condition:
  // Between completeAgent() and updateTask(), the agent is "completed" but the
  // task is still "in_progress". Without this check, resetOrphanedTasks treats
  // such tasks as orphaned and increments orphanRetryCount spuriously.
  const recentlyCompletedTaskIds = new Set(
    Object.values(state.agents)
      .filter(a => a.status === 'completed' && a.completedAt &&
        (Date.now() - new Date(a.completedAt).getTime()) < RECENT_COMPLETION_GRACE_MS)
      .map(a => a.taskId)
  );

  // Track tasks whose agents completed successfully — if handleAgentCompletion's
  // updateTask call failed silently (e.g., file write race after server restart),
  // we should complete the task here rather than treating it as orphaned.
  const successfullyCompletedTaskIds = new Map();
  for (const agent of Object.values(state.agents)) {
    if (agent.status === 'completed' && agent.result?.success) {
      successfullyCompletedTaskIds.set(agent.taskId, agent.id);
    }
  }

  emitLog('debug', `Running agents: ${runningAgentTaskIds.length}, recently completed: ${recentlyCompletedTaskIds.size}`, { taskIds: runningAgentTaskIds });

  // Route orphaned tasks through handleOrphanedTask for consistent retry counting,
  // cooldown enforcement, and max-spawn limits (prevents runaway respawning)
  const { handleOrphanedTask } = await import('./subAgentSpawner.js');

  const processOrphanedTasks = async (tasks) => {
    for (const task of tasks) {
      if (runningAgentTaskIds.includes(task.id)) continue;
      // Skip tasks whose agent just completed — updateTask will set them to
      // completed shortly; treating them as orphaned causes spurious retries
      if (recentlyCompletedTaskIds.has(task.id)) {
        emitLog('debug', `Skipping task ${task.id} — agent recently completed, awaiting task status update`, { taskId: task.id });
        continue;
      }
      // If the agent completed successfully but task wasn't updated (silent updateTask failure),
      // complete the task now instead of treating it as orphaned
      const successAgentId = successfullyCompletedTaskIds.get(task.id);
      if (successAgentId) {
        emitLog('warn', `🔧 Task ${task.id} still in_progress but agent ${successAgentId} completed successfully — completing task now (missed update)`, { taskId: task.id, agentId: successAgentId });
        await updateTask(task.id, { status: 'completed' }, task.taskType || (isInternalTaskId(task.id) ? 'internal' : 'user'));
        continue;
      }
      emitLog('info', `Found orphaned in_progress task ${task.id}, routing through retry handler`, { taskId: task.id });
      await handleOrphanedTask(task.id, 'unknown-reset', getTaskById);
    }
  };

  if (userTaskData.exists) {
    await processOrphanedTasks(userTaskData.grouped.in_progress || []);
  }

  if (cosTaskData.exists) {
    await processOrphanedTasks(cosTaskData.grouped.in_progress || []);
  }
}

/**
 * Save a generated script
 */
export async function saveScript(name, content, metadata = {}) {
  await ensureDirectories();
  const scriptPath = join(SCRIPTS_DIR, `${name}.sh`);
  await writeFile(scriptPath, content, { mode: 0o755 });

  // Save metadata
  const metaPath = join(SCRIPTS_DIR, `${name}.json`);
  await writeFile(metaPath, JSON.stringify({
    name,
    createdAt: new Date().toISOString(),
    ...metadata
  }, null, 2));

  return { path: scriptPath, name };
}

/**
 * List generated scripts
 */
export async function listScripts() {
  await ensureDirectories();
  const files = await readdir(SCRIPTS_DIR);
  return files.filter(f => f.endsWith('.sh')).map(f => f.replace('.sh', ''));
}

/**
 * Get script content
 */
export async function getScript(name) {
  const scriptPath = join(SCRIPTS_DIR, `${name}.sh`);
  const metaPath = join(SCRIPTS_DIR, `${name}.json`);

  if (!existsSync(scriptPath)) return null;

  const content = await readFile(scriptPath, 'utf-8');
  const metadata = existsSync(metaPath)
    ? safeJSONParse(await readFile(metaPath, 'utf-8'), {}, { logError: true, context: `script metadata ${name}` })
    : {};

  return { name, content, metadata };
}

// Agent and report functions are now in cosAgents.js and cosReports.js
// Re-exported above for backward compat with `import * as cos from './cos.js'`

/**
 * Check if daemon is running
 */
export function isRunning() {
  return isDaemonRunning();
}

/**
 * Attempt to immediately spawn a newly added user task if there are available agent slots.
 * This bypasses the evaluation interval for user-submitted tasks so they start instantly.
 */
async function tryImmediateSpawn(task) {
  if (!isDaemonRunning()) return;

  const paused = await isPaused();
  if (paused) return;

  const state = await loadState();
  const runningAgents = Object.values(state.agents).filter(a => a.status === 'running').length;
  const availableSlots = state.config.maxConcurrentAgents - runningAgents;

  if (availableSlots <= 0) {
    emitLog('debug', `⏳ Queued task ${task.id} - no available slots (${runningAgents}/${state.config.maxConcurrentAgents})`);
    return;
  }

  // Check per-project limit
  const perProjectLimit = state.config.maxConcurrentAgentsPerProject || state.config.maxConcurrentAgents;
  const agentsByProject = countRunningAgentsByProject(state.agents);
  if (!isWithinProjectLimit(task, agentsByProject, perProjectLimit)) {
    const project = task.metadata?.app || '_self';
    emitLog('debug', `⏳ Queued task ${task.id} - per-project limit reached for ${project} (${agentsByProject[project] || 0}/${perProjectLimit})`);
    return;
  }

  emitLog('info', `⚡ Immediate spawn: ${task.id} (${task.priority || 'MEDIUM'})`, {
    taskId: task.id,
    availableSlots
  });
  cosEvents.emit('task:ready', { ...task, taskType: 'user' });
}

/**
 * Event-driven task dequeue — the primary way tasks get spawned.
 *
 * Triggered by: agent:completed, tasks:user:added, tasks:cos:added, status:resumed
 * Fills all available slots using the same priority order as evaluateTasks:
 *   0. On-demand requests
 *   1. User tasks
 *   2. Auto-approved system tasks
 *   3. Mission-driven proactive tasks (if proactiveMode)
 *   4. Idle review task (if idleReviewEnabled)
 * Returns silently when idle — no log noise.
 */
async function dequeueNextTask() {
  if (!isDaemonRunning()) return;

  const paused = await isPaused();
  if (paused) return;

  const state = await loadState();
  const runningAgents = Object.values(state.agents).filter(a => a.status === 'running').length;
  const availableSlots = state.config.maxConcurrentAgents - runningAgents;

  if (availableSlots <= 0) return;

  const perProjectLimit = state.config.maxConcurrentAgentsPerProject || state.config.maxConcurrentAgents;
  const agentsByProject = countRunningAgentsByProject(state.agents);
  const spawnProjectCounts = { ...agentsByProject };
  let spawned = 0;

  const canSpawn = (task) => {
    if (spawned >= availableSlots) return false;
    const project = task.metadata?.app || '_self';
    return (spawnProjectCounts[project] || 0) < perProjectLimit;
  };

  const trackSpawn = (task) => {
    const project = task.metadata?.app || '_self';
    spawnProjectCounts[project] = (spawnProjectCounts[project] || 0) + 1;
    spawned++;
  };

  // Priority 0: On-demand task requests
  const taskScheduleMod = await import('./taskSchedule.js');
  const taskSchedule = await taskScheduleMod.loadSchedule();
  const onDemandRequests = await taskScheduleMod.getOnDemandRequests();

  // Track apps already marked review-started this cycle so multiple on-demand
  // requests for the same app don't each rewrite its activity record.
  const reviewStartedApps = new Set();
  for (const request of onDemandRequests) {
    if (spawned >= availableSlots) break;

    if (!isImprovementEnabled(state)) {
      emitLog('warn', `On-demand request dropped — improvement is disabled (Config → Improve)`, { requestId: request.id, taskType: request.taskType });
      await taskScheduleMod.clearOnDemandRequest(request.id);
      continue;
    }

    // Skip if the task type was disabled after queuing
    if (!taskSchedule.tasks[request.taskType]?.enabled) {
      emitLog('info', `On-demand request skipped — task type '${request.taskType}' is disabled`, { requestId: request.id });
      await taskScheduleMod.clearOnDemandRequest(request.id);
      continue;
    }

    let task = null;
    const apps = await getActiveApps().catch(() => []);
    let targetApp = null;

    if (request.appId) {
      targetApp = apps.find(a => a.id === request.appId);
      if (!targetApp) {
        emitLog('warn', `On-demand request for unknown app: ${request.appId}`, { requestId: request.id });
        await taskScheduleMod.clearOnDemandRequest(request.id);
        continue;
      }
    }

    await taskScheduleMod.clearOnDemandRequest(request.id);

    if (targetApp) {
      emitLog('info', `Processing on-demand improvement: ${request.taskType} for ${targetApp.name}`, { requestId: request.id, appId: targetApp.id });
      if (!reviewStartedApps.has(targetApp.id)) {
        await markAppReviewStarted(targetApp.id, `on-demand-${Date.now()}`);
        reviewStartedApps.add(targetApp.id);
      }
      await taskScheduleMod.recordExecution(`task:${request.taskType}`, targetApp.id);
      task = await generateManagedAppImprovementTaskForType(request.taskType, targetApp, state, { skipPreconditions: true });
    } else {
      emitLog('info', `Processing on-demand improvement: ${request.taskType}`, { requestId: request.id });
      await taskScheduleMod.recordExecution(`task:${request.taskType}`);
      await withStateLock(async () => {
        const s = await loadState();
        s.stats.lastSelfImprovement = new Date().toISOString();
        s.stats.lastSelfImprovementType = request.taskType;
        await saveState(s);
      });
      task = await generateSelfImprovementTaskForType(request.taskType, state);
    }

    if (task && canSpawn(task)) {
      const persisted = await addTask(task, 'internal', { raw: true });
      if (!persisted?.duplicate) {
        cosEvents.emit('task:ready', task);
        trackSpawn(task);
      }
    }
  }

  // Priority 1: User tasks
  const userTaskData = await getUserTasks();
  const pendingUserTasks = userTaskData.grouped?.pending || [];

  for (const task of pendingUserTasks) {
    if (spawned >= availableSlots) break;
    if (await blockIfExceedsMaxSpawns(task, 'user')) continue;
    const userTask = { ...task, taskType: 'user' };
    if (!canSpawn(userTask)) continue;
    cosEvents.emit('task:ready', userTask);
    trackSpawn(userTask);
  }

  // Priority 2: Auto-approved system tasks
  const cosTaskData = await getCosTasks();
  const autoApproved = cosTaskData.autoApproved || [];

  for (const task of autoApproved) {
    if (spawned >= availableSlots) break;
    if (await blockIfExceedsMaxSpawns(task, 'internal')) continue;
    // Skip improvement tasks whose type was disabled after queuing
    const analysisType = task.metadata?.analysisType || task.metadata?.selfImprovementType;
    if (analysisType && !taskSchedule.tasks[analysisType]?.enabled) {
      emitLog('info', `System task skipped — task type '${analysisType}' is disabled`, { taskId: task.id });
      continue;
    }
    const appId = task.metadata?.app;
    if (appId) {
      const onCooldown = await isAppOnCooldown(appId, state.config.appReviewCooldownMs);
      if (onCooldown) continue;
    }
    const sysTask = { ...task, taskType: 'internal' };
    if (!canSpawn(sysTask)) continue;
    cosEvents.emit('task:ready', sysTask);
    trackSpawn(sysTask);
  }

  const hasPendingUserTasks = pendingUserTasks.length > 0;

  // Priority 3: Mission-driven proactive tasks
  if (spawned < availableSlots && !hasPendingUserTasks && state.config.proactiveMode) {
    const missionTasks = await generateMissionTasks({ maxTasks: availableSlots - spawned }).catch(err => {
      emitLog('debug', `Mission task generation failed: ${err.message}`);
      return [];
    });

    for (const missionTask of missionTasks) {
      if (spawned >= availableSlots) break;
      const cosTask = {
        id: missionTask.id,
        description: missionTask.description,
        priority: missionTask.priority?.toUpperCase() || 'MEDIUM',
        status: 'pending',
        metadata: missionTask.metadata,
        taskType: 'internal',
        approvalRequired: !missionTask.autoApprove
      };
      if (!canSpawn(cosTask)) continue;
      cosEvents.emit('task:ready', cosTask);
      trackSpawn(cosTask);
      emitLog('info', `Generated mission task: ${missionTask.id}`, {
        missionId: missionTask.metadata?.missionId
      });
    }
  }

  // Priority 4: Idle review task (only when completely idle)
  if (spawned === 0 && state.config.idleReviewEnabled && !hasPendingUserTasks) {
    const freshCosTasks = await getCosTasks();
    const pendingSystemTasks = freshCosTasks.autoApproved?.length || 0;
    if (pendingSystemTasks === 0) {
      const idleTask = await generateIdleReviewTask(state);
      if (idleTask && canSpawn(idleTask)) {
        cosEvents.emit('task:ready', idleTask);
        trackSpawn(idleTask);
      }
    }
  }

  if (spawned > 0) {
    emitLog('info', `⚡ Dequeued ${spawned} task(s)`, { spawned, availableSlots });
  }
}

/**
 * Compute the next fire time for an autonomous job.
 * Supports two scheduling modes:
 * 1. Cron mode: job.cronExpression defines the full schedule
 * 2. Interval mode: job.intervalMs + optional job.scheduledTime (HH:MM in user timezone)
 *
 * @param {Object} job - The job object
 * @param {string} timezone - IANA timezone string for interpreting scheduledTime/cron
 * @returns {number} Timestamp (ms) of next fire time
 */
function computeNextJobFireTime(job, timezone) {
  // Convert scheduledTime (HH:MM) + interval to a cron expression so parseCronToNextRun
  // handles all "next occurrence after lastRun" logic without drift issues.
  // Only synthesize a daily/weekday cron for strictly daily or weekdaysOnly jobs.
  // Weekly/biweekly/sub-daily interval jobs fall through to the interval path below,
  // which correctly computes lastRun + intervalMs without scheduling them every day.
  // e.g. { interval: 'daily', scheduledTime: '04:30' } → '30 4 * * *'
  let cronExpr = job.cronExpression;
  const isDailyCronCandidate = job.interval === 'daily' || job.weekdaysOnly;
  if (!cronExpr && job.scheduledTime && isDailyCronCandidate) {
    const match = String(job.scheduledTime).match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (match) {
      const dayField = job.weekdaysOnly ? '1-5' : '*';
      cronExpr = `${Number(match[2])} ${Number(match[1])} * * ${dayField}`;
    }
  }

  if (cronExpr) {
    const from = job.lastRun ? new Date(job.lastRun) : new Date();
    const next = parseCronToNextRun(cronExpr, from, timezone);
    if (!next) {
      throw new Error(
        `Invalid cron expression for autonomous job` +
        (job.id ? ` "${job.id}"` : '') +
        `: ${cronExpr}`
      );
    }
    return next.getTime();
  }

  // Interval fallback: lastRun + intervalMs, then align to scheduledTime if set
  const lastRun = job.lastRun ? new Date(job.lastRun).getTime() : 0;
  let nextDue = lastRun + job.intervalMs;

  // Restore scheduledTime alignment for interval-mode jobs (e.g. weekly at 00:00).
  // nextLocalTime advances nextDue to the next occurrence of HH:MM in the user's timezone,
  // preventing drift when a run occurs slightly late.
  if (job.scheduledTime) {
    const match = String(job.scheduledTime).match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (match) {
      const candidate = nextLocalTime(nextDue, Number(match[1]), Number(match[2]), timezone);
      if (candidate > nextDue) nextDue = candidate;
    }
  }

  if (job.weekdaysOnly) {
    const { dayOfWeek } = getLocalParts(new Date(nextDue), timezone);
    if (dayOfWeek === 0) nextDue += 24 * 60 * 60 * 1000; // Sunday → Monday
    if (dayOfWeek === 6) nextDue += 2 * 24 * 60 * 60 * 1000; // Saturday → Monday
  }

  return nextDue;
}

/**
 * Register a single autonomous job as a one-shot scheduled event.
 * After execution, re-registers for the next fire time.
 */
async function registerSingleJobSchedule(jobId) {
  const { getJob } = await import('./autonomousJobs.js');
  const job = await getJob(jobId);
  if (!job || !job.enabled) {
    cancelEvent(`job:${jobId}`);
    return;
  }

  const timezone = await getUserTimezone();
  const nextFire = computeNextJobFireTime(job, timezone);
  const delayMs = Math.max(nextFire - Date.now(), 1000);

  scheduleEvent({
    id: `job:${jobId}`,
    type: 'once',
    delayMs,
    handler: () => executeScheduledJob(jobId),
    metadata: { description: `Autonomous job: ${job.name}`, jobId }
  });
}

// Track jobs currently being spawned (between task:ready emit and agent registration)
// to prevent duplicate spawns when timers overlap or fire during spawn
const spawningJobIds = new Set();
const spawningJobTimeouts = new Map();

function addSpawningJob(jobId) {
  spawningJobIds.add(jobId);
  // Auto-clear after 5 minutes if spawn never completes, and re-register the timer
  if (spawningJobTimeouts.has(jobId)) clearTimeout(spawningJobTimeouts.get(jobId));
  spawningJobTimeouts.set(jobId, setTimeout(() => {
    spawningJobIds.delete(jobId);
    spawningJobTimeouts.delete(jobId);
    emitLog('warn', `Job ${jobId} spawning timed out after 5m, re-registering schedule`, { jobId });
    registerSingleJobSchedule(jobId).catch(err =>
      console.error(`❌ Failed to re-register job schedule after spawn timeout for ${jobId}: ${err.message}`)
    );
  }, 5 * 60 * 1000));
}

function clearSpawningJob(jobId) {
  spawningJobIds.delete(jobId);
  const timeout = spawningJobTimeouts.get(jobId);
  if (timeout) {
    clearTimeout(timeout);
    spawningJobTimeouts.delete(jobId);
  }
}

/**
 * Execute a scheduled autonomous job and re-register its timer.
 */
async function executeScheduledJob(jobId) {
  if (!isDaemonRunning()) return;

  const paused = await isPaused();
  if (paused) {
    // Re-register for later
    await registerSingleJobSchedule(jobId);
    return;
  }

  const { getJob } = await import('./autonomousJobs.js');
  const job = await getJob(jobId);
  if (!job || !job.enabled) return;

  const state = await loadState();
  if (!state.config.autonomousJobsEnabled) {
    // Re-register so it fires when re-enabled
    await registerSingleJobSchedule(jobId);
    return;
  }

  // Script jobs and shell jobs execute directly without spawning an AI agent
  if (isScriptJob(job)) {
    const scriptOk = await executeScriptJob(job).then(() => true, err => {
      emitLog('error', `Script job failed: ${job.name} - ${err.message}`, { jobId: job.id });
      return false;
    });
    if (scriptOk) emitLog('info', `Script job executed: ${job.name}`, { jobId: job.id });
  } else if (isShellJob(job)) {
    const shellOk = await executeShellJob(job).then(() => true, err => {
      emitLog('error', `Shell job failed: ${job.name} - ${err.message}`, { jobId: job.id });
      return false;
    });
    if (shellOk) emitLog('info', `Shell job executed: ${job.name}`, { jobId: job.id });
  } else {
    // Check if this job is already being spawned or has a running agent.
    // Don't re-register the timer here — the job:spawned handler will do it
    // after recordJobExecution updates lastRun. Re-registering with stale
    // lastRun causes a 1-second re-fire loop.
    if (spawningJobIds.has(jobId)) {
      emitLog('debug', `Job ${job.name} skipped - already spawning`, { jobId });
      return;
    }
    const agentAlreadyRunning = Object.values(state.agents).some(
      a => a.status === 'running' && a.metadata?.jobId === jobId
    );
    if (agentAlreadyRunning) {
      emitLog('debug', `Job ${job.name} skipped - agent already running`, { jobId });
      return;
    }

    // Check capacity before spawning an agent
    const runningAgents = Object.values(state.agents).filter(a => a.status === 'running').length;
    if (runningAgents >= state.config.maxConcurrentAgents) {
      emitLog('debug', `Job ${job.name} deferred - no agent slots`, { jobId });
      // Retry in 60s
      scheduleEvent({
        id: `job:${jobId}`,
        type: 'once',
        delayMs: 60000,
        handler: () => executeScheduledJob(jobId),
        metadata: { description: `Autonomous job: ${job.name} (retry)`, jobId }
      });
      return;
    }

    // Run gate check — skip LLM if precondition not met
    // Gate errors fail-open (run the job) to avoid silently dropping scheduled work
    let gateResult;
    try {
      gateResult = await checkJobGate(jobId);
    } catch (gateErr) {
      emitLog('warn', `Job ${job.name} gate error, failing open: ${gateErr?.message || gateErr}`, { jobId });
      gateResult = { shouldRun: true, reason: 'Gate error — failing open' };
    }
    if (!gateResult.shouldRun) {
      emitLog('debug', `Job ${job.name} gate skipped: ${gateResult.reason}`, { jobId, gate: gateResult });
      // Update lastRun so the job reschedules at its normal interval, but don't increment runCount
      await recordJobGateSkip(jobId).catch(err =>
        console.error(`❌ Failed to record gate-skip for ${jobId}: ${err.message}`)
      );
      await registerSingleJobSchedule(jobId);
      return;
    }
    if (hasGate(jobId)) {
      emitLog('info', `Job ${job.name} gate passed: ${gateResult.reason}`, { jobId, gate: gateResult });
    }

    // Mark as spawning before emitting task:ready to prevent races
    addSpawningJob(jobId);
    try {
      const task = await generateTaskFromJob(job);
      emitLog('info', `Autonomous job firing: ${job.name}`, { jobId, category: job.category });
      cosEvents.emit('task:ready', task);
      // Don't re-register timer here — lastRun hasn't been updated yet, so
      // computeNextJobFireTime would return a past-due time and the timer would
      // fire in 1s, creating a rapid re-fire loop. The job:spawned handler
      // re-registers after recordJobExecution updates lastRun.
      return;
    } catch (err) {
      clearSpawningJob(jobId);
      emitLog('error', `Failed to fire autonomous job: ${job.name} - ${err?.message || err}`, { jobId, category: job.category });
    }
  }

  // Re-register for next fire time (script/shell jobs, early returns, and error paths)
  await registerSingleJobSchedule(jobId);
}

/**
 * Register all enabled autonomous jobs as individual one-shot scheduled events.
 */
async function registerJobSchedules() {
  const { getEnabledJobs } = await import('./autonomousJobs.js');
  const jobs = await getEnabledJobs();

  for (const job of jobs) {
    await registerSingleJobSchedule(job.id);
  }

  if (jobs.length > 0) {
    emitLog('info', `📅 Registered ${jobs.length} autonomous job schedule(s)`);
  }
}

/**
 * Cancel all autonomous job scheduled events.
 */
async function unregisterJobSchedules() {
  const { getAllJobs } = await import('./autonomousJobs.js');
  const jobs = await getAllJobs();

  for (const job of jobs) {
    cancelEvent(`job:${job.id}`);
  }
}

/**
 * Schedule a one-shot timer for the next due improvement task.
 * When it fires, queues eligible improvement tasks and re-schedules.
 */
async function scheduleNextImprovementCheck() {
  if (!isDaemonRunning()) return;

  const taskSchedule = await import('./taskSchedule.js');
  // Pull a wider list so a perpetually-"ready" weekly task can't mask an upcoming
  // cron boundary. We sort by status (ready first), so 1-element peeks always miss
  // the cron slot when anything else is ready.
  const upcoming = await taskSchedule.getUpcomingTasks(50);

  // Default: check again in 1 hour if nothing scheduled
  // Cap at 1 hour so per-app cron tasks (e.g. feature-ideas at 1am) are always checked
  // on time — getUpcomingTasks only sees global tasks, not per-app schedules
  const MAX_CHECK_INTERVAL = 60 * 60 * 1000;
  let delayMs = MAX_CHECK_INTERVAL;
  let description = 'Periodic improvement check (1h)';

  // Pick the soonest *scheduled* task (status='scheduled' with positive eligibleIn).
  // Ready tasks don't gate the delay — they'll be queued on whatever the next check
  // ends up being. Cron tasks DO gate the delay, because their firing window is a
  // single minute; missing it pushes the next attempt out by a full period.
  const nextScheduled = upcoming
    .filter(t => t.status === 'scheduled' && t.eligibleIn > 0)
    .sort((a, b) => a.eligibleIn - b.eligibleIn)[0];

  if (nextScheduled && nextScheduled.eligibleIn < MAX_CHECK_INTERVAL) {
    delayMs = nextScheduled.eligibleIn;
    description = `Next improvement: ${nextScheduled.taskType} in ${formatDuration(delayMs)}`;
  } else if (nextScheduled) {
    description = `Next improvement: ${nextScheduled.taskType} in ${nextScheduled.eligibleInFormatted} (capped at 1h)`;
  }

  scheduleEvent({
    id: 'cos-improvement-check',
    type: 'once',
    delayMs: Math.max(delayMs, 1000),
    handler: async () => {
      if (!isDaemonRunning()) return;
      const paused = await isPaused();
      if (paused) {
        await scheduleNextImprovementCheck();
        return;
      }

      const state = await loadState();
      if (state.config.idleReviewEnabled) {
        const cosTaskData = await getCosTasks();
        await queueEligibleImprovementTasks(state, cosTaskData);
        setImmediate(() => dequeueNextTask());
      }

      await scheduleNextImprovementCheck();
    },
    metadata: { description }
  });
}

/**
 * Wire event listeners, load state, and auto-start the daemon when configured.
 * Called once from `server/index.js` during boot.
 */
export async function init() {
  await ensureDirectories();

  // When an agent completes, immediately try to dequeue the next pending task
  cosEvents.on('agent:completed', (agent) => {
    setImmediate(() => dequeueNextTask());

    // Create notification when a daily briefing completes
    if (agent?.metadata?.jobId === 'job-daily-briefing' && agent?.result?.success) {
      getUserTimezone()
        .then(tz => {
          const today = todayInTimezone(tz);
          return addNotification({
            type: NOTIFICATION_TYPES.BRIEFING_READY,
            title: 'Daily Briefing Ready',
            description: `Your daily briefing for ${today} is ready for review.`,
            priority: 'low',
            link: '/cos/briefing',
            metadata: { date: today, agentId: agent.id }
          });
        })
        .catch(err => console.error(`❌ Failed to create briefing notification: ${err.message}`));
    }
  });

  // Record autonomous job execution only after the agent actually spawns.
  // Update lastRun BEFORE clearing the spawning guard to prevent a race where
  // a pending timer fires between clearSpawningJob and recordJobExecution,
  // sees no guard and stale lastRun, and spawns a duplicate agent.
  cosEvents.on('job:spawned', async ({ jobId }) => {
    await recordJobExecution(jobId).catch(err =>
      console.error(`❌ Failed to record job execution for ${jobId}: ${err.message}`)
    );
    clearSpawningJob(jobId);
    // Re-register with updated lastRun so the next timer has the correct delay
    await registerSingleJobSchedule(jobId).catch(err =>
      console.error(`❌ Failed to re-register job schedule for ${jobId}: ${err.message}`)
    );
  });

  cosEvents.on('job:spawn-failed', async ({ jobId }) => {
    emitLog('warn', `Job spawn failed, re-registering schedule: ${jobId}`, { jobId });
    clearSpawningJob(jobId);
    await registerSingleJobSchedule(jobId).catch(err =>
      console.error(`❌ Failed to re-register job schedule after spawn failure for ${jobId}: ${err.message}`)
    );
  });

  // Event-driven triggers: task/file changes → dequeueNextTask.
  // The task store (cosTaskStore.js) persists tasks and emits this event; the
  // spawn-side reaction lives here so the store stays free of scheduler logic.
  // - 'added': fill open slots via dequeueNextTask, and (for user tasks) also
  //   fire tryImmediateSpawn so the just-added task starts instantly, bypassing
  //   the evaluation interval that's meant for system task generation.
  // - 'approved': a newly approved internal task can now spawn — re-run dequeue.
  cosEvents.on('tasks:changed', (data) => {
    if (!isDaemonRunning() || !data?.action) return;
    if (data.action === 'added') {
      // Order matters: dequeueNextTask is scheduled before the user-task
      // tryImmediateSpawn, matching the pre-extraction sequence (addTask emitted
      // tasks:changed — registering dequeue via this listener — before it called
      // setImmediate(tryImmediateSpawn)). dequeue fills slots in priority order
      // first; tryImmediateSpawn then handles the just-added task.
      setImmediate(() => dequeueNextTask());
      if (data.type === 'user' && data.task) setImmediate(() => tryImmediateSpawn(data.task));
    } else if (data.action === 'approved') {
      setImmediate(() => dequeueNextTask());
    }
  });

  cosEvents.on('tasks:user:added', () => {
    if (isDaemonRunning()) setImmediate(() => dequeueNextTask());
  });

  cosEvents.on('tasks:cos:added', () => {
    if (isDaemonRunning()) setImmediate(() => dequeueNextTask());
  });

  cosEvents.on('task:on-demand-requested', () => {
    if (isDaemonRunning()) setImmediate(() => dequeueNextTask());
  });

  // Autonomous job lifecycle → re-register/cancel individual job timers
  cosEvents.on('jobs:toggled', async ({ id }) => {
    if (isDaemonRunning()) await registerSingleJobSchedule(id).catch(err =>
      console.error(`❌ Failed to register job schedule on toggle for ${id}: ${err?.message ?? String(err)}`)
    );
  });

  cosEvents.on('jobs:updated', async ({ id }) => {
    if (isDaemonRunning()) await registerSingleJobSchedule(id).catch(err =>
      console.error(`❌ Failed to register job schedule on update for ${id}: ${err?.message ?? String(err)}`)
    );
  });

  cosEvents.on('jobs:created', async ({ id }) => {
    if (isDaemonRunning()) await registerSingleJobSchedule(id).catch(err =>
      console.error(`❌ Failed to register job schedule on create for ${id}: ${err?.message ?? String(err)}`)
    );
  });

  cosEvents.on('jobs:deleted', async ({ id }) => {
    cancelEvent(`job:${id}`);
  });

  // Schedule changes → re-compute next improvement check
  cosEvents.on('schedule:changed', async () => {
    if (isDaemonRunning()) await scheduleNextImprovementCheck().catch(err =>
      console.error(`❌ Failed to schedule next improvement check: ${err?.message ?? String(err)}`)
    );
  });

  const state = await loadState();

  // Auto-start if alwaysOn mode is enabled (or legacy autoStart)
  if (state.config.alwaysOn || state.config.autoStart) {
    console.log('🚀 CoS auto-starting (alwaysOn mode)');
    await start();
  }
}
