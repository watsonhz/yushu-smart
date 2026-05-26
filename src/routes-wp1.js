/**
 * WP1.2 统一调度引擎 + WP1.3 统一审计日志 — API 路由
 */
const { Router } = require('express');
const m = require('./models-wp1');
const scheduler = require('./scheduler');
const db = require('./db');

const router = Router();

// =============================================
// WP1.2 - 资源池管理
// =============================================

router.post('/pools', (req, res) => {
  try {
    const { name, scheduler_policy, labels } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = `pool-${Date.now()}`;
    m.createResourcePool(id, name, scheduler_policy, labels);
    res.status(201).json({ id, name, scheduler_policy: scheduler_policy || 'fifo' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/pools', (req, res) => {
  try {
    const pools = m.getResourcePools();
    res.json({ items: pools, total: pools.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/pools/:id', (req, res) => {
  try {
    const pool = m.getResourcePool(req.params.id);
    if (!pool) return res.status(404).json({ error: 'Pool not found' });
    const nodes = m.getNodes(req.params.id);
    const gpuCount = nodes.reduce((sum, n) => {
      const specs = JSON.parse(n.specs || '{}');
      return sum + (specs.gpu_count || 0);
    }, 0);
    res.json({ ...pool, node_count: nodes.length, gpu_count: gpuCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/pools/:id', (req, res) => {
  try {
    const pool = m.getResourcePool(req.params.id);
    if (!pool) return res.status(404).json({ error: 'Pool not found' });
    m.updateResourcePool(req.params.id, req.body);
    res.json({ status: 'updated', id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/pools/:id', (req, res) => {
  try {
    const nodes = m.getNodes(req.params.id);
    if (nodes.some(n => n.status === 'online')) {
      return res.status(400).json({ error: 'Pool has active nodes, cannot delete' });
    }
    m.deleteResourcePool(req.params.id);
    res.json({ status: 'deleted', id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// WP1.2 - 节点管理
// =============================================

router.post('/pools/:poolId/nodes', (req, res) => {
  try {
    const pool = m.getResourcePool(req.params.poolId);
    if (!pool) return res.status(404).json({ error: 'Pool not found' });

    const { hostname, ip_address, specs, labels } = req.body;
    if (!hostname || !ip_address) return res.status(400).json({ error: 'hostname and ip_address required' });

    const id = `node-${Date.now()}`;
    m.createNode(id, req.params.poolId, hostname, ip_address, specs, labels);

    // 同步创建 GPU device 记录
    const gpuModel = specs?.gpu_model || 'A100';
    const gpuCount = specs?.gpu_count || 1;
    const gpuMem = specs?.gpu_memory_mb || 81920;
    const gpuDb = db.getDb();
    const insertGPU = gpuDb.prepare(
      'INSERT OR IGNORE INTO gpu_devices (id, node_id, device_index, gpu_model, memory_total_mb, status) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (let i = 0; i < gpuCount; i++) {
      insertGPU.run(`gpu-${id}-${i}`, id, i, gpuModel, gpuMem, 'free');
    }

    res.status(201).json({ id, hostname, pool_id: req.params.poolId, gpu_count: gpuCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/pools/:poolId/nodes', (req, res) => {
  try {
    const nodes = m.getNodes(req.params.poolId);
    res.json({ items: nodes, total: nodes.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/nodes/:id', (req, res) => {
  try {
    const node = m.getNode(req.params.id);
    if (!node) return res.status(404).json({ error: 'Node not found' });
    const gpus = m.getGPUDevices(req.params.id);
    res.json({ ...node, gpu_devices: gpus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/nodes/:id', (req, res) => {
  try {
    m.updateNode(req.params.id, req.body);
    res.json({ status: 'updated', id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/nodes/:id', (req, res) => {
  try {
    m.deleteNode(req.params.id);
    res.json({ status: 'deleted', id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/nodes/:id/heartbeat', (req, res) => {
  try {
    const { gpu_devices } = req.body;
    m.updateNodeHeartbeat(req.params.id, gpu_devices);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/nodes/:id/drain', (req, res) => {
  try {
    m.updateNode(req.params.id, { status: 'maintenance' });
    res.json({ status: 'draining', id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// WP1.2 - 任务管理
// =============================================

router.post('/tasks', (req, res) => {
  try {
    const { name, type, team_id, user_id, priority, pool_id, spec } = req.body;
    if (!name || !team_id || !user_id) {
      return res.status(400).json({ error: 'name, team_id, user_id required' });
    }

    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    m.createTaskSchedule(id, team_id, user_id, name, type, priority, pool_id);

    if (spec) {
      m.createTaskSpec(id, spec);
    }

    // 入队事件
    m.createTaskEvent(id, 'queued', { queue_position: 1 });

    // 计算预计等待时间（简单模拟）
    const runningTasks = m.getTasksSchedule({ pool_id, status: 'running', limit: 10 });
    const estimatedWait = runningTasks.length * 300; // 5min per running task

    m.updateTaskStatus(id, 'queued');
    res.status(202).json({
      id,
      status: 'queued',
      queue_position: runningTasks.length + 1,
      estimated_wait_seconds: estimatedWait,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/tasks', (req, res) => {
  try {
    const tasks = m.getTasksSchedule({
      team_id: req.query.team_id,
      user_id: req.query.user_id,
      status: req.query.status,
      pool_id: req.query.pool_id,
      limit: parseInt(req.query.limit) || 100,
    });
    res.json({ items: tasks, total: tasks.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/tasks/:id', (req, res) => {
  try {
    const task = m.getTaskSchedule(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const spec = m.getTaskSpec(req.params.id);
    const events = m.getTaskEvents(req.params.id);
    res.json({ ...task, spec, events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/tasks/:id/cancel', (req, res) => {
  try {
    const task = m.getTaskSchedule(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      return res.status(400).json({ error: `Task already in ${task.status} state` });
    }
    m.updateTaskStatus(req.params.id, 'cancelled');
    m.createTaskEvent(req.params.id, 'cancelled', { reason: req.body.reason || 'user_cancelled' });
    res.json({ status: 'cancelled', id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/tasks/:id/priority', (req, res) => {
  try {
    const { priority } = req.body;
    if (priority === undefined || priority < 0 || priority > 100) {
      return res.status(400).json({ error: 'priority must be 0-100' });
    }
    const task = m.getTaskSchedule(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const db = require('./db').getDb();
    db.prepare('UPDATE tasks_schedule SET priority = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(priority, req.params.id);
    m.createTaskEvent(req.params.id, 'progress', { priority_changed: priority });
    res.json({ status: 'updated', priority, id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/tasks/:id/events', (req, res) => {
  try {
    const events = m.getTaskEvents(req.params.id);
    res.json({ items: events, total: events.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// WP1.2 - 队列 & 调度
// =============================================

router.get('/queue', (req, res) => {
  try {
    const queued = m.getTasksSchedule({ status: 'queued', limit: 100 });
    const running = m.getTasksSchedule({ status: 'running', limit: 100 });
    res.json({
      queued: queued.map(t => ({
        id: t.id, name: t.name, priority: t.priority,
        created_at: t.created_at, position: queued.indexOf(t) + 1,
      })),
      running: running.map(t => ({
        id: t.id, name: t.name, started_at: t.started_at,
      })),
      queue_depth: queued.length,
      running_count: running.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// WP1.3 - 审计日志
// =============================================

router.post('/internal/audit-events', (req, res) => {
  try {
    // 内部接口，用 X-Internal-Token 鉴权
    const token = req.headers['x-internal-token'];
    if (token !== process.env.INTERNAL_TOKEN && process.env.INTERNAL_TOKEN) {
      return res.status(403).json({ error: 'invalid internal token' });
    }
    m.createAuditEvent(req.body);
    res.status(202).json({ status: 'accepted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/audit-events', (req, res) => {
  try {
    const result = m.queryAuditEvents({
      tenant_id: req.query.tenant_id,
      actor_id: req.query.actor_id,
      resource_type: req.query.resource_type,
      action: req.query.action,
      result: req.query.result,
      start: req.query.start,
      end: req.query.end,
      page: parseInt(req.query.page) || 1,
      page_size: Math.min(parseInt(req.query.page_size) || 50, 200),
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/audit-events/export', (req, res) => {
  try {
    const items = m.exportAuditEvents({
      tenant_id: req.query.tenant_id,
      start: req.query.start,
      end: req.query.end,
    });
    if (items.length >= 100000) {
      return res.status(413).json({ error: 'Export too large, narrow your time range' });
    }
    let csv = 'event_id,tenant_id,actor_type,actor_id,actor_name,resource_type,resource_id,action,result,created_at\n';
    for (const evt of items) {
      csv += `"${evt.event_id}","${evt.tenant_id}","${evt.actor_type}","${evt.actor_id}","${evt.actor_name}","${evt.resource_type}","${evt.resource_id}","${evt.action}","${evt.result}","${evt.created_at}"\n`;
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-export.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/audit-events/:id', (req, res) => {
  try {
    const evt = m.getAuditEvent(req.params.id);
    if (!evt) return res.status(404).json({ error: 'Audit event not found' });
    res.json(evt);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// WP1.3 - 费用管理
// =============================================

router.post('/cost-records', (req, res) => {
  try {
    const { task_id, tenant_id, team_id, task_name, gpu_count, gpu_model, duration_seconds, discount_rate } = req.body;
    if (!task_id || !tenant_id || !team_id) {
      return res.status(400).json({ error: 'task_id, tenant_id, team_id required' });
    }

    const cost = m.calculateCost(task_id, gpu_count, gpu_model, duration_seconds, discount_rate);
    const startedAt = req.body.started_at || new Date().toISOString();
    const endedAt = req.body.ended_at || new Date().toISOString();

    m.createCostRecord({
      tenant_id, team_id, task_id, task_name: task_name || '',
      gpu_count: gpu_count || 1, gpu_model: gpu_model || 'A100',
      duration_seconds: duration_seconds || 0,
      unit_price_per_hour: cost.unitPrice,
      total_cost: cost.totalCost,
      started_at: startedAt, ended_at: endedAt,
    });

    res.status(201).json({ status: 'created', total_cost: cost.totalCost, unit_price: cost.unitPrice });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/cost-records', (req, res) => {
  try {
    const result = m.queryCostRecords({
      team_id: req.query.team_id,
      tenant_id: req.query.tenant_id,
      status: req.query.status,
      start: req.query.start,
      end: req.query.end,
      page: parseInt(req.query.page) || 1,
      page_size: Math.min(parseInt(req.query.page_size) || 50, 200),
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/cost-records/summary', (req, res) => {
  try {
    const summary = m.getCostSummary(req.query.team_id, req.query.tenant_id, req.query.start, req.query.end);
    res.json({ items: summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/cost-records/export', (req, res) => {
  try {
    const result = m.queryCostRecords({
      team_id: req.query.team_id,
      tenant_id: req.query.tenant_id,
      start: req.query.start,
      end: req.query.end,
      page: 1, page_size: 100000,
    });
    let csv = 'team_id,task_id,task_name,gpu_count,gpu_model,duration_seconds,unit_price_per_hour,total_cost,status,started_at,ended_at\n';
    for (const r of result.items) {
      csv += `"${r.team_id}","${r.task_id}","${r.task_name}",${r.gpu_count},"${r.gpu_model}",${r.duration_seconds},${r.unit_price_per_hour},${r.total_cost},"${r.status}","${r.started_at}","${r.ended_at}"\n`;
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="cost-export.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// WP1.3 - 审计完整性校验
// =============================================

router.get('/audit/verify', (req, res) => {
  try {
    const fromId = parseInt(req.query.from) || 1;
    const toId = parseInt(req.query.to) || fromId + 999;
    const result = m.verifyHashChain(fromId, toId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// WP1.2 - 调度器状态
// =============================================

router.get('/scheduler/status', (req, res) => {
  try {
    res.json(scheduler.getSchedulerStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/scheduler/tick', (req, res) => {
  try {
    scheduler.scheduleTick();
    res.json({ status: 'tick_triggered' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
