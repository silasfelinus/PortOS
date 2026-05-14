/**
 * Tests for handleOrphanedTask — guards that prevent duplicate investigation
 * tasks when the same underlying task is orphaned by multiple agents in the
 * same cleanup sweep.
 *
 * The bug: cleanupOrphanedAgents iterates over all stale "running" agents and
 * calls handleOrphanedTask once per agent. If two agents shared a taskId, the
 * first call would block the task with 'max-retries' and spawn an investigation
 * task; the second call would see the (now-blocked) task, increment
 * orphanRetryCount again, and spawn ANOTHER investigation task. The addTask
 * dedup at cos.js:2194 doesn't catch it because the description body embeds
 * per-agent retryCount/agentId, so the strings differ.
 *
 * The guard added at agentManagement.js:381 short-circuits handleOrphanedTask
 * when the task is already blocked with 'max-retries' or 'orphan-cooldown'.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./cos.js', () => ({
  updateTask: vi.fn().mockResolvedValue(true),
  addTask: vi.fn().mockResolvedValue({ id: 'sys-mocked' }),
  getTaskById: vi.fn(),
  getAllTasks: vi.fn()
}));

vi.mock('./cosEvents.js', () => ({
  emitLog: vi.fn()
}));

vi.mock('./agentRunTracking.js', () => ({
  checkForTaskCommit: vi.fn().mockReturnValue(false)
}));

// Stub other transitive imports we don't exercise in handleOrphanedTask.
vi.mock('./cosAgents.js', () => ({ completeAgent: vi.fn() }));
vi.mock('./cosRunnerClient.js', () => ({
  terminateAgentViaRunner: vi.fn(),
  killAgentViaRunner: vi.fn(),
  getAgentStatsFromRunner: vi.fn(),
  getActiveAgentsFromRunner: vi.fn().mockResolvedValue([])
}));
vi.mock('./agents.js', () => ({ unregisterSpawnedAgent: vi.fn() }));
vi.mock('./agentLifecycle.js', () => ({
  cleanupAgentWorktree: vi.fn(),
  syncRunnerAgents: vi.fn().mockResolvedValue(0)
}));
vi.mock('./worktreeManager.js', () => ({ cleanupOrphanedWorktrees: vi.fn() }));

import { handleOrphanedTask } from './agentManagement.js';
import { updateTask, addTask } from './cos.js';

describe('handleOrphanedTask — duplicate-investigation guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips tasks already blocked with blockedCategory=max-retries (no new investigation task)', async () => {
    const blockedTask = {
      id: 'task-foo',
      status: 'blocked',
      taskType: 'user',
      description: 'Original work',
      metadata: {
        blockedCategory: 'max-retries',
        blockedReason: 'orphan retries exceeded (3/3)',
        orphanRetryCount: 3,
        totalSpawnCount: 3
      }
    };
    const getTaskById = vi.fn().mockResolvedValue(blockedTask);

    await handleOrphanedTask('task-foo', 'agent-second', getTaskById);

    expect(updateTask).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('skips tasks already blocked with blockedCategory=orphan-cooldown', async () => {
    const cooldownTask = {
      id: 'task-foo',
      status: 'blocked',
      taskType: 'user',
      description: 'Original work',
      metadata: {
        blockedCategory: 'orphan-cooldown',
        cooldownUntil: new Date(Date.now() + 60000).toISOString(),
        orphanRetryCount: 1
      }
    };
    const getTaskById = vi.fn().mockResolvedValue(cooldownTask);

    await handleOrphanedTask('task-foo', 'agent-second', getTaskById);

    expect(updateTask).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('still skips user-terminated tasks (preserves prior behavior)', async () => {
    const terminatedTask = {
      id: 'task-foo',
      status: 'blocked',
      taskType: 'user',
      description: 'Original work',
      metadata: { blockedCategory: 'user-terminated' }
    };
    const getTaskById = vi.fn().mockResolvedValue(terminatedTask);

    await handleOrphanedTask('task-foo', 'agent-x', getTaskById);

    expect(updateTask).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('still processes a fresh in_progress task (resets to pending for retry)', async () => {
    const inProgressTask = {
      id: 'task-foo',
      status: 'in_progress',
      taskType: 'user',
      description: 'Original work',
      metadata: { orphanRetryCount: 0, totalSpawnCount: 1 }
    };
    const getTaskById = vi.fn().mockResolvedValue(inProgressTask);

    await handleOrphanedTask('task-foo', 'agent-orphaned', getTaskById);

    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith(
      'task-foo',
      expect.objectContaining({
        status: 'pending',
        metadata: expect.objectContaining({
          orphanRetryCount: 1,
          lastOrphanedAgentId: 'agent-orphaned'
        })
      }),
      'user'
    );
    expect(addTask).not.toHaveBeenCalled();
  });
});
