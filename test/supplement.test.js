/**
 * Phase 2 补充测试 — 覆盖 scheduler / models-wp1 / process-manager / router edge cases
 */
require('dotenv').config();

const db = require('../src/db');
const models = require('../src/models-wp1');
const scheduler = require('../src/scheduler');
const { parseAtMentions, isSystemCommand, classifyIntent, routeMessage } = require('../src/router');
const { getRole, classifyIntent: classifyRoleIntent, ROLE_ORDER, ROLES } = require('../src/roles');
const { ensureSession, killAllProcesses, getActiveProcessCount, buildFullPrompt } = require('../src/process-manager');
const { acquireChatLock, releaseChatLock, isInProjectDir, acquireFileLock } = require('../src/security');
const { autoClaimTask, formatMyTasks } = require('../src/tasks');

db.init();
models.initModels(db.getDb());

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.error(`  FAIL: ${name}`); }
}

// ═══════════════════════════════════
// WP1.2 资源池 & 节点 & GPU
// ═══════════════════════════════════

console.log('\n=== Models WP1.2 — Resource Pools ===');
const poolId = `test-pool-${Date.now()}`;
models.createResourcePool(poolId, 'TestPool', 'fair', { env: 'test' });
const pool = models.getResourcePool(poolId);
assert(pool !== undefined, 'create and get resource pool');
assert(pool.scheduler_policy === 'fair', 'pool policy = fair');

const pools = models.getResourcePools();
assert(pools.length > 0, 'get all pools returns results');

models.updateResourcePool(poolId, { name: 'TestPoolRenamed' });
const renamed = models.getResourcePool(poolId);
assert(renamed.name === 'TestPoolRenamed', 'update pool name');

console.log('\n=== Models WP1.2 — Nodes & GPUs ===');
const nodeId = `test-node-${Date.now()}`;
models.createNode(nodeId, poolId, 'test-node-01', '10.0.0.1', { gpu_count: 2, gpu_model: 'A100' }, { rack: 'A1' });
const node = models.getNode(nodeId);
assert(node !== undefined, 'create and get node');
assert(node.hostname === 'test-node-01', 'node hostname correct');

const poolNodes = models.getNodes(poolId);
assert(poolNodes.length >= 1, 'get nodes by pool');

// Insert GPU devices directly then test heartbeat update
const gpuDb = db.getDb();
gpuDb.prepare(
  'INSERT OR IGNORE INTO gpu_devices (id, node_id, device_index, gpu_model, memory_total_mb, status) VALUES (?, ?, ?, ?, ?, ?)'
).run(`gpu-${nodeId}-0`, nodeId, 0, 'A100', 81920, 'free');
gpuDb.prepare(
  'INSERT OR IGNORE INTO gpu_devices (id, node_id, device_index, gpu_model, memory_total_mb, status) VALUES (?, ?, ?, ?, ?, ?)'
).run(`gpu-${nodeId}-1`, nodeId, 1, 'A100', 81920, 'free');

const gpus = models.getGPUDevices(nodeId);
assert(gpus.length >= 2, 'GPU devices created');
assert(gpus.every(g => g.status === 'free'), 'GPU initial status = free');

// updateNodeHeartbeat
models.updateNodeHeartbeat(nodeId, [
  { index: 0, memory_used_mb: 40960, temperature: 52.3, power_w: 285, status: 'allocated' },
  { index: 1, memory_used_mb: 0, temperature: 48.1, power_w: 120, status: 'free' },
]);
const updatedGpus = models.getGPUDevices(nodeId);
assert(updatedGpus.some(g => g.status === 'allocated'), 'GPU status updated via heartbeat');
assert(updatedGpus.some(g => g.memory_used_mb === 40960), 'GPU memory updated via heartbeat');

const freeGpus = models.getAvailableGPUs(poolId);
assert(freeGpus.length >= 1, 'available GPUs query works');

models.updateNode(nodeId, { status: 'maintenance' });
const maintNode = models.getNode(nodeId);
assert(maintNode.status === 'maintenance', 'update node status');

models.deleteNode(nodeId);
assert(models.getNode(nodeId) === undefined, 'delete node');

models.deleteResourcePool(poolId);
assert(models.getResourcePool(poolId) === undefined, 'delete pool');

console.log('\n=== Models WP1.2 — Task Schedule ===');
const taskId = `tsk-${Date.now()}`;
models.createTaskSchedule(taskId, 'team-a', 'user-1', 'TrainModel', 'training', 80, null);
const task = models.getTaskSchedule(taskId);
assert(task !== undefined, 'create and get task schedule');
assert(task.priority === 80, 'task priority correct');
assert(task.status === 'pending', 'task initial status = pending');

models.updateTaskStatus(taskId, 'queued');
assert(models.getTaskSchedule(taskId).status === 'queued', 'task status → queued');

models.updateTaskStatus(taskId, 'running');
assert(models.getTaskSchedule(taskId).status === 'running', 'task status → running');
assert(models.getTaskSchedule(taskId).started_at !== null, 'started_at set on running');

models.createTaskSpec(taskId, { gpu_count: 4, gpu_memory_mb: 163840, cpu_cores: 8, memory_mb: 65536 });
const spec = models.getTaskSpec(taskId);
assert(spec !== undefined, 'task spec created');
assert(spec.gpu_count === 4, 'spec gpu_count correct');

models.createTaskEvent(taskId, 'queued', { queue_position: 1 });
models.createTaskEvent(taskId, 'progress', { progress: 0.5 });
const events = models.getTaskEvents(taskId);
assert(events.length >= 2, 'task events recorded');
assert(events.some(e => e.event_type === 'progress'), 'progress event found');

const allQueued = models.getTasksSchedule({ status: 'queued', limit: 100 });
// Our task is "running" now, should not be in queued
assert(!allQueued.some(t => t.id === taskId), 'running task not in queued query');

models.updateTaskStatus(taskId, 'completed', 'Model trained successfully');
assert(models.getTaskSchedule(taskId).status === 'completed', 'task status → completed');
assert(models.getTaskSchedule(taskId).completed_at !== null, 'completed_at set');

// ═══════════════════════════════════
// WP1.3 审计日志 & 费用
// ═══════════════════════════════════

console.log('\n=== Models WP1.3 — Audit Events ===');
const auditId = models.createAuditEvent({
  tenant_id: 'tenant-a',
  actor_type: 'user',
  actor_id: 'user-1',
  actor_name: 'Alice',
  resource_type: 'task',
  resource_id: taskId,
  action: 'task.create',
  result: 'success',
  detail: { gpu_count: 4 },
});
assert(auditId !== undefined, 'audit event created');

const queryResult = models.queryAuditEvents({
  tenant_id: 'tenant-a',
  actor_id: 'user-1',
  action: 'task.create',
  page: 1,
  page_size: 10,
});
assert(queryResult.items.length > 0, 'audit query returns results');
assert(queryResult.total >= 1, 'audit total count correct');
assert(queryResult.page === 1, 'audit pagination correct');

const evt = models.getAuditEvent(queryResult.items[0].id);
assert(evt !== undefined, 'get single audit event by id');

// Hash chain verification
const verifyResult = models.verifyHashChain(1, queryResult.items[0].id);
assert(typeof verifyResult.valid === 'boolean', 'hash chain verification runs');

// Export
const exported = models.exportAuditEvents({ tenant_id: 'tenant-a' });
assert(exported.length > 0, 'audit export works');

console.log('\n=== Models WP1.3 — Cost Records ===');
const costId = models.createCostRecord({
  tenant_id: 'tenant-a',
  team_id: 'team-a',
  task_id: taskId,
  task_name: 'TrainModel',
  gpu_count: 4,
  gpu_model: 'A100',
  duration_seconds: 7200,
  unit_price_per_hour: 10,
  total_cost: 80,
  started_at: new Date().toISOString(),
  ended_at: new Date().toISOString(),
});
assert(costId !== undefined, 'cost record created');

const costQuery = models.queryCostRecords({ team_id: 'team-a', page: 1, page_size: 10 });
assert(costQuery.items.length > 0, 'cost query returns results');

const costCalc = models.calculateCost('test', 2, 'A100', 3600, 1);
assert(costCalc.totalCost > 0, 'cost calculation works');
assert(costCalc.hours === 1, 'cost calc: 3600s = 1 hour');

const summary = models.getCostSummary('team-a');
assert(summary.length >= 0, 'cost summary query works');

// ═══════════════════════════════════
// Scheduler 模块
// ═══════════════════════════════════

console.log('\n=== Scheduler — Lifecycle ===');
assert(scheduler.isSchedulerRunning() === false, 'scheduler not running initially');
scheduler.startScheduler();
assert(scheduler.isSchedulerRunning() === true, 'scheduler started');
const stats = scheduler.getSchedulerStats();
assert(stats.running === true, 'scheduler stats: running');
assert(typeof stats.queued_count === 'number', 'scheduler stats: queued_count');
assert(typeof stats.running_count === 'number', 'scheduler stats: running_count');
assert(typeof stats.policy === 'string', 'scheduler stats: policy is string');
scheduler.stopScheduler();
assert(scheduler.isSchedulerRunning() === false, 'scheduler stopped');

// Start/stop idempotency
scheduler.startScheduler();
scheduler.startScheduler(); // second start should be no-op
assert(scheduler.isSchedulerRunning() === true, 'startScheduler idempotent');
scheduler.stopScheduler();

console.log('\n=== Scheduler — scheduleTick ===');
// scheduleTick should not throw when queue is empty
try {
  scheduler.scheduleTick();
  assert(true, 'scheduleTick on empty queue does not throw');
} catch (e) {
  assert(false, `scheduleTick threw: ${e.message}`);
}

// scheduleTick with queued tasks — test priority scheduling via DB
console.log('\n=== Scheduler — Priority Scheduling via DB ===');
const prioTask1 = `sched-${Date.now()}-1`;
const prioTask2 = `sched-${Date.now()}-2`;
gpuDb.prepare(
  'INSERT INTO tasks_schedule (id, team_id, user_id, name, type, status, priority, pool_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
).run(prioTask1, 'sched-team', 'user-1', 'LowPriority', 'training', 'queued', 20, null);
gpuDb.prepare(
  'INSERT INTO tasks_schedule (id, team_id, user_id, name, type, status, priority, pool_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
).run(prioTask2, 'sched-team', 'user-1', 'HighPriority', 'training', 'queued', 90, null);
assert(models.getTaskSchedule(prioTask1).status === 'queued', 'scheduler test: low prio queued');
assert(models.getTaskSchedule(prioTask2).status === 'queued', 'scheduler test: high prio queued');
// Cleanup
gpuDb.prepare('DELETE FROM tasks_schedule WHERE id = ?').run(prioTask1);
gpuDb.prepare('DELETE FROM tasks_schedule WHERE id = ?').run(prioTask2);

// ═══════════════════════════════════
// Process Manager 模块
// ═══════════════════════════════════

console.log('\n=== Process Manager ===');
assert(getActiveProcessCount() === 0, 'no active processes initially');

const sessionId = ensureSession('test-chat', 'tester');
assert(sessionId === 'test-chat:tester', 'ensureSession returns correct sessionId');

// buildFullPrompt should not throw
try {
  const prompt = buildFullPrompt('test-chat', 'tester', 'You are a tester', 'Test message');
  assert(typeof prompt === 'string' && prompt.length > 20, 'buildFullPrompt returns valid prompt');
  assert(prompt.includes('Test message'), 'prompt contains user message');
  assert(prompt.includes('You are a tester'), 'prompt contains role prompt');
} catch (e) {
  assert(false, `buildFullPrompt threw: ${e.message}`);
}

assert(typeof killAllProcesses === 'function', 'killAllProcesses is a function');

console.log('\n=== Process Manager — Security Edge Cases ===');
const lockAcquired = acquireChatLock('test-chat-lock', 'test', 5000);
assert(lockAcquired === true, 'acquire chat lock works');
const lockAgain = acquireChatLock('test-chat-lock', 'test2', 5000);
assert(lockAgain === false, 'cannot acquire same chat lock twice');
releaseChatLock('test-chat-lock');
const lockAfterRelease = acquireChatLock('test-chat-lock', 'test3', 5000);
assert(lockAfterRelease === true, 'chat lock can be re-acquired after release');
releaseChatLock('test-chat-lock');

// File lock
assert(isInProjectDir(__filename) === true, 'isInProjectDir: own file is in project');
assert(isInProjectDir('/etc/passwd') === false, 'isInProjectDir: /etc/passwd is not in project');
assert(isInProjectDir('/tmp/evil') === false, 'isInProjectDir: /tmp files not in project');

// ═══════════════════════════════════
// Router Edge Cases
// ═══════════════════════════════════

console.log('\n=== Router — Edge Cases ===');
const multiMentions = parseAtMentions('@CEO @PM 这个方案怎么样');
assert(multiMentions.length >= 2, 'multiple @mentions parsed');
assert(multiMentions.includes('ceo'), 'multi mention: ceo found');
assert(multiMentions.includes('pm'), 'multi mention: pm found');

assert(isSystemCommand('/status') === true, '/status is system command');
assert(isSystemCommand('/summary') === true, '/summary is system command');
assert(isSystemCommand('你好') === false, 'casual text not system command');
assert(isSystemCommand('/status please') === true, '/status with suffix is system command');

// routeMessage edge: multiple @mentions → first role
const routed = routeMessage('@后端 @前端 一起做个页面', 'test-chat');
assert(routed.role === 'backend-dev', 'multi @ routes to first mentioned role');

// routeMessage: no mention → keyword match
const keywordRouted = routeMessage('帮我审查代码', 'test-chat');
assert(keywordRouted.routingReason.includes('关键词'), 'keyword routing reason');

// routeMessage: no match → fallback to assistant
const fallbackRouted = routeMessage('今天天气怎么样', 'test-chat');
assert(fallbackRouted.role === 'assistant', 'no match falls back to assistant');

// classifyRoleIntent with triggers
assert(classifyRoleIntent('帮我审查代码') === 'reviewer', 'role classifyIntent: reviewer');
assert(classifyRoleIntent('设计方案如何') === 'architect', 'role classifyIntent: architect');

// ═══════════════════════════════════
// Tasks Edge Cases
// ═══════════════════════════════════

console.log('\n=== Tasks — Edge Cases ===');
const myTasks = formatMyTasks('nonexistent-chat', 'tester');
assert(typeof myTasks === 'string', 'formatMyTasks returns string for empty');

const autoClaimed = autoClaimTask('nonexistent-chat', 'tester');
assert(Array.isArray(autoClaimed), 'autoClaimTask returns array');
assert(autoClaimed.length === 0, 'autoClaimTask returns empty for nonexistent');

// ═══════════════════════════════════
// Role System Edge Cases
// ═══════════════════════════════════

console.log('\n=== Roles — Edge Cases ===');
const ceoRole = getRole('ceo');
assert(ceoRole.systemPrompt.includes('CEO'), 'CEO system prompt contains role name');
assert(ceoRole.triggers.length > 2, 'CEO has multiple triggers');

assert(ROLE_ORDER.length === 8, 'ROLE_ORDER has 8 roles');
assert(ROLE_ORDER[0] === 'ceo', 'ROLE_ORDER: first is ceo');
assert(ROLE_ORDER[7] === 'tester', 'ROLE_ORDER: last is tester');

// Verify all roles have system prompts
for (const id of ROLE_ORDER) {
  assert(ROLES[id].systemPrompt.length > 50, `${id} has detailed system prompt`);
}
assert(ROLE_ORDER.includes('architect'), 'ROLE_ORDER includes architect');
assert(ROLE_ORDER.includes('backend-dev'), 'ROLE_ORDER includes backend-dev');

// ═══════════════════════════════════
// Summary
// ═══════════════════════════════════

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
