/**
 * WP4 交付与部署 — API 路由
 * 覆盖：推理服务、环境、扩缩容、流量管理
 */
const { Router } = require('express');
const m = require('./models-wp4');

const router = Router();

// =============================================
// WP4.3 环境管理
// =============================================

router.get('/environments', (req, res) => {
  try {
    const envs = m.getEnvironments();
    res.json({ items: envs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/environments/:id', (req, res) => {
  try {
    const env = m.getEnvironment(req.params.id);
    if (!env) return res.status(404).json({ error: 'Environment not found' });
    res.json(env);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/environments', (req, res) => {
  try {
    const { name, type, base_url, namespace, config } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = m.createEnvironment(name, type || 'development', base_url, namespace, config);
    res.status(201).json({ id, name, type: type || 'development' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// WP4.1 推理服务
// =============================================

router.post('/services', (req, res) => {
  try {
    const { name, env_id, model_name, model_version, protocol, config, scaling_policy, created_by } = req.body;
    if (!name || !env_id || !model_name) {
      return res.status(400).json({ error: 'name, env_id, model_name required' });
    }

    // 一键部署
    const result = m.oneClickDeploy(name, env_id, model_name, model_version, protocol, config, scaling_policy, created_by);

    res.status(201).json({
      status: 'deployed',
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/services', (req, res) => {
  try {
    const services = m.getInferenceServices({
      env_id: req.query.env_id,
      status: req.query.status,
      model_name: req.query.model_name,
      limit: parseInt(req.query.limit) || 100,
    });
    res.json({ items: services, total: services.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/services/:id', (req, res) => {
  try {
    const service = m.getInferenceService(req.params.id);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    res.json(service);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/services/:id', (req, res) => {
  try {
    const service = m.getInferenceService(req.params.id);
    if (!service) return res.status(404).json({ error: 'Service not found' });

    const { status, config, health_check_path, target_replica_count } = req.body;
    m.updateInferenceService(req.params.id, { status, config, health_check_path, target_replica_count });

    res.json({ status: 'updated', id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/services/:id', (req, res) => {
  try {
    const service = m.getInferenceService(req.params.id);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    m.deleteInferenceService(req.params.id);
    res.json({ status: 'deleted', id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// WP4.1 部署版本 / 回滚
// =============================================

router.get('/services/:id/revisions', (req, res) => {
  try {
    const service = m.getInferenceService(req.params.id);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    const revisions = m.getDeploymentRevisions(req.params.id);
    res.json({ items: revisions, total: revisions.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/services/:id/rollback', (req, res) => {
  try {
    const service = m.getInferenceService(req.params.id);
    if (!service) return res.status(404).json({ error: 'Service not found' });

    const { revision } = req.body;
    if (!revision) return res.status(400).json({ error: 'revision is required' });

    const revisions = m.getDeploymentRevisions(req.params.id);
    const targetRev = revisions.find(r => r.revision === revision);
    if (!targetRev) return res.status(404).json({ error: `Revision ${revision} not found` });

    // 创建新修订作为回滚版本
    const latestRev = revisions.length > 0 ? revisions[0].revision : 0;
    const config = JSON.parse(targetRev.config || '{}');

    // 标记服务为 rolling_back
    m.updateInferenceService(req.params.id, { status: 'rolling_back' });

    // 记录流水线
    const steps = [
      { name: 'validate_revision', status: 'completed' },
      { name: 'rollback_deploy', status: 'running' },
    ];
    const pipelineId = m.createPipeline(req.params.id, 'rollback',
      latestRev, targetRev.revision, steps, req.body.started_by || 'system');

    // 创建新版本并回退配置
    const newRevision = latestRev + 1;
    m.createDeploymentRevision(req.params.id, newRevision,
      targetRev.model_version, targetRev.protocol, targetRev.config, req.body.started_by || 'system');

    // 更新服务配置
    m.updateInferenceService(req.params.id, {
      status: 'running',
      model_version: targetRev.model_version,
      protocol: targetRev.protocol,
      config: config,
      endpoint_url: targetRev.protocol === 'grpc'
        ? `${service.name}.${service.env_id}.internal:50051`
        : `https://${service.name}.${service.env_id}.internal/v1/predict`,
    });

    m.updatePipelineStatus(pipelineId, 'success');

    res.json({
      status: 'rolled_back',
      from_revision: latestRev,
      to_revision: newRevision,
      target_model_version: targetRev.model_version,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// WP4.1 API 凭证
// =============================================

router.post('/services/:id/credentials', (req, res) => {
  try {
    const service = m.getInferenceService(req.params.id);
    if (!service) return res.status(404).json({ error: 'Service not found' });

    const { name, created_by, expires_in_days } = req.body;
    const credential = m.createApiCredential(req.params.id, name, created_by, expires_in_days);

    res.status(201).json(credential);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/services/:id/credentials', (req, res) => {
  try {
    const service = m.getInferenceService(req.params.id);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    const credentials = m.getApiCredentials(req.params.id);
    res.json({ items: credentials });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/credentials/:id/revoke', (req, res) => {
  try {
    m.revokeApiCredential(req.params.id);
    res.json({ status: 'revoked', id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// WP4.2 扩缩容策略
// =============================================

router.post('/services/:id/scaling', (req, res) => {
  try {
    const service = m.getInferenceService(req.params.id);
    if (!service) return res.status(404).json({ error: 'Service not found' });

    const policyId = m.createOrUpdateScalingPolicy(req.params.id, req.body);

    res.status(201).json({ status: 'configured', id: policyId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/services/:id/scaling', (req, res) => {
  try {
    const service = m.getInferenceService(req.params.id);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    const policy = m.getScalingPolicy(req.params.id);
    if (!policy) return res.status(404).json({ error: 'No scaling policy configured' });
    res.json(policy);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// WP4.3 流量规则
// =============================================

router.post('/services/:id/traffic-rules', (req, res) => {
  try {
    const service = m.getInferenceService(req.params.id);
    if (!service) return res.status(404).json({ error: 'Service not found' });

    const { rule_type, weight, target_revision, headers } = req.body;
    if (!rule_type) return res.status(400).json({ error: 'rule_type required (canary/blue_green/mirror/weighted)' });

    const id = m.createTrafficRule(req.params.id, rule_type, weight, target_revision, headers);

    res.status(201).json({ status: 'created', id, rule_type });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/services/:id/traffic-rules', (req, res) => {
  try {
    const service = m.getInferenceService(req.params.id);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    const rules = m.getTrafficRules(req.params.id);
    res.json({ items: rules });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/traffic-rules/:id', (req, res) => {
  try {
    m.updateTrafficRule(req.params.id, req.body);
    res.json({ status: 'updated', id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// WP4.4 部署流水线
// =============================================

router.get('/services/:id/pipelines', (req, res) => {
  try {
    const service = m.getInferenceService(req.params.id);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    const pipelines = m.getPipelines(req.params.id, parseInt(req.query.limit) || 20);
    res.json({ items: pipelines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// API 密钥验证端点
// =============================================

router.post('/internal/validate-key', (req, res) => {
  try {
    const { api_key, api_secret } = req.body;
    if (!api_key) return res.status(400).json({ error: 'api_key required' });

    const cred = m.validateApiKey(api_key);
    if (!cred) return res.status(401).json({ valid: false, error: 'Invalid or expired API key' });

    if (api_secret && cred.api_secret !== api_secret) {
      return res.status(401).json({ valid: false, error: 'Invalid API secret' });
    }

    res.json({
      valid: true,
      service_id: cred.service_id,
      credential_name: cred.name,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
