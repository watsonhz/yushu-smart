/**
 * WP4 交付与部署 — 集成测试
 */
require('dotenv').config();

const db = require('../src/db');
const m4 = require('../src/models-wp4');

db.init();
m4.initModels(db.getDb());

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.error(`  FAIL: ${name}`); }
}

// ═══════════════════════════════════
// 环境管理
// ═══════════════════════════════════

console.log('\n=== WP4.3 — Environments ===');

const envs = m4.getEnvironments();
assert(envs.length >= 3, `default environments created (${envs.length})`);
assert(envs.some(e => e.type === 'development'), 'dev environment exists');
assert(envs.some(e => e.type === 'production'), 'prod environment exists');

const env = m4.getEnvironment('env-dev');
assert(env !== null, 'get specific environment');
assert(env.name === 'development', 'development env name correct');

// ═══════════════════════════════════
// 推理服务 & 一键部署
// ═══════════════════════════════════

console.log('\n=== WP4.1 — Inference Services ===');

const result = m4.oneClickDeploy(
  'test-llm-service',
  'env-dev',
  'claude-sonnet-4',
  '4.6',
  'http',
  { temperature: 0.7, max_tokens: 4096 },
  { min_replicas: 1, max_replicas: 3, target_cpu_utilization: 70 },
  'test-user'
);
assert(result.id !== undefined, 'oneClickDeploy returns service_id');
assert(result.endpoint_url !== undefined, 'oneClickDeploy returns endpoint_url');
assert(result.credential !== undefined, 'oneClickDeploy returns credential');
assert(result.credential.api_key.startsWith('fk-'), 'API key has correct prefix');

const svc = m4.getInferenceService(result.id);
assert(svc !== null, 'service exists in DB');
assert(svc.status === 'running', 'service status is running after deploy');
assert(svc.model_name === 'claude-sonnet-4', 'model name preserved');
assert(svc.protocol === 'http', 'protocol is http');
assert(svc.env_id === 'env-dev', 'environment id preserved');

// ═══════════════════════════════════
// 服务列表 & 筛选
// ═══════════════════════════════════

console.log('\n=== WP4.1 — Service Queries ===');

const allServices = m4.getInferenceServices({});
assert(allServices.length >= 1, 'getInferenceServices returns results');

const devServices = m4.getInferenceServices({ env_id: 'env-dev' });
assert(devServices.length >= 1, 'filter by environment works');

const runningServices = m4.getInferenceServices({ status: 'running' });
assert(runningServices.length >= 1, 'filter by status works');

// ═══════════════════════════════════
// 部署版本管理
// ═══════════════════════════════════

console.log('\n=== WP4.1 — Revisions ===');

const revisions = m4.getDeploymentRevisions(result.id);
assert(revisions.length >= 1, 'initial revision created');
assert(revisions[0].revision === 1, 'revision number is 1');
assert(revisions[0].status === 'active', 'first revision is active');

const latest = m4.getLatestRevision(result.id);
assert(latest !== null, 'getLatestRevision works');
assert(latest.revision === 1, 'latest revision is 1');

// ═══════════════════════════════════
// API 凭证
// ═══════════════════════════════════

console.log('\n=== WP4.1 — API Credentials ===');

const creds = m4.getApiCredentials(result.id);
assert(creds.length >= 1, 'credentials created');
assert(creds[0].api_key === undefined, 'api_key not leaked in list (redacted)');
assert(creds[0].status === 'active', 'credential status is active');

// 验证 API key
const validated = m4.validateApiKey(result.credential.api_key);
assert(validated !== null, 'validateApiKey succeeds for valid key');
assert(validated.service_id === result.id, 'validated key belongs to correct service');

const invalidValidated = m4.validateApiKey('fk-invalid-key');
assert(invalidValidated === null, 'validateApiKey fails for invalid key');

// 吊销
m4.revokeApiCredential(creds[0].id);
const revokedCreds = m4.getApiCredentials(result.id);
assert(revokedCreds[0].status === 'revoked', 'credential revocation works');

// ═══════════════════════════════════
// 扩缩容策略
// ═══════════════════════════════════

console.log('\n=== WP4.2 — Scaling Policies ===');

const policy = m4.getScalingPolicy(result.id);
assert(policy !== null, 'scaling policy created');
assert(policy.min_replicas === 1, 'min_replicas = 1');
assert(policy.max_replicas === 3, 'max_replicas = 3');
assert(policy.target_cpu_utilization === 70.0, 'target_cpu = 70%');

m4.createOrUpdateScalingPolicy(result.id, { max_replicas: 5 });
const updatedPolicy = m4.getScalingPolicy(result.id);
assert(updatedPolicy.max_replicas === 5, 'scaling policy updated');

// ═══════════════════════════════════
// 流量规则
// ═══════════════════════════════════

console.log('\n=== WP4.3 — Traffic Rules ===');

const ruleId = m4.createTrafficRule(result.id, 'canary', 10, 1, { 'X-Canary': 'true' });
assert(ruleId !== null, 'traffic rule created');

const rules = m4.getTrafficRules(result.id);
assert(rules.length >= 1, 'getTrafficRules returns results');
assert(rules[0].rule_type === 'canary', 'rule type is canary');
assert(rules[0].weight === 10, 'canary weight = 10%');

m4.updateTrafficRule(ruleId, { weight: 20 });
const updatedRules = m4.getTrafficRules(result.id);
assert(updatedRules[0].weight === 20, 'traffic rule weight updated');

// ═══════════════════════════════════
// 部署流水线
// ═══════════════════════════════════

console.log('\n=== WP4.4 — Deployment Pipelines ===');

const pipelines = m4.getPipelines(result.id);
assert(pipelines.length >= 1, 'pipeline history created');
assert(pipelines[0].pipeline_type === 'deploy', 'pipeline type deploy');
assert(pipelines[0].status === 'success', 'pipeline status success');

// ═══════════════════════════════════
// 更新 & 删除服务
// ═══════════════════════════════════

console.log('\n=== WP4.1 — Update & Delete ===');

m4.updateInferenceService(result.id, { status: 'stopped', status_reason: 'maintenance' });
const stoppedSvc = m4.getInferenceService(result.id);
assert(stoppedSvc.status === 'stopped', 'service status updated to stopped');

// ═══════════════════════════════════
// 日志协议校验
// ═══════════════════════════════════

console.log('\n=== WP4 — Edge Cases ===');

// gRPC 部署
const grpcResult = m4.oneClickDeploy(
  'grpc-test-service', 'env-staging', 'claude-opus-4', '4.7', 'grpc',
  {}, null, 'test-user'
);
const grpcSvc = m4.getInferenceService(grpcResult.id);
assert(grpcSvc.protocol === 'grpc', 'gRPC service deployed');
assert(grpcResult.endpoint_url.includes(':50051'), 'gRPC endpoint uses port 50051');

// 批量创建
const batchResults = [];
for (let i = 0; i < 3; i++) {
  const r = m4.oneClickDeploy(`batch-svc-${i}`, 'env-prod', 'test-model', '1.0', 'http', {}, null, 'batch-test');
  batchResults.push(r);
}
const prodServices = m4.getInferenceServices({ env_id: 'env-prod' });
assert(prodServices.length >= 3, 'multiple services can be deployed concurrently');

// 空结果
const noServices = m4.getInferenceServices({ status: 'failed' });
assert(Array.isArray(noServices), 'empty result returns array');

// ═══════════════════════════════════

console.log(`\n=== WP4 Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
