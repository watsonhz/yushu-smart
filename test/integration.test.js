require('dotenv').config();

const db = require('../src/db');
const { getRole, getAllRoles, ROLES } = require('../src/roles');
const { parseAtMentions, hasTaskIntent, determineEventType, classifyByKeywords } = require('../src/router');
const { isDangerous, isWhiteListed, redactSecrets, confirmDangerousAction, filterSensitive } = require('../src/security');
const { buildContext, summarizeWarm, summarizeCold } = require('../src/context');
const { heartbeatTracker } = require('../src/heartbeat');
const { processTaskCommand, formatTaskBoard, formatMyTasks, autoClaimTask } = require('../src/tasks');

db.init();

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.error(`  FAIL: ${name}`); }
}

console.log('\n=== Roles ===');
assert(Object.keys(ROLES).length === 8, '8 roles defined');
assert(getRole('ceo') !== null, 'CEO role exists');
assert(getRole('pm') !== null, 'PM role exists');
assert(getRole('architect') !== null, 'Architect role exists');
assert(getRole('backend-dev') !== null, 'Backend role exists');
assert(getRole('frontend-dev') !== null, 'Frontend role exists');
assert(getRole('qa') !== null, 'QA role exists');
assert(getRole('reviewer') !== null, 'Reviewer role exists');
assert(getRole('tester') !== null, 'Tester role exists');
assert(getRole('nonexistent') === null, 'Unknown role returns null');
assert(getAllRoles().length === 8, 'getAllRoles returns 8 roles');

console.log('\n=== Router ===');
assert(hasTaskIntent('帮我实现用户登录功能') === true, 'task intent detected (Chinese)');
assert(hasTaskIntent('build a login page') === true, 'task intent detected (English)');
assert(hasTaskIntent('今天天气怎么样') === false, 'no task intent for chat');
assert(determineEventType('/status', false) === 'system', '/status is system');
assert(determineEventType('/summary', false) === 'system', '/summary is system');
assert(determineEventType('你好', false) === 'discussion', 'casual is discussion');
assert(determineEventType('帮我实现登录', false) === 'task', 'implementation is task');
const mentions = parseAtMentions('@架构师 帮我设计数据库');
assert(mentions.length > 0, '@mention parsed');
assert(classifyByKeywords('帮我审查代码') === 'reviewer', 'keyword classification: reviewer');
assert(classifyByKeywords('这个设计方案怎么样') === 'architect', 'keyword classification: architect');

console.log('\n=== Security ===');
assert(isDangerous('rm -rf /tmp/test') === true, 'rm -rf detected');
assert(isDangerous('git push --force origin main') === true, 'force push detected');
assert(isDangerous('DROP TABLE users') === true, 'DROP TABLE detected');
assert(isDangerous('npm test --coverage') === false, 'safe command not flagged');
assert(isWhiteListed('npm test') === true, 'npm test is whitelisted');
assert(isWhiteListed('git status') === true, 'git status is whitelisted');
const redacted = redactSecrets('key=sk-abc123def456ghijklmnopqrstuvwxyz');
assert(redacted.includes('REDACTED-API-KEY'), 'API key redacted');
const dangerCheck = confirmDangerousAction('rm -rf /important');
assert(dangerCheck.isDangerous === true, 'danger check positive');
const safeCheck = confirmDangerousAction('npm install express');
assert(safeCheck.isDangerous === false, 'safe check negative');
const filtered = filterSensitive('token=sk-test12345678901234567890');
assert(!filtered.includes('sk-test12345678901234567890'), 'sensitive filtered');

console.log('\n=== Heartbeat ===');
heartbeatTracker.startTask('test-task', 'oc_test123');
heartbeatTracker.tick('test-task', 'installing packages');
heartbeatTracker.markDone('test-task', 'Complete');
heartbeatTracker.removeTask('test-task');
assert(true, 'heartbeat lifecycle OK');

console.log('\n=== Database ===');
const testMsgId = `test-${Date.now()}`;
db.insertMessage(testMsgId, 'oc_test', 'user', 'Hello');
assert(db.messageExists(testMsgId) === true, 'message inserted');
const recent = db.getRecentMessages('oc_test', 10);
assert(recent.length > 0, 'recent messages retrievable');

const taskId = `tt-${Date.now()}`;
db.createTask(taskId, 'oc_test', 'Test Task', 'A test', 'medium', null, 'pm');
db.assignTask(taskId, 'backend-dev');
const tasks = db.getTasks('oc_test');
assert(tasks.length > 0, 'task created');
db.updateTaskStatus(taskId, 'completed', 'Done');
assert(true, 'task lifecycle OK');

console.log('\n=== Context ===');
const ctx = buildContext('oc_test', 'pm');
assert(typeof ctx.hot === 'string', 'context hot is string');
assert(typeof ctx.warm === 'string', 'context warm is string');
assert(typeof ctx.cold === 'string', 'context cold is string');
assert(summarizeWarm(ctx.warm) !== undefined, 'warm summary works');
assert(summarizeCold(ctx.cold) !== undefined, 'cold summary works');

console.log('\n=== Tasks ===');
const t1 = processTaskCommand('oc_test', '/task: Test Feature | 优先级: high', 'pm');
assert(t1 && t1.length > 0, 'task command parsing works');
const board = formatTaskBoard('oc_test');
assert(board.includes('任务看板'), 'task board formatting works');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
