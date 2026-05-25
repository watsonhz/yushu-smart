/**
 * WP4 交付与部署 — 数据模型
 * 覆盖：推理服务部署、多环境管理、自动扩缩容、服务端点管理
 */

let db;

function initModels(database) {
  if (database) db = database;

  db.exec(`
    -- ============================================
    -- WP4.1 模型推理服务
    -- ============================================

    CREATE TABLE IF NOT EXISTS deployment_environments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL DEFAULT 'development' CHECK(type IN ('development','staging','production')),
      base_url TEXT NOT NULL DEFAULT '',
      namespace TEXT,
      config TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS inference_services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      env_id TEXT NOT NULL REFERENCES deployment_environments(id) ON DELETE CASCADE,
      model_name TEXT NOT NULL,
      model_version TEXT NOT NULL DEFAULT 'latest',
      protocol TEXT NOT NULL DEFAULT 'http' CHECK(protocol IN ('http','grpc')),
      status TEXT NOT NULL DEFAULT 'creating' CHECK(status IN ('creating','running','stopped','failed','rolling_back')),
      status_reason TEXT,
      endpoint_url TEXT,
      replica_count INTEGER NOT NULL DEFAULT 1,
      target_replica_count INTEGER,
      config TEXT NOT NULL DEFAULT '{}',
      health_check_path TEXT DEFAULT '/health',
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_inf_services_env ON inference_services(env_id);
    CREATE INDEX IF NOT EXISTS idx_inf_services_status ON inference_services(status);
    CREATE INDEX IF NOT EXISTS idx_inf_services_model ON inference_services(model_name, model_version);

    -- ============================================
    -- WP4.1 部署版本历史（用于回滚）
    -- ============================================

    CREATE TABLE IF NOT EXISTS deployment_revisions (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES inference_services(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      model_version TEXT NOT NULL,
      protocol TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','rolled_back','failed')),
      deployed_by TEXT,
      deployed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_deploy_rev_service ON deployment_revisions(service_id);
    CREATE INDEX IF NOT EXISTS idx_deploy_rev_revision ON deployment_revisions(service_id, revision);

    -- ============================================
    -- WP4.1 API 凭证
    -- ============================================

    CREATE TABLE IF NOT EXISTS api_credentials (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES inference_services(id) ON DELETE CASCADE,
      api_key TEXT NOT NULL UNIQUE,
      api_secret TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','expired')),
      created_by TEXT NOT NULL DEFAULT 'system',
      expires_at TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_api_cred_service ON api_credentials(service_id);
    CREATE INDEX IF NOT EXISTS idx_api_cred_key ON api_credentials(api_key);

    -- ============================================
    -- WP4.2 自动扩缩容策略
    -- ============================================

    CREATE TABLE IF NOT EXISTS scaling_policies (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES inference_services(id) ON DELETE CASCADE,
      min_replicas INTEGER NOT NULL DEFAULT 1,
      max_replicas INTEGER NOT NULL DEFAULT 10,
      target_cpu_utilization REAL DEFAULT 70.0,
      target_memory_utilization REAL DEFAULT 80.0,
      cooldown_seconds INTEGER NOT NULL DEFAULT 300,
      batch_size INTEGER DEFAULT 8,
      batch_max_wait_ms INTEGER DEFAULT 100,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_scaling_service ON scaling_policies(service_id);

    -- ============================================
    -- WP4.3 服务流量规则
    -- ============================================

    CREATE TABLE IF NOT EXISTS traffic_rules (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES inference_services(id) ON DELETE CASCADE,
      rule_type TEXT NOT NULL CHECK(rule_type IN ('canary','blue_green','mirror','weighted')),
      weight INTEGER NOT NULL DEFAULT 100,
      target_revision INTEGER,
      headers TEXT DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_traffic_service ON traffic_rules(service_id);

    -- ============================================
    -- WP4.4 部署流水线记录
    -- ============================================

    CREATE TABLE IF NOT EXISTS deployment_pipelines (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES inference_services(id) ON DELETE CASCADE,
      pipeline_type TEXT NOT NULL CHECK(pipeline_type IN ('deploy','rollback','scale','update_config')),
      from_revision INTEGER,
      to_revision INTEGER,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','success','failed','cancelled')),
      started_by TEXT,
      steps TEXT DEFAULT '[]',
      current_step INTEGER DEFAULT 0,
      error_message TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_service ON deployment_pipelines(service_id);
    CREATE INDEX IF NOT EXISTS idx_pipeline_status ON deployment_pipelines(status);

    -- ============================================
    -- 默认环境
    -- ============================================

    INSERT OR IGNORE INTO deployment_environments (id, name, type, base_url) VALUES
      ('env-dev', 'development', 'development', 'http://dev.internal:8080'),
      ('env-staging', 'staging', 'staging', 'http://staging.internal:8080'),
      ('env-prod', 'production', 'production', 'http://prod.internal:8080');
  `);

  return db;
}

// =============================================
// WP4.1 推理服务管理
// =============================================

function createInferenceService(name, envId, modelName, modelVersion, protocol, config, createdBy) {
  const id = `svc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(
    `INSERT INTO inference_services (id, name, env_id, model_name, model_version, protocol, config, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, envId, modelName, modelVersion || 'latest', protocol || 'http',
    JSON.stringify(config || {}), createdBy || 'system');
  return id;
}

function getInferenceService(id) {
  return db.prepare('SELECT * FROM inference_services WHERE id = ?').get(id);
}

function getInferenceServices(filters) {
  let sql = 'SELECT * FROM inference_services WHERE 1=1';
  const params = [];
  if (filters.env_id) { sql += ' AND env_id = ?'; params.push(filters.env_id); }
  if (filters.status) { sql += ' AND status = ?'; params.push(filters.status); }
  if (filters.model_name) { sql += ' AND model_name = ?'; params.push(filters.model_name); }
  sql += ' ORDER BY created_at DESC';
  if (filters.limit) { sql += ' LIMIT ?'; params.push(filters.limit); }
  return db.prepare(sql).all(...params);
}

function updateInferenceService(id, fields) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (['status', 'status_reason', 'endpoint_url', 'replica_count', 'target_replica_count', 'config', 'health_check_path'].includes(k)) {
      sets.push(`${k} = ?`);
      vals.push(k === 'config' ? JSON.stringify(v) : v);
    }
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  return db.prepare(`UPDATE inference_services SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

function deleteInferenceService(id) {
  return db.prepare('DELETE FROM inference_services WHERE id = ?').run(id);
}

// =============================================
// WP4.1 部署版本管理（回滚支持）
// =============================================

function createDeploymentRevision(serviceId, revision, modelVersion, protocol, config, deployedBy) {
  const id = `rev-${serviceId}-${revision}`;
  // 将之前所有 active 版本标记为 superseded
  db.prepare(
    "UPDATE deployment_revisions SET status = 'superseded' WHERE service_id = ? AND status = 'active'"
  ).run(serviceId);
  return db.prepare(
    `INSERT INTO deployment_revisions (id, service_id, revision, model_version, protocol, config, deployed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, serviceId, revision, modelVersion, protocol, JSON.stringify(config || {}), deployedBy);
}

function getDeploymentRevisions(serviceId) {
  return db.prepare(
    'SELECT * FROM deployment_revisions WHERE service_id = ? ORDER BY revision DESC'
  ).all(serviceId);
}

function getLatestRevision(serviceId) {
  return db.prepare(
    'SELECT * FROM deployment_revisions WHERE service_id = ? ORDER BY revision DESC LIMIT 1'
  ).get(serviceId);
}

// =============================================
// WP4.1 API 凭证
// =============================================

const crypto = require('crypto');

function generateApiKey() {
  return `fk-${crypto.randomBytes(24).toString('hex')}`;
}

function generateApiSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function createApiCredential(serviceId, name, createdBy, expiresInDays) {
  const id = `cred-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const apiKey = generateApiKey();
  const apiSecret = generateApiSecret();
  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 86400000).toISOString()
    : null;
  db.prepare(
    'INSERT INTO api_credentials (id, service_id, api_key, api_secret, name, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, serviceId, apiKey, apiSecret, name || 'default', createdBy || 'system', expiresAt);
  return { id, api_key: apiKey, api_secret: apiSecret, name: name || 'default', expires_at: expiresAt };
}

function getApiCredentials(serviceId) {
  return db.prepare(
    'SELECT id, service_id, name, status, created_by, expires_at, last_used_at, created_at FROM api_credentials WHERE service_id = ?'
  ).all(serviceId);
}

function validateApiKey(apiKey) {
  const cred = db.prepare(
    "SELECT * FROM api_credentials WHERE api_key = ? AND status = 'active' AND (expires_at IS NULL OR expires_at >= datetime('now'))"
  ).get(apiKey);
  if (!cred) return null;
  // 更新 last_used_at
  db.prepare("UPDATE api_credentials SET last_used_at = datetime('now') WHERE id = ?").run(cred.id);
  return cred;
}

function revokeApiCredential(id) {
  return db.prepare("UPDATE api_credentials SET status = 'revoked' WHERE id = ?").run(id);
}

// =============================================
// WP4.2 扩缩容策略
// =============================================

function createOrUpdateScalingPolicy(serviceId, policy) {
  const existing = db.prepare('SELECT id FROM scaling_policies WHERE service_id = ?').get(serviceId);
  if (existing) {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(policy)) {
      if (['min_replicas', 'max_replicas', 'target_cpu_utilization', 'target_memory_utilization', 'cooldown_seconds', 'batch_size', 'batch_max_wait_ms'].includes(k)) {
        sets.push(`${k} = ?`);
        vals.push(v);
      }
    }
    if (sets.length === 0) return existing.id;
    sets.push("updated_at = datetime('now')");
    vals.push(existing.id);
    db.prepare(`UPDATE scaling_policies SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return existing.id;
  }
  const id = `scale-${serviceId}`;
  db.prepare(
    `INSERT INTO scaling_policies (id, service_id, min_replicas, max_replicas, target_cpu_utilization,
      target_memory_utilization, cooldown_seconds, batch_size, batch_max_wait_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, serviceId, policy.min_replicas || 1, policy.max_replicas || 10,
    policy.target_cpu_utilization || 70.0, policy.target_memory_utilization || 80.0,
    policy.cooldown_seconds || 300, policy.batch_size || 8, policy.batch_max_wait_ms || 100);
  return id;
}

function getScalingPolicy(serviceId) {
  return db.prepare('SELECT * FROM scaling_policies WHERE service_id = ?').get(serviceId);
}

// =============================================
// WP4.3 流量规则
// =============================================

function createTrafficRule(serviceId, ruleType, weight, targetRevision, headers) {
  const id = `rule-${serviceId}-${Date.now()}`;
  db.prepare(
    'INSERT INTO traffic_rules (id, service_id, rule_type, weight, target_revision, headers) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, serviceId, ruleType, weight || 100, targetRevision, JSON.stringify(headers || {}));
  return id;
}

function getTrafficRules(serviceId) {
  return db.prepare(
    'SELECT * FROM traffic_rules WHERE service_id = ? AND enabled = 1 ORDER BY created_at'
  ).all(serviceId);
}

function updateTrafficRule(id, fields) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (['weight', 'target_revision', 'enabled', 'headers'].includes(k)) {
      sets.push(`${k} = ?`);
      vals.push(k === 'headers' ? JSON.stringify(v) : v);
    }
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  return db.prepare(`UPDATE traffic_rules SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

// =============================================
// WP4.4 部署流水线
// =============================================

function createPipeline(serviceId, pipelineType, fromRevision, toRevision, steps, startedBy) {
  const id = `pipe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(
    `INSERT INTO deployment_pipelines (id, service_id, pipeline_type, from_revision, to_revision,
      steps, started_by, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(id, serviceId, pipelineType, fromRevision, toRevision, JSON.stringify(steps || []), startedBy);
  return id;
}

function updatePipelineStatus(id, status, errorMessage) {
  const sets = ["status = ?"];
  const vals = [status];
  if (status === 'success' || status === 'failed' || status === 'cancelled') {
    sets.push("completed_at = datetime('now')");
  }
  if (errorMessage) { sets.push('error_message = ?'); vals.push(errorMessage); }
  vals.push(id);
  return db.prepare(`UPDATE deployment_pipelines SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

function getPipelines(serviceId, limit = 20) {
  return db.prepare(
    'SELECT * FROM deployment_pipelines WHERE service_id = ? ORDER BY started_at DESC LIMIT ?'
  ).all(serviceId, limit);
}

// =============================================
// WP4.3 环境管理
// =============================================

function getEnvironments() {
  return db.prepare('SELECT * FROM deployment_environments ORDER BY type, name').all();
}

function getEnvironment(id) {
  return db.prepare('SELECT * FROM deployment_environments WHERE id = ?').get(id);
}

function createEnvironment(name, type, baseUrl, namespace, config) {
  const id = `env-${name.toLowerCase().replace(/\s+/g, '-')}`;
  db.prepare(
    'INSERT OR IGNORE INTO deployment_environments (id, name, type, base_url, namespace, config) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, name, type || 'development', baseUrl || '', namespace || '', JSON.stringify(config || {}));
  return id;
}

// =============================================
// WP4 一键部署流程（组合操作）
// =============================================

function oneClickDeploy(name, envId, modelName, modelVersion, protocol, config, scalingPolicy, createdBy) {
  const txn = db.transaction(() => {
    // 1. 创建服务
    const serviceId = createInferenceService(name, envId, modelName, modelVersion, protocol, config, createdBy);

    // 2. 创建初始版本记录
    createDeploymentRevision(serviceId, 1, modelVersion, protocol || 'http', config, createdBy);

    // 3. 生成 API 凭证
    const credential = createApiCredential(serviceId, 'default', createdBy, null);

    // 4. 设置扩缩容策略（如果提供）
    if (scalingPolicy) {
      createOrUpdateScalingPolicy(serviceId, scalingPolicy);
    }

    // 5. 记录流水线
    const steps = [
      { name: 'create_service', status: 'completed' },
      { name: 'register_revision', status: 'completed' },
      { name: 'generate_credentials', status: 'completed' },
      { name: 'deploy_endpoint', status: 'running' },
    ];
    const pipelineId = createPipeline(serviceId, 'deploy', 0, 1, steps, createdBy);

    // 6. 模拟部署成功，更新服务状态为 running
    const endpointUrl = protocol === 'grpc'
      ? `${name}.${envId}.internal:50051`
      : `https://${name}.${envId}.internal/v1/predict`;
    updateInferenceService(serviceId, {
      status: 'running',
      endpoint_url: endpointUrl,
      target_replica_count: scalingPolicy?.min_replicas || 1,
      replica_count: 1,
    });
    updatePipelineStatus(pipelineId, 'success');

    return { service_id: serviceId, endpoint_url: endpointUrl, credential };
  });
  return txn();
}

module.exports = {
  initModels,

  // WP4.1 推理服务
  createInferenceService, getInferenceService, getInferenceServices,
  updateInferenceService, deleteInferenceService,

  // WP4.1 部署版本
  createDeploymentRevision, getDeploymentRevisions, getLatestRevision,

  // WP4.1 API 凭证
  createApiCredential, getApiCredentials, validateApiKey, revokeApiCredential,

  // WP4.2 扩缩容
  createOrUpdateScalingPolicy, getScalingPolicy,

  // WP4.3 流量规则
  createTrafficRule, getTrafficRules, updateTrafficRule,

  // WP4.4 流水线
  createPipeline, updatePipelineStatus, getPipelines,

  // WP4.3 环境
  getEnvironments, getEnvironment, createEnvironment,

  // WP4 组合操作
  oneClickDeploy,
};
