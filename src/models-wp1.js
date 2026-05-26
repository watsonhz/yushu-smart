/**
 * WP1.2 统一调度引擎 + WP1.3 统一审计日志 数据模型
 * 扩展 db.js，添加调度引擎和审计日志所需的表结构和操作
 */

const path = require('path');
const DB_PATH = path.join(__dirname, '..', '.data', 'bot.db');
const { buildUpdate } = require('./db');

let db;

function initModels(database) {
  if (database) db = database;

  db.exec(`
    -- ============================================
    -- WP1.2 统一调度引擎
    -- ============================================

    CREATE TABLE IF NOT EXISTS resource_pools (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      scheduler_policy TEXT NOT NULL DEFAULT 'fifo' CHECK(scheduler_policy IN ('fifo','fair','priority')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
      labels TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pool_queues (
      id TEXT PRIMARY KEY,
      pool_id TEXT NOT NULL REFERENCES resource_pools(id) ON DELETE CASCADE,
      team_id TEXT,
      name TEXT NOT NULL,
      priority_weight INTEGER NOT NULL DEFAULT 10,
      max_running INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pool_queues_pool ON pool_queues(pool_id);
    CREATE INDEX IF NOT EXISTS idx_pool_queues_team ON pool_queues(team_id);

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      pool_id TEXT NOT NULL REFERENCES resource_pools(id) ON DELETE CASCADE,
      hostname TEXT NOT NULL UNIQUE,
      ip_address TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'online' CHECK(status IN ('online','offline','maintenance')),
      specs TEXT NOT NULL DEFAULT '{}',
      labels TEXT DEFAULT '{}',
      last_heartbeat TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_pool ON nodes(pool_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);

    CREATE TABLE IF NOT EXISTS gpu_devices (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      device_index INTEGER NOT NULL,
      gpu_model TEXT NOT NULL DEFAULT 'A100',
      memory_total_mb INTEGER NOT NULL DEFAULT 81920,
      memory_used_mb INTEGER NOT NULL DEFAULT 0,
      temperature REAL DEFAULT 0,
      power_w REAL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'free' CHECK(status IN ('free','allocated','error','degraded')),
      topology TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(node_id, device_index)
    );
    CREATE INDEX IF NOT EXISTS idx_gpu_node ON gpu_devices(node_id);
    CREATE INDEX IF NOT EXISTS idx_gpu_status ON gpu_devices(status);

    CREATE TABLE IF NOT EXISTS tasks_schedule (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'training' CHECK(type IN ('training','evaluation','serving')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','queued','running','completed','failed','preempted','cancelled')),
      priority INTEGER NOT NULL DEFAULT 50,
      pool_id TEXT,
      queue_position INTEGER,
      estimated_wait_seconds INTEGER,
      preempt_count INTEGER NOT NULL DEFAULT 0,
      k8s_job_name TEXT,
      max_retries INTEGER NOT NULL DEFAULT 3,
      result TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_sched_team ON tasks_schedule(team_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_sched_user ON tasks_schedule(user_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_sched_status ON tasks_schedule(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_sched_pool ON tasks_schedule(pool_id);

    CREATE TABLE IF NOT EXISTS task_specs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE REFERENCES tasks_schedule(id) ON DELETE CASCADE,
      gpu_count INTEGER NOT NULL DEFAULT 1,
      gpu_memory_mb INTEGER NOT NULL DEFAULT 81920,
      cpu_cores INTEGER NOT NULL DEFAULT 4,
      memory_mb INTEGER NOT NULL DEFAULT 16384,
      max_runtime_seconds INTEGER NOT NULL DEFAULT 86400,
      image TEXT,
      entrypoint TEXT,
      env_vars TEXT DEFAULT '{}',
      volume_mounts TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_specs_task ON task_specs(task_id);

    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks_schedule(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL CHECK(event_type IN ('queued','scheduled','started','completed','failed','preempted','cancelled','progress')),
      detail TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_events_type ON task_events(event_type);

    -- ============================================
    -- WP1.3 统一审计日志
    -- ============================================

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      tenant_id TEXT NOT NULL,
      actor_type TEXT NOT NULL CHECK(actor_type IN ('user','system')),
      actor_id TEXT NOT NULL,
      actor_name TEXT NOT NULL DEFAULT '',
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      resource_name TEXT DEFAULT '',
      action TEXT NOT NULL,
      result TEXT NOT NULL CHECK(result IN ('success','failure')),
      detail TEXT DEFAULT '{}',
      client_ip TEXT DEFAULT '',
      user_agent TEXT DEFAULT '',
      extra TEXT DEFAULT '{}',
      hash_prev TEXT,
      hash_chain TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_events(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events(actor_id);
    CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_events(resource_type, resource_id);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events(action);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);

    CREATE TABLE IF NOT EXISTS price_configs (
      id TEXT PRIMARY KEY,
      gpu_model TEXT NOT NULL UNIQUE,
      unit_price REAL NOT NULL,
      billing_mode TEXT NOT NULL DEFAULT 'per_gpu_hour',
      min_billing_secs INTEGER NOT NULL DEFAULT 60,
      effective_from TEXT NOT NULL DEFAULT (datetime('now')),
      effective_to TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cost_records (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_name TEXT NOT NULL DEFAULT '',
      gpu_count INTEGER NOT NULL DEFAULT 1,
      gpu_model TEXT NOT NULL DEFAULT 'A100',
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      unit_price_per_hour REAL NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      billing_mode TEXT NOT NULL DEFAULT 'per_gpu_hour',
      discount_rate REAL NOT NULL DEFAULT 1.0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','settled','refunded')),
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      settled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cost_tenant ON cost_records(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_cost_team ON cost_records(team_id);
    CREATE INDEX IF NOT EXISTS idx_cost_task ON cost_records(task_id);
    CREATE INDEX IF NOT EXISTS idx_cost_status ON cost_records(status);

    -- 默认计费价格
    INSERT OR IGNORE INTO price_configs (id, gpu_model, unit_price) VALUES ('price-a100', 'A100', 10.00);
    INSERT OR IGNORE INTO price_configs (id, gpu_model, unit_price) VALUES ('price-a800', 'A800', 8.00);
    INSERT OR IGNORE INTO price_configs (id, gpu_model, unit_price) VALUES ('price-h800', 'H800', 25.00);
  `);

  return db;
}

// =============================================
// WP1.2 调度引擎 - 数据操作
// =============================================

function createResourcePool(id, name, policy, labels) {
  return db.prepare(
    'INSERT INTO resource_pools (id, name, scheduler_policy, labels) VALUES (?, ?, ?, ?)'
  ).run(id, name, policy || 'fifo', JSON.stringify(labels || {}));
}

function getResourcePools() {
  return db.prepare('SELECT * FROM resource_pools ORDER BY created_at DESC').all();
}

function getResourcePool(id) {
  return db.prepare('SELECT * FROM resource_pools WHERE id = ?').get(id);
}

function updateResourcePool(id, fields) {
  const stmt = buildUpdate('resource_pools', id, 'id', fields,
    ['name', 'scheduler_policy', 'status', 'labels'], ['labels']);
  if (stmt) db.prepare(stmt.sql).run(...stmt.params);
}

function deleteResourcePool(id) {
  return db.prepare('DELETE FROM resource_pools WHERE id = ?').run(id);
}

function createNode(id, poolId, hostname, ip, specs, labels) {
  const now = new Date().toISOString();
  return db.prepare(
    'INSERT INTO nodes (id, pool_id, hostname, ip_address, specs, labels, last_heartbeat) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, poolId, hostname, ip, JSON.stringify(specs), JSON.stringify(labels || {}), now);
}

function getNodes(poolId) {
  if (poolId) {
    return db.prepare('SELECT * FROM nodes WHERE pool_id = ? ORDER BY created_at DESC').all(poolId);
  }
  return db.prepare('SELECT * FROM nodes ORDER BY created_at DESC').all();
}

function getNode(id) {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
}

function updateNode(id, fields) {
  const stmt = buildUpdate('nodes', id, 'id', fields,
    ['status', 'labels', 'specs', 'last_heartbeat'], ['labels', 'specs']);
  if (stmt) db.prepare(stmt.sql).run(...stmt.params);
}

function updateNodeHeartbeat(id, gpuDevices) {
  const now = new Date().toISOString();
  const txn = db.transaction(() => {
    db.prepare("UPDATE nodes SET last_heartbeat = ?, updated_at = datetime('now') WHERE id = ?").run(now, id);
    if (gpuDevices) {
      for (const gpu of gpuDevices) {
        db.prepare(
          `UPDATE gpu_devices SET memory_used_mb = ?, temperature = ?, power_w = ?, status = ?, updated_at = datetime('now')
           WHERE node_id = ? AND device_index = ?`
        ).run(gpu.memory_used_mb || 0, gpu.temperature || 0, gpu.power_w || 0, gpu.status || 'free', id, gpu.index);
      }
    }
  });
  txn();
}

function deleteNode(id) {
  return db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
}

function getGPUDevices(nodeId) {
  return db.prepare('SELECT * FROM gpu_devices WHERE node_id = ? ORDER BY device_index').all(nodeId);
}

function getAvailableGPUs(poolId) {
  return db.prepare(
    `SELECT g.* FROM gpu_devices g
     JOIN nodes n ON n.id = g.node_id
     WHERE n.pool_id = ? AND g.status = 'free' AND n.status = 'online'
     ORDER BY g.memory_total_mb DESC`
  ).all(poolId);
}

function createTaskSchedule(id, teamId, userId, name, type, priority, poolId) {
  return db.prepare(
    'INSERT INTO tasks_schedule (id, team_id, user_id, name, type, priority, pool_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, teamId, userId, name, type || 'training', priority || 50, poolId);
}

function updateTaskStatus(taskId, status, result, errorMessage) {
  const sets = ["status = ?", "updated_at = datetime('now')"];
  const vals = [status];
  if (status === 'running') {
    sets.push("started_at = datetime('now')");
  }
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    sets.push("completed_at = datetime('now')");
  }
  if (result !== undefined) { sets.push('result = ?'); vals.push(result); }
  if (errorMessage !== undefined) { sets.push('error_message = ?'); vals.push(errorMessage); }
  vals.push(taskId);
  return db.prepare(`UPDATE tasks_schedule SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

function getTasksSchedule(filters) {
  let sql = 'SELECT * FROM tasks_schedule WHERE 1=1';
  const params = [];
  if (filters.team_id) { sql += ' AND team_id = ?'; params.push(filters.team_id); }
  if (filters.user_id) { sql += ' AND user_id = ?'; params.push(filters.user_id); }
  if (filters.status) { sql += ' AND status = ?'; params.push(filters.status); }
  if (filters.pool_id) { sql += ' AND pool_id = ?'; params.push(filters.pool_id); }
  sql += ' ORDER BY created_at DESC';
  if (filters.limit) { sql += ' LIMIT ?'; params.push(filters.limit); }
  return db.prepare(sql).all(...params);
}

function getTaskSchedule(id) {
  return db.prepare('SELECT * FROM tasks_schedule WHERE id = ?').get(id);
}

function createTaskEvent(taskId, eventType, detail) {
  return db.prepare(
    'INSERT INTO task_events (task_id, event_type, detail) VALUES (?, ?, ?)'
  ).run(taskId, eventType, JSON.stringify(detail || {}));
}

function getTaskEvents(taskId) {
  return db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC').all(taskId);
}

function createTaskSpec(taskId, spec) {
  return db.prepare(
    `INSERT INTO task_specs (id, task_id, gpu_count, gpu_memory_mb, cpu_cores, memory_mb,
      max_runtime_seconds, image, entrypoint, env_vars, volume_mounts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `spec-${taskId}`, taskId,
    spec.gpu_count || 1, spec.gpu_memory_mb || 81920,
    spec.cpu_cores || 4, spec.memory_mb || 16384,
    spec.max_runtime_seconds || 86400, spec.image || '',
    spec.entrypoint || '', JSON.stringify(spec.env_vars || {}),
    JSON.stringify(spec.volume_mounts || [])
  );
}

function getTaskSpec(taskId) {
  return db.prepare('SELECT * FROM task_specs WHERE task_id = ?').get(taskId);
}

// =============================================
// WP1.3 审计日志 - 数据操作
// =============================================

function createAuditEvent(event) {
  const id = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  // hash chain: SHA256(event_data + prev_hash)
  const prevEvent = db.prepare('SELECT hash_chain FROM audit_events ORDER BY id DESC LIMIT 1').get();
  const prevHash = prevEvent ? prevEvent.hash_chain : 'GENESIS';
  const eventData = `${id}|${event.tenant_id}|${event.actor_id}|${event.resource_type}|${event.action}|${now}`;
  const crypto = require('crypto');
  const hashChain = crypto.createHash('sha256').update(eventData + prevHash).digest('hex');

  return db.prepare(
    `INSERT INTO audit_events (event_id, tenant_id, actor_type, actor_id, actor_name,
      resource_type, resource_id, resource_name, action, result, detail,
      client_ip, user_agent, extra, hash_prev, hash_chain, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, event.tenant_id, event.actor_type || 'user', event.actor_id, event.actor_name || '',
    event.resource_type, event.resource_id || '', event.resource_name || '',
    event.action, event.result || 'success',
    JSON.stringify(event.detail || {}),
    event.client_ip || '', event.user_agent || '',
    JSON.stringify(event.extra || {}),
    prevHash, hashChain, now
  );
}

function queryAuditEvents(filters) {
  let sql = 'SELECT * FROM audit_events WHERE 1=1';
  const params = [];
  if (filters.tenant_id) { sql += ' AND tenant_id = ?'; params.push(filters.tenant_id); }
  if (filters.actor_id) { sql += ' AND actor_id = ?'; params.push(filters.actor_id); }
  if (filters.resource_type) { sql += ' AND resource_type = ?'; params.push(filters.resource_type); }
  if (filters.action) {
    const actions = filters.action.split(',');
    sql += ` AND action IN (${actions.map(() => '?').join(',')})`;
    params.push(...actions);
  }
  if (filters.result) { sql += ' AND result = ?'; params.push(filters.result); }
  if (filters.start) { sql += ' AND created_at >= ?'; params.push(filters.start); }
  if (filters.end) { sql += ' AND created_at <= ?'; params.push(filters.end); }

  // count
  const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
  const total = db.prepare(countSql).get(...params).total;

  sql += ' ORDER BY created_at DESC';
  const page = filters.page || 1;
  const pageSize = filters.page_size || 50;
  const offset = (page - 1) * pageSize;
  sql += ' LIMIT ? OFFSET ?';
  params.push(pageSize, offset);

  const items = db.prepare(sql).all(...params);

  return { items, total, page, page_size: pageSize };
}

function getAuditEvent(id) {
  return db.prepare('SELECT * FROM audit_events WHERE id = ? OR event_id = ?').get(id, id);
}

function exportAuditEvents(filters) {
  let sql = 'SELECT * FROM audit_events WHERE 1=1';
  const params = [];
  if (filters.tenant_id) { sql += ' AND tenant_id = ?'; params.push(filters.tenant_id); }
  if (filters.start) { sql += ' AND created_at >= ?'; params.push(filters.start); }
  if (filters.end) { sql += ' AND created_at <= ?'; params.push(filters.end); }
  sql += ' ORDER BY created_at ASC LIMIT 100000';
  return db.prepare(sql).all(...params);
}

function createCostRecord(record) {
  const id = `cost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return db.prepare(
    `INSERT INTO cost_records (id, tenant_id, team_id, task_id, task_name, gpu_count,
      gpu_model, duration_seconds, unit_price_per_hour, total_cost, billing_mode,
      discount_rate, status, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, record.tenant_id, record.team_id, record.task_id,
    record.task_name || '', record.gpu_count || 1,
    record.gpu_model || 'A100', record.duration_seconds || 0,
    record.unit_price_per_hour || 10, record.total_cost || 0,
    record.billing_mode || 'per_gpu_hour', record.discount_rate || 1.0,
    record.status || 'pending', record.started_at, record.ended_at
  );
}

function queryCostRecords(filters) {
  let sql = 'SELECT * FROM cost_records WHERE 1=1';
  const params = [];
  if (filters.team_id) { sql += ' AND team_id = ?'; params.push(filters.team_id); }
  if (filters.tenant_id) { sql += ' AND tenant_id = ?'; params.push(filters.tenant_id); }
  if (filters.start) { sql += ' AND created_at >= ?'; params.push(filters.start); }
  if (filters.end) { sql += ' AND created_at <= ?'; params.push(filters.end); }
  if (filters.status) { sql += ' AND status = ?'; params.push(filters.status); }

  const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
  const total = db.prepare(countSql).get(...params).total;

  sql += ' ORDER BY created_at DESC';
  const page = filters.page || 1;
  const pageSize = filters.page_size || 50;
  sql += ' LIMIT ? OFFSET ?';
  params.push(pageSize, (page - 1) * pageSize);

  return { items: db.prepare(sql).all(...params), total, page, page_size: pageSize };
}

function getCostSummary(teamId, tenantId, start, end) {
  let sql = `SELECT team_id,
    SUM(gpu_count * duration_seconds / 3600.0) as total_gpu_hours,
    SUM(total_cost) as total_cost,
    COUNT(DISTINCT task_id) as task_count
    FROM cost_records WHERE status != 'refunded'`;
  const params = [];
  if (teamId) { sql += ' AND team_id = ?'; params.push(teamId); }
  if (tenantId) { sql += ' AND tenant_id = ?'; params.push(tenantId); }
  if (start) { sql += ' AND created_at >= ?'; params.push(start); }
  if (end) { sql += ' AND created_at <= ?'; params.push(end); }
  sql += ' GROUP BY team_id ORDER BY total_cost DESC';
  return db.prepare(sql).all(...params);
}

function calculateCost(taskId, gpuCount, gpuModel, durationSeconds, discountRate) {
  const priceConfig = db.prepare('SELECT * FROM price_configs WHERE gpu_model = ? AND (effective_to IS NULL OR effective_to >= datetime(\'now\'))').get(gpuModel || 'A100');
  const unitPrice = priceConfig ? priceConfig.unit_price : 10.0;
  const rate = discountRate || 1.0;
  const hours = durationSeconds / 3600.0;
  const totalCost = hours * gpuCount * unitPrice * rate;
  return { unitPrice, totalCost: Math.round(totalCost * 100) / 100, hours: Math.round(hours * 100) / 100 };
}

function verifyHashChain(fromId, toId) {
  const events = db.prepare(
    'SELECT * FROM audit_events WHERE id BETWEEN ? AND ? ORDER BY id ASC'
  ).all(fromId, toId);
  const crypto = require('crypto');
  let prevHash = 'GENESIS';
  for (const evt of events) {
    const eventData = `${evt.event_id}|${evt.tenant_id}|${evt.actor_id}|${evt.resource_type}|${evt.action}|${evt.created_at}`;
    const expectedHash = crypto.createHash('sha256').update(eventData + prevHash).digest('hex');
    if (evt.hash_chain !== expectedHash) {
      return { valid: false, brokenAt: evt.id, expected: expectedHash, actual: evt.hash_chain };
    }
    prevHash = evt.hash_chain;
  }
  return { valid: true, eventCount: events.length };
}

module.exports = {
  initModels,

  // WP1.2
  createResourcePool, getResourcePools, getResourcePool, updateResourcePool, deleteResourcePool,
  createNode, getNodes, getNode, updateNode, updateNodeHeartbeat, deleteNode,
  getGPUDevices, getAvailableGPUs,
  createTaskSchedule, updateTaskStatus, getTasksSchedule, getTaskSchedule,
  createTaskEvent, getTaskEvents,
  createTaskSpec, getTaskSpec,

  // WP1.3
  createAuditEvent, queryAuditEvents, getAuditEvent, exportAuditEvents,
  createCostRecord, queryCostRecords, getCostSummary, calculateCost,
  verifyHashChain,
};
