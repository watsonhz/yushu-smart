/**
 * WP1.2 调度引擎核心
 * 多级队列调度器：支持 FIFO / 公平(DRF) / 优先级 三种策略
 */
const m = require('./models-wp1');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const db = require('./db');

const schedulerBus = new EventEmitter();
schedulerBus.setMaxListeners(50);

const SCHEDULE_INTERVAL_MS = 5000;
const PREEMPT_MIN_GUARANTEE_MS = 5 * 60 * 1000; // 5分钟保护期
const PREEMPT_MAX_DAILY = 3;

let schedulerTimer = null;
let running = false;

// =============================================
// 调度策略实现
// =============================================

function sortFIFO(tasks) {
  return tasks.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function sortPriority(tasks) {
  return tasks.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority; // 高优先在前
    return new Date(a.created_at) - new Date(b.created_at); // 同优先按时间
  });
}

function sortFair(tasks) {
  // 简单 DRF：按"团队当前运行任务数 / 团队总任务数"比例排序，最少优先
  const teamCounts = {};
  const running = m.getTasksSchedule({ status: 'running', limit: 1000 });
  const totalQueued = tasks.length + running.length;
  for (const t of [...running, ...tasks]) {
    teamCounts[t.team_id] = (teamCounts[t.team_id] || 0) + 1;
  }
  return tasks.sort((a, b) => {
    const aRatio = (teamCounts[a.team_id] || 0) / Math.max(totalQueued, 1);
    const bRatio = (teamCounts[b.team_id] || 0) / Math.max(totalQueued, 1);
    if (aRatio !== bRatio) return aRatio - bRatio;
    return new Date(a.created_at) - new Date(b.created_at);
  });
}

// =============================================
// 资源匹配
// =============================================

function findAvailableResources(poolId, gpuCount) {
  const availableGPUs = m.getAvailableGPUs(poolId);
  if (availableGPUs.length < gpuCount) return null;

  // 按节点分组，优先选同一个节点的 GPU（NVLink 拓扑亲和性）
  const byNode = {};
  for (const gpu of availableGPUs) {
    if (!byNode[gpu.node_id]) byNode[gpu.node_id] = [];
    byNode[gpu.node_id].push(gpu);
  }

  // 找到有足够 GPU 的节点，按剩余 GPU 数降序（最小碎片）
  const candidates = Object.entries(byNode)
    .filter(([, gpus]) => gpus.length >= gpuCount)
    .sort(([, a], [, b]) => b.length - a.length);

  if (candidates.length > 0) {
    const [nodeId, gpus] = candidates[0];
    return { node_id: nodeId, gpus: gpus.slice(0, gpuCount) };
  }

  // 跨节点分配（fallback）
  const crossNodeGPUs = [];
  const byNodeSorted = Object.entries(byNode).sort(([, a], [, b]) => b.length - a.length);
  for (const [nodeId, gpus] of byNodeSorted) {
    for (const gpu of gpus) {
      crossNodeGPUs.push(gpu);
      if (crossNodeGPUs.length >= gpuCount) break;
    }
    if (crossNodeGPUs.length >= gpuCount) break;
  }

  if (crossNodeGPUs.length >= gpuCount) {
    return { node_id: 'cross-node', gpus: crossNodeGPUs.slice(0, gpuCount) };
  }

  return null;
}

// =============================================
// 抢占检查
// =============================================

function checkPreemption(highPriorityTask) {
  const running = m.getTasksSchedule({ status: 'running', limit: 100 });
  const lowPriority = running
    .filter(t => t.priority < highPriorityTask.priority)
    .sort((a, b) => a.priority - b.priority); // 最低优先级的先抢占

  if (lowPriority.length === 0) return null;

  // 检查保护期
  const victim = lowPriority[0];
  const startedAt = new Date(victim.started_at || victim.created_at).getTime();
  if (Date.now() - startedAt < PREEMPT_MIN_GUARANTEE_MS) return null;

  // 检查每日抢占上限
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const preemptEvents = m.getTaskEvents(victim.id).filter(
    e => e.event_type === 'preempted' && new Date(e.created_at) >= todayStart
  );
  if (preemptEvents.length >= PREEMPT_MAX_DAILY) return null;

  return victim;
}

// =============================================
// Volcano Job 封装（模拟）
// =============================================

function createVolcanoJob(task, spec, gpuDevices) {
  // 在 K8s 环境中，这里创建 Volcano Job CRD
  // 当前用 SQLite 模拟，记录调度结果
  const jobName = `volcano-job-${task.id}`;

  m.updateTaskStatus(task.id, 'running');
  m.createTaskEvent(task.id, 'started', {
    job_name: jobName,
    gpu_devices: gpuDevices.map(g => ({ node_id: g.node_id, index: g.device_index })),
    gpu_count: spec?.gpu_count || 1,
    scheduled_at: new Date().toISOString(),
  });

  schedulerBus.emit('task:scheduled', { taskId: task.id, jobName });

  return { job_name: jobName, status: 'scheduled' };
}

// =============================================
// 调度主循环
// =============================================

function scheduleTick() {
  if (running) return;
  running = true;

  try {
    const queued = m.getTasksSchedule({ status: 'queued', limit: 100 });
    if (queued.length === 0) { running = false; return; }

    // 按团队分组处理
    const byPool = {};
    for (const task of queued) {
      const poolId = task.pool_id || 'default';
      if (!byPool[poolId]) byPool[poolId] = [];
      byPool[poolId].push(task);
    }

    for (const [poolId, tasks] of Object.entries(byPool)) {
      const pool = poolId === 'default' ? null : m.getResourcePool(poolId);
      const policy = pool ? pool.scheduler_policy : 'fifo';

      // 按策略排序
      let sorted;
      switch (policy) {
        case 'priority': sorted = sortPriority(tasks); break;
        case 'fair': sorted = sortFair(tasks); break;
        case 'fifo':
        default: sorted = sortFIFO(tasks); break;
      }

      for (const task of sorted) {
        const spec = m.getTaskSpec(task.id);
        const gpuCount = spec?.gpu_count || 1;

        // 寻找可用资源
        const resources = findAvailableResources(poolId, gpuCount);
        if (resources) {
          createVolcanoJob(task, spec, resources.gpus);
          continue;
        }

        // 资源不足，尝试抢占
        if (pool?.scheduler_policy === 'priority' || pool?.scheduler_policy === 'fair') {
          const victim = checkPreemption(task);
          if (victim) {
            preemptTask(task, victim);
            // 重新尝试调度当前任务
            const retryResources = findAvailableResources(poolId, gpuCount);
            if (retryResources) {
              createVolcanoJob(task, spec, retryResources.gpus);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[Scheduler] Error:', err.message);
  } finally {
    running = false;
  }
}

function preemptTask(newTask, victim) {
  // 记录抢占事件
  m.createTaskEvent(victim.id, 'preempted', {
    preemptor_task_id: newTask.id,
    preempt_time: new Date().toISOString(),
  });
  m.createTaskEvent(newTask.id, 'preempted', {
    victim_task_id: victim.id,
  });

  // 受害者重新入队，补偿优先级 +20
  const compensationPriority = Math.min((victim.priority || 50) + 20, 100);
  m.updateTaskStatus(victim.id, 'queued');
  m.createTaskEvent(victim.id, 'queued', {
    reason: 'preempted',
    compensation_priority: compensationPriority,
  });

  // 直接 DB 更新优先级
  const targetDb = db.getDb();
  targetDb.prepare('UPDATE tasks_schedule SET priority = ?, preempt_count = preempt_count + 1 WHERE id = ?')
    .run(compensationPriority, victim.id);

  schedulerBus.emit('task:preempted', { victimId: victim.id, newTaskId: newTask.id });
}

// =============================================
// 调度器生命周期
// =============================================

function startScheduler() {
  if (schedulerTimer) return;
  console.log('[Scheduler] Started (interval: ' + SCHEDULE_INTERVAL_MS + 'ms)');
  scheduleTick(); // 立即执行一次
  schedulerTimer = setInterval(scheduleTick, SCHEDULE_INTERVAL_MS);
}

function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log('[Scheduler] Stopped');
  }
}

function isSchedulerRunning() {
  return schedulerTimer !== null;
}

function getSchedulerStats() {
  const queued = m.getTasksSchedule({ status: 'queued' });
  const running = m.getTasksSchedule({ status: 'running' });
  return {
    running: isSchedulerRunning(),
    queued_count: queued.length,
    running_count: running.length,
    policy: 'multi',
    interval_ms: SCHEDULE_INTERVAL_MS,
  };
}

module.exports = {
  schedulerBus,
  startScheduler,
  stopScheduler,
  isSchedulerRunning,
  getSchedulerStats,
  scheduleTick,
};
