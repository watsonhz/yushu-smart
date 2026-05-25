# Feishu Multi-Agent Team — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Express server that receives Feishu group messages, routes them to 8 AI roles (CEO, PM, Architect, Backend, Frontend, QA, Reviewer, Tester) backed by Claude Code CLI processes with lazy-start, file persistence, and autonomous task execution.

**Architecture:** Express server receives Feishu webhooks → Message Router deduplicates and classifies messages → Process Manager spawns role-specific Claude Code subprocesses on demand → All state persisted via SQLite (WAL mode). Eight safeguards: heartbeat protocol, file write locks, health monitor, danger confirmation gate, secret redaction, deadlock prevention, message dedup, crash recovery.

**Tech Stack:** Node.js (CommonJS), Express, better-sqlite3, axios, Claude Code CLI (DeepSeek v4 pro via Anthropic-compatible endpoint)

---

### Task 1: Project Setup & Dependencies

**Files:**
- Modify: `package.json`
- Create: `src/` directory structure
- Create: `.data/`, `.data/backups/`, `quality-reports/`

- [ ] **Step 1: Add better-sqlite3 dependency**

```bash
cd /Users/hziotdev/Desktop/feishu-claude-bot && npm install better-sqlite3
```

- [ ] **Step 2: Create directory structure**

```bash
mkdir -p src .data/backups quality-reports
```

- [ ] **Step 3: Update package.json scripts**

Read [package.json](package.json) and update the `scripts` field to:

```json
"scripts": {
  "start": "node index.js",
  "dev": "node --watch index.js"
}
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add better-sqlite3 and project directory structure"
```

---

### Task 2: Database Layer

**Files:**
- Create: `src/db.js`

This module provides the SQLite connection and all CRUD operations for messages, tasks, sessions, and locks tables. WAL mode for crash safety. Daily backup on startup. Integrity check on startup.

- [ ] **Step 1: Write db.js with schema initialization**

Create [src/db.js](src/db.js):

```javascript
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', '.data', 'bot.db');
const BACKUP_DIR = path.join(__dirname, '..', '.data', 'backups');

let db;

function init() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_use TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      assignee TEXT,
      depends_on TEXT,
      retry_count INTEGER DEFAULT 0,
      result TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      done_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      claude_session_id TEXT,
      pid INTEGER,
      status TEXT NOT NULL DEFAULT 'inactive',
      last_active_at TEXT NOT NULL DEFAULT (datetime('now')),
      context_summary TEXT
    );

    CREATE TABLE IF NOT EXISTS locks (
      file_path TEXT PRIMARY KEY,
      holder TEXT NOT NULL,
      acquired_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_role ON messages(chat_id, role);
    CREATE INDEX IF NOT EXISTS idx_tasks_chat ON tasks(chat_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_chat ON sessions(chat_id);
  `);

  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call init() first.');
  return db;
}

// ---- Messages ----

function insertMessage(id, chatId, role, content, toolUse) {
  const stmt = getDb().prepare(
    'INSERT OR IGNORE INTO messages (id, chat_id, role, content, tool_use) VALUES (?, ?, ?, ?, ?)'
  );
  return stmt.run(id, chatId, role, content, toolUse || null);
}

function messageExists(id) {
  return getDb().prepare('SELECT 1 FROM messages WHERE id = ?').get(id) !== undefined;
}

function getRecentMessages(chatId, role, limit = 20) {
  return getDb().prepare(
    'SELECT * FROM messages WHERE chat_id = ? AND role = ? ORDER BY created_at DESC LIMIT ?'
  ).all(chatId, role, limit).reverse();
}

function getMessagesOlderThan(chatId, role, olderThanRows, limit = 10) {
  return getDb().prepare(
    `SELECT * FROM messages WHERE chat_id = ? AND role = ?
     AND created_at < (SELECT created_at FROM messages WHERE chat_id = ? AND role = ? ORDER BY created_at ASC LIMIT 1 OFFSET ?)
     ORDER BY created_at DESC LIMIT ?`
  ).all(chatId, role, chatId, role, olderThanRows - 1, limit);
}

// ---- Tasks ----

function createTask(id, chatId, title, dependsOn) {
  const stmt = getDb().prepare(
    'INSERT INTO tasks (id, chat_id, title, depends_on) VALUES (?, ?, ?, ?)'
  );
  return stmt.run(id, chatId, title, dependsOn || null);
}

function createTasksBatch(taskRecords) {
  const insert = getDb().prepare(
    'INSERT INTO tasks (id, chat_id, title, depends_on) VALUES (?, ?, ?, ?)'
  );
  const txn = getDb().transaction((records) => {
    for (const t of records) {
      insert.run(t.id, t.chatId, t.title, t.dependsOn || null);
    }
  });
  txn(taskRecords);
}

function getTask(taskId) {
  return getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
}

function getPendingTasks(chatId) {
  return getDb().prepare(
    "SELECT * FROM tasks WHERE chat_id = ? AND status IN ('pending', 'in_progress') ORDER BY created_at ASC"
  ).all(chatId);
}

function updateTaskStatus(taskId, status, result) {
  const fields = { status };
  if (result !== undefined) fields.result = result;
  if (status === 'done') fields.done_at = new Date().toISOString();
  const setClauses = Object.entries(fields).map(([k]) => `${k} = ?`).join(', ');
  const values = Object.values(fields);
  values.push(taskId);
  return getDb().prepare(`UPDATE tasks SET ${setClauses} WHERE id = ?`).run(...values);
}

function incrementTaskRetry(taskId) {
  return getDb().prepare(
    'UPDATE tasks SET retry_count = retry_count + 1 WHERE id = ?'
  ).run(taskId);
}

function getTaskRetryCount(taskId) {
  const row = getDb().prepare('SELECT retry_count FROM tasks WHERE id = ?').get(taskId);
  return row ? row.retry_count : 0;
}

function checkCircularDependency(taskId, dependsOnId) {
  const visited = new Set();
  function walk(currentId) {
    if (currentId === taskId) return true;
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    const task = getDb().prepare('SELECT depends_on FROM tasks WHERE id = ?').get(currentId);
    if (!task || !task.depends_on) return false;
    for (const depId of task.depends_on.split(',').map(s => s.trim()).filter(Boolean)) {
      if (walk(depId)) return true;
    }
    return false;
  }
  return walk(dependsOnId);
}

// ---- Sessions ----

function upsertSession(sessionId, chatId, role, claudeSessionId, pid, status) {
  return getDb().prepare(
    `INSERT INTO sessions (id, chat_id, role, claude_session_id, pid, status, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET pid = ?, status = ?, last_active_at = datetime('now')`
  ).run(sessionId, chatId, role, claudeSessionId || null, pid || null, status, pid || null, status);
}

function getActiveSessions(chatId) {
  return getDb().prepare(
    "SELECT * FROM sessions WHERE chat_id = ? AND status = 'active'"
  ).all(chatId);
}

function getSession(sessionId) {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
}

function updateSessionStatus(sessionId, status, contextSummary) {
  const fields = { status, last_active_at: new Date().toISOString() };
  if (contextSummary !== undefined) fields.context_summary = contextSummary;
  const setClauses = Object.entries(fields).map(([k]) => `${k} = ?`).join(', ');
  const values = Object.values(fields);
  values.push(sessionId);
  return getDb().prepare(`UPDATE sessions SET ${setClauses} WHERE id = ?`).run(...values);
}

function idleSessions(chatId, idleMinutes = 10) {
  return getDb().prepare(
    `SELECT * FROM sessions WHERE chat_id = ? AND status = 'active'
     AND last_active_at < datetime('now', ?)`
  ).all(chatId, `-${idleMinutes} minutes`);
}

// ---- Locks ----

function acquireFileLock(filePath, holder) {
  try {
    return getDb().prepare(
      'INSERT INTO locks (file_path, holder) VALUES (?, ?)'
    ).run(filePath, holder);
  } catch {
    return null; // lock already held
  }
}

function releaseFileLock(filePath, holder) {
  return getDb().prepare(
    'DELETE FROM locks WHERE file_path = ? AND holder = ?'
  ).run(filePath, holder);
}

function releaseAllLocksForHolder(holder) {
  return getDb().prepare('DELETE FROM locks WHERE holder = ?').run(holder);
}

function getExpiredLocks(timeoutSeconds = 30) {
  return getDb().prepare(
    `SELECT * FROM locks WHERE acquired_at < datetime('now', ?)`
  ).all(`-${timeoutSeconds} seconds`);
}

// ---- Backup ----

function dailyBackup() {
  const today = new Date().toISOString().split('T')[0];
  const backupPath = path.join(BACKUP_DIR, `bot-${today}.db`);
  if (!fs.existsSync(backupPath)) {
    getDb().backup(backupPath);
  }
}

function integrityCheck() {
  const result = getDb().pragma('integrity_check');
  if (result[0].integrity_check !== 'ok') {
    console.error('Database integrity check FAILED');
    return false;
  }
  return true;
}

module.exports = {
  init, getDb,
  insertMessage, messageExists, getRecentMessages, getMessagesOlderThan,
  createTask, createTasksBatch, getTask, getPendingTasks, updateTaskStatus,
  incrementTaskRetry, getTaskRetryCount, checkCircularDependency,
  upsertSession, getActiveSessions, getSession, updateSessionStatus, idleSessions,
  acquireFileLock, releaseFileLock, releaseAllLocksForHolder, getExpiredLocks,
  dailyBackup, integrityCheck,
};
```

- [ ] **Step 2: Verify module loads**

```bash
cd /Users/hziotdev/Desktop/feishu-claude-bot && node -e "const db = require('./src/db'); db.init(); console.log('DB OK'); console.log('Integrity:', db.integrityCheck());"
```

Expected: `DB OK` and `Integrity: true`

- [ ] **Step 3: Verify schema tables exist**

```bash
cd /Users/hziotdev/Desktop/feishu-claude-bot && node -e "
const db = require('./src/db');
db.init();
const tables = db.getDb().prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all();
console.log('Tables:', tables.map(t=>t.name).join(', '));
"
```

Expected: `Tables: messages, tasks, sessions, locks`

- [ ] **Step 4: Commit**

```bash
git add src/db.js
git commit -m "feat: add SQLite database layer with WAL mode and all tables"
```

---

### Task 3: Role Definitions

**Files:**
- Create: `src/roles.js`

8 role system prompts with Chinese names, skill domains, and responsibilities. Each prompt instructs the role about its scope and collaboration rules.

- [ ] **Step 1: Write roles.js**

Create [src/roles.js](src/roles.js):

```javascript
const ROLE_DEFINITIONS = {
  ceo: {
    name: 'CEO',
    displayName: 'CEO',
    domain: '战略决策、任务分派、最终审批、团队协调、打破僵局',
    systemPrompt: `你是CEO，团队的最高决策者。
职责：
- 当团队陷入僵局或任务被测试工程师打回2次时，由你重新评估并做出最终决策
- 可以给任何角色分派任务
- 审批危险操作的执行
- 确保团队整体目标和质量达成

规则：
- 只在你需要做出决策时发言，不要代替其他角色做他们的具体工作
- 如果团队运转正常，保持沉默
- 使用中文回复，简洁直接`,
  },

  pm: {
    name: 'PM',
    displayName: '项目经理',
    domain: '需求分析、任务拆解、排期、进度跟踪、风险识别',
    systemPrompt: `你是项目经理（PM），负责需求拆解和进度管理。
职责：
- 收到用户的开发需求后，将其拆解为具体的子任务
- 每个子任务明确负责人（指定角色）、依赖关系
- 跟踪任务板上各任务的进展
- 识别风险并汇报

规则：
- 拆解任务时用格式：{"action":"create_tasks","tasks":[{"title":"...","assignee":"角色key","depends_on":"task-id或null"}]}
- 当所有子任务完成后，在群里做简短总结
- 使用中文回复`,
  },

  architect: {
    name: 'Architect',
    displayName: '架构师',
    domain: '系统设计、技术选型、架构方案、方案评审',
    systemPrompt: `你是架构师，负责系统设计和技术选型。
职责：
- 阅读和理解现有项目代码结构
- 对新需求给出架构方案
- 设计数据库表结构、API接口、模块划分
- 评审技术方案的可行性

能力：
- 你可以读取项目文件来了解现有架构
- 你可以提出技术建议但不能代替后端/前端工程师写具体实现

规则：
- 方案中注明技术选型的理由
- 给后端/前端工程师可执行的明确接口定义
- 使用中文回复`,
  },

  backend: {
    name: 'Backend Engineer',
    displayName: '后端工程师',
    domain: '后端代码、API开发、数据库操作、服务端逻辑',
    systemPrompt: `你是后端开发工程师，负责实现后端代码。
职责：
- 根据架构师的方案实现API接口
- 数据库操作、数据模型实现
- 编写代码并运行测试
- 完成任务后更新任务板

能力：
- 你可以创建、修改项目文件
- 你可以执行命令（npm、node、git等）
- 完成代码后自测通过再标记完成

规则：
- 遵循项目现有代码风格
- 每个操作前检查文件锁，避免与其他角色冲突
- 完成后在群里汇报完成情况
- 使用中文回复`,
  },

  frontend: {
    name: 'Frontend Engineer',
    displayName: '前端工程师',
    domain: '前端代码、UI实现、页面开发、组件开发',
    systemPrompt: `你是前端开发工程师，负责实现前端界面。
职责：
- 根据架构师的方案和UI设计实现前端页面
- 编写组件、样式、交互逻辑
- 完成代码后自测通过再标记完成

能力：
- 你可以创建、修改项目文件
- 你可以执行命令（npm、node等）
- 完成后在群里汇报完成情况

规则：
- 遵循项目现有代码风格和组件规范
- 每个操作前检查文件锁，避免与其他角色冲突
- 完成后在群里汇报完成情况
- 使用中文回复`,
  },

  qa: {
    name: 'QA Engineer',
    displayName: 'QA工程师',
    domain: '测试策略、测试用例设计、质量评审',
    systemPrompt: `你是QA工程师，负责测试策略和质量评审。
职责：
- 审核架构方案和代码，给出测试建议
- 设计测试用例（但不执行测试）
- 评估任务完成质量

规则：
- 你负责"怎么测"，测试工程师负责"实际测"
- 当角色完成产出后，评估是否覆盖了边界情况
- 使用中文回复`,
  },

  reviewer: {
    name: 'Reviewer',
    displayName: '代码审查员',
    domain: '代码审查、安全扫描、代码质量门禁',
    systemPrompt: `你是代码审查员，负责代码质量把关。
职责：
- 审查其他角色完成的代码
- 检查安全漏洞、代码规范、潜在bug
- 扫描依赖安全问题

能力：
- 你可以读取项目文件来审查代码
- 你可以运行安全扫描工具

规则：
- 只审查代码，不修改代码
- 发现问题时明确指出文件、行号和问题描述
- 审查通过后通知测试工程师执行测试
- 使用中文回复`,
  },

  tester: {
    name: 'Tester',
    displayName: '测试工程师',
    domain: '测试执行、质量登记、报告存档',
    systemPrompt: `你是测试工程师，负责执行测试和质量登记。
职责：
- 当审查员通过后，执行实际测试
- 运行测试用例、验证功能
- 将测试结果和质量报告写入 quality-reports/YYYY-MM-DD/ 目录
- 在群里汇报测试结果

规则：
- 测试不通过时明确列出问题，打回对应角色修复
- 同一任务打回2次后升级给CEO
- 质量报告格式：包含任务名、测试项、结果（通过/失败）、问题描述、测试时间
- 使用中文回复`,
  },
};

const ROLE_KEYS = Object.keys(ROLE_DEFINITIONS);

function getRole(roleKey) {
  return ROLE_DEFINITIONS[roleKey] || null;
}

function getAllRoles() {
  return ROLE_KEYS.map(k => ({ key: k, ...ROLE_DEFINITIONS[k] }));
}

function resolveRoleByName(name) {
  const lower = (name || '').toLowerCase().trim();
  for (const [key, def] of Object.entries(ROLE_DEFINITIONS)) {
    if (key === lower) return key;
    if (def.name.toLowerCase().includes(lower)) return key;
    if (def.displayName.includes(name.trim())) return key;
  }
  return null;
}

module.exports = { getRole, getAllRoles, resolveRoleByName, ROLE_KEYS };
```

- [ ] **Step 2: Verify module loads and role resolution works**

```bash
cd /Users/hziotdev/Desktop/feishu-claude-bot && node -e "
const r = require('./src/roles');
console.log('Roles:', r.ROLE_KEYS.join(', '));
console.log('Resolve CEO:', r.resolveRoleByName('CEO'));
console.log('Resolve architect:', r.resolveRoleByName('架构师'));
console.log('Resolve unknown:', r.resolveRoleByName('unknown'));
"
```

Expected: 8 role keys, `CEO` → `ceo`, `架构师` → `architect`, `unknown` → `null`

- [ ] **Step 3: Commit**

```bash
git add src/roles.js
git commit -m "feat: add 8 role definitions with Chinese system prompts"
```

---

### Task 4: Feishu API Helpers

**Files:**
- Create: `src/feishu.js`
- Modify: `.env` (read credentials)

Extract the existing Feishu token and message-sending logic from `index.js` into a dedicated module. Add card message support for danger confirmation gates.

- [ ] **Step 1: Write feishu.js**

Create [src/feishu.js](src/feishu.js):

```javascript
const axios = require('axios');

const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;

let tenantAccessToken = null;
let tokenExpireTime = 0;

async function getAccessToken() {
  if (tenantAccessToken && Date.now() < tokenExpireTime) {
    return tenantAccessToken;
  }
  const res = await axios.post(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: APP_ID, app_secret: APP_SECRET },
    { headers: { 'Content-Type': 'application/json' } }
  );
  tenantAccessToken = res.data.tenant_access_token;
  tokenExpireTime = Date.now() + (res.data.expire - 300) * 1000;
  return tenantAccessToken;
}

async function sendTextMessage(chatId, text) {
  const token = await getAccessToken();
  const content = JSON.stringify({ text: text.substring(0, 5000) });
  await axios.post(
    'https://open.feishu.cn/open-apis/im/v1/messages',
    { receive_id: chatId, msg_type: 'text', content },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
}

async function sendCardMessage(chatId, header, bodyElements) {
  const token = await getAccessToken();
  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: header }, template: 'blue' },
    elements: bodyElements,
  };
  const content = JSON.stringify(card);
  try {
    await axios.post(
      'https://open.feishu.cn/open-apis/im/v1/messages',
      { receive_id: chatId, msg_type: 'interactive', content },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch {
    await sendTextMessage(chatId, `[${header}]\n${bodyElements.map(e => e.content || '').join('\n')}`);
  }
}

async function sendDangerConfirmationCard(chatId, roleName, command) {
  const cardElements = [
    { tag: 'markdown', content: `⚠️ **${roleName}** 想执行以下操作：\n\`\`\`\n${command}\n\`\`\`\n请确认是否允许执行。` },
    { tag: 'hr' },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '✅ 确认执行' },
          type: 'primary',
          value: JSON.stringify({ action: 'danger_confirm', command }),
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '❌ 拒绝' },
          type: 'danger',
          value: JSON.stringify({ action: 'danger_reject', command }),
        },
      ],
    },
  ];
  await sendCardMessage(chatId, '危险操作确认', cardElements);
}

module.exports = { getAccessToken, sendTextMessage, sendCardMessage, sendDangerConfirmationCard };
```

- [ ] **Step 2: Verify module loads (note: needs .env loaded)**

```bash
cd /Users/hziotdev/Desktop/feishu-claude-bot && node -e "require('dotenv').config(); const f = require('./src/feishu'); console.log('Feishu module OK');"
```

Expected: `Feishu module OK`

- [ ] **Step 3: Commit**

```bash
git add src/feishu.js
git commit -m "feat: add Feishu API helpers with card message and danger confirmation support"
```

---

### Task 5: Context Management

**Files:**
- Create: `src/context.js`

Hot/warm/cold tier management. Every 10 turns generates a non-cumulative summary snapshot. Context budget hard cap at 50K tokens per role.

- [ ] **Step 1: Write context.js**

Create [src/context.js](src/context.js):

```javascript
const db = require('./db');

const HOT_LIMIT = 20;
const WARM_LIMIT = 50;
const SUMMARY_INTERVAL = 10;
const TOKEN_CAP = 50000;

function estimateTokens(text) {
  // rough: ~2 chars per token for Chinese, ~4 for English
  return Math.ceil(text.length / 2);
}

function buildContextForRole(chatId, role) {
  const messages = db.getRecentMessages(chatId, role, WARM_LIMIT);
  if (messages.length === 0) return '';

  const hotMessages = messages.slice(-HOT_LIMIT);
  const warmMessages = messages.slice(0, -HOT_LIMIT);

  const parts = [];

  if (warmMessages.length > 0) {
    const warmSummary = warmMessages.map(m => {
      const preview = m.content.substring(0, 200);
      return `[${m.created_at}] ${m.role === 'user' ? '用户' : m.role}: ${preview}`;
    }).join('\n');
    parts.push(`## 历史上下文摘要\n${warmSummary}`);
  }

  parts.push('## 最近对话');
  for (const m of hotMessages) {
    const speaker = m.role === 'user' ? '用户' : m.role;
    parts.push(`[${speaker}]: ${m.content}`);
  }

  let context = parts.join('\n\n');
  while (estimateTokens(context) > TOKEN_CAP) {
    // trim oldest first
    const lines = context.split('\n');
    context = lines.slice(Math.ceil(lines.length * 0.8)).join('\n');
  }

  return context;
}

function getLastSummary(chatId, role) {
  const session = db.getSession(`${chatId}-${role}`);
  return session ? session.context_summary : null;
}

function shouldGenerateSummary(chatId, role) {
  const count = db.getDb().prepare(
    'SELECT COUNT(*) as cnt FROM messages WHERE chat_id = ? AND role = ?'
  ).get(chatId, role);
  return (count.cnt % SUMMARY_INTERVAL === 0) && count.cnt > 0;
}

async function generateSummary(chatId, role, lastMessages) {
  const lines = lastMessages.map(m => {
    const speaker = m.role === 'user' ? '用户' : m.role;
    const preview = m.content.substring(0, 300);
    return `${speaker}: ${preview}`;
  }).join('\n');

  return `[${new Date().toISOString()}] 关键摘要:\n${lines}`;
}

module.exports = { buildContextForRole, getLastSummary, shouldGenerateSummary, generateSummary, estimateTokens, TOKEN_CAP };
```

- [ ] **Step 2: Verify module loads**

```bash
cd /Users/hziotdev/Desktop/feishu-claude-bot && node -e "require('dotenv').config(); const ctx = require('./src/context'); console.log('Context module OK, token cap:', ctx.TOKEN_CAP);"
```

- [ ] **Step 3: Commit**

```bash
git add src/context.js
git commit -m "feat: add hot/warm/cold context management with token budget"
```

---

### Task 6: Task Board

**Files:**
- Create: `src/task-board.js`

Task lifecycle management: creation, dependency resolution, auto-claim matching, escalation to CEO on 2nd retry. Circular dependency detection. Emits events for the process manager.

- [ ] **Step 1: Write task-board.js**

Create [src/task-board.js](src/task-board.js):

```javascript
const db = require('./db');
const { ROLE_KEYS } = require('./roles');
const { EventEmitter } = require('events');

const taskBus = new EventEmitter();
taskBus.setMaxListeners(50);

const ROLE_SKILL_MAP = {
  ceo: ['决策', '审批', '分派', '协调'],
  pm: ['需求', '拆解', '排期', '项目管理', '计划'],
  architect: ['架构', '设计', '技术选型', '方案', '数据库设计', 'API设计', '系统设计'],
  backend: ['后端', 'API', '数据库', '服务端', '接口', 'server', 'backend', 'api'],
  frontend: ['前端', 'UI', '页面', '组件', '样式', 'frontend', 'react', 'vue', 'component'],
  qa: ['测试策略', '测试用例', '质量', '边界'],
  reviewer: ['审查', '代码检查', '扫描', '安全', 'review', 'lint'],
  tester: ['测试执行', '验证', '质量报告', '测试报告'],
};

function matchRoleForTask(title) {
  const lower = title.toLowerCase();
  let bestRole = null;
  let bestScore = 0;
  for (const [role, keywords] of Object.entries(ROLE_SKILL_MAP)) {
    const score = keywords.filter(k => lower.includes(k.toLowerCase())).length;
    if (score > bestScore) { bestScore = score; bestRole = role; }
  }
  return bestScore > 0 ? bestRole : 'pm'; // default to PM if unclear
}

function createTask(id, chatId, title, dependsOn) {
  if (dependsOn && db.checkCircularDependency(id, dependsOn)) {
    throw new Error('Circular dependency detected');
  }
  return db.createTask(id, chatId, title, dependsOn || null);
}

function createTasksFromPM(chatId, taskRecords) {
  const rows = taskRecords.map(t => ({
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chatId,
    title: t.title,
    assignee: t.assignee || matchRoleForTask(t.title),
    dependsOn: t.depends_on || null,
  }));
  db.createTasksBatch(rows.map(r => ({
    id: r.id, chatId, title: r.title, dependsOn: r.dependsOn,
  })));
  for (const r of rows) {
    taskBus.emit('task:created', r);
  }
  return rows;
}

function claimTasks(chatId, role) {
  const pending = db.getPendingTasks(chatId);
  const claimable = pending.filter(t => {
    if (t.assignee && t.assignee !== role) return false;
    if (t.status === 'in_progress' && t.assignee !== role) return false;
    // Check dependencies: all deps must be done
    if (t.depends_on) {
      const depIds = t.depends_on.split(',').map(s => s.trim()).filter(Boolean);
      for (const depId of depIds) {
        const dep = db.getTask(depId);
        if (!dep || dep.status !== 'done') return false;
      }
    }
    return true;
  });
  for (const t of claimable) {
    db.updateTaskStatus(t.id, 'in_progress');
    db.getDb().prepare('UPDATE tasks SET assignee = ? WHERE id = ?').run(role, t.id);
    taskBus.emit('task:claimed', { taskId: t.id, role });
  }
  return claimable;
}

function completeTask(taskId, role, result) {
  db.updateTaskStatus(taskId, 'done', result || null);
  taskBus.emit('task:done', { taskId, role, result });
}

function escalateToCeo(taskId, chatId, reason) {
  console.log(`Task ${taskId} escalated to CEO: ${reason}`);
  taskBus.emit('task:escalated', { taskId, chatId, reason });
}

function handleTesterRejection(taskId, chatId) {
  db.incrementTaskRetry(taskId);
  const count = db.getTaskRetryCount(taskId);
  if (count >= 2) {
    escalateToCeo(taskId, chatId, `Task rejected ${count} times by tester`);
  } else {
    db.updateTaskStatus(taskId, 'pending'); // back to pool
    taskBus.emit('task:rejected', { taskId, retryCount: count });
  }
}

module.exports = {
  taskBus, matchRoleForTask, createTask, createTasksFromPM,
  claimTasks, completeTask, escalateToCeo, handleTesterRejection,
};
```

- [ ] **Step 2: Verify module loads**

```bash
cd /Users/hziotdev/Desktop/feishu-claude-bot && node -e "require('dotenv').config(); require('./src/db').init(); const tb = require('./src/task-board'); console.log('Task board OK');"
```

- [ ] **Step 3: Commit**

```bash
git add src/task-board.js
git commit -m "feat: add task board with lifecycle, auto-claim, and escalation"
```

---

### Task 7: Safeguards Module

**Files:**
- Create: `src/safeguards.js`

Three safeguards in one module: danger command detection with default-deny, secret redaction, and file write locks.

- [ ] **Step 1: Write safeguards.js**

Create [src/safeguards.js](src/safeguards.js):

```javascript
const db = require('./db');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');

const DANGER_PATTERNS = [
  /\brm\s+-rf\b/,
  /\bgit\s+push\s+--force\b/,
  /\bDROP\s+TABLE\b/i,
  /\bchmod\s+.*777\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bDD\s+if=/i,
  /\bmkfs\./i,
  /\b>\/dev\/sd/,
  /\bformat\s+C:/i,
  /\bdel\s+\/F\b/i,
];

const SECRET_PATTERNS = [
  { pattern: /sk-[a-zA-Z0-9]{20,}/g, replacement: '[REDACTED-API-KEY]' },
  { pattern: /APP_SECRET\s*=\s*["']?[^"'\n]{8,}["']?/gi, replacement: 'APP_SECRET=[REDACTED]' },
  { pattern: /ANTHROPIC_API_KEY\s*=\s*["']?[^"'\n]{8,}["']?/gi, replacement: 'ANTHROPIC_API_KEY=[REDACTED]' },
  { pattern: /Bearer\s+[a-zA-Z0-9\-_.]{20,}/gi, replacement: 'Bearer [REDACTED]' },
];

const SAFE_COMMANDS = [
  'npm test', 'npm run', 'npm install', 'node -e', 'node --version',
  'git status', 'git diff', 'git log', 'git add', 'git commit', 'git branch',
  'ls', 'cat', 'echo', 'pwd', 'which', 'mkdir', 'touch', 'cp', 'mv',
];

function isDangerous(command) {
  for (const pattern of DANGER_PATTERNS) {
    if (pattern.test(command)) return true;
  }
  return false;
}

function isWhiteListed(command) {
  return SAFE_COMMANDS.some(safe => command.trim().startsWith(safe));
}

function redactSecrets(text) {
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function isInProjectDir(filePath) {
  const resolved = path.resolve(filePath);
  return resolved.startsWith(PROJECT_ROOT);
}

function acquireLock(filePath, holder) {
  const absPath = path.resolve(filePath);
  if (!isInProjectDir(absPath)) return false;
  return db.acquireFileLock(absPath, holder) !== null;
}

function releaseLock(filePath, holder) {
  const absPath = path.resolve(filePath);
  db.releaseFileLock(absPath, holder);
}

function releaseAllLocks(holder) {
  db.releaseAllLocksForHolder(holder);
}

function cleanupExpiredLocks(timeoutSeconds = 30) {
  const expired = db.getExpiredLocks(timeoutSeconds);
  for (const lock of expired) {
    db.releaseFileLock(lock.file_path, lock.holder);
    console.log(`Released expired lock: ${lock.file_path} (held by ${lock.holder})`);
  }
  return expired;
}

module.exports = {
  isDangerous, isWhiteListed, redactSecrets, isInProjectDir,
  acquireLock, releaseLock, releaseAllLocks, cleanupExpiredLocks,
};
```

- [ ] **Step 2: Verify danger detection works**

```bash
cd /Users/hziotdev/Desktop/feishu-claude-bot && node -e "
const s = require('./src/safeguards');
console.log('rm -rf: dangerous =', s.isDangerous('rm -rf /tmp'));
console.log('npm test: dangerous =', s.isDangerous('npm test --coverage'));
console.log('redact:', s.redactSecrets('sk-abc123def456ghijklmnopqrstuvwxyz'));
"
```

Expected: `rm -rf` = `true`, `npm test` = `false`, and redacted output

- [ ] **Step 3: Commit**

```bash
git add src/safeguards.js
git commit -m "feat: add safeguards - danger gate, secret redaction, file locks"
```

---

### Task 8: Progress Heartbeat

**Files:**
- Create: `src/heartbeat.js`

Progress reporting with sequence numbers. Tracks each active task's elapsed time and sends heartbeat messages at appropriate intervals.

- [ ] **Step 1: Write heartbeat.js**

Create [src/heartbeat.js](src/heartbeat.js):

```javascript
const { sendTextMessage } = require('./feishu');

class HeartbeatTracker {
  constructor() {
    this.tasks = new Map(); // taskId -> { chatId, startedAt, sequence, lastHeartbeat, done }
  }

  startTask(taskId, chatId) {
    this.tasks.set(taskId, {
      chatId,
      startedAt: Date.now(),
      sequence: 0,
      lastHeartbeat: 0,
      done: false,
    });
  }

  tick(taskId, stdoutLine) {
    const t = this.tasks.get(taskId);
    if (!t || t.done) return;

    const elapsed = (Date.now() - t.startedAt) / 1000;
    let interval;

    if (elapsed <= 15) {
      return; // no heartbeat
    } else if (elapsed <= 60) {
      interval = 15;
    } else if (elapsed <= 300) {
      interval = 30;
    } else {
      this.sendHeartbeat(taskId, '⚠️ 任务耗时较长，可能需要人工介入');
      // slow down after 5min
      if (Date.now() - t.lastHeartbeat < 60000) return;
    }

    if (Date.now() - t.lastHeartbeat >= interval * 1000) {
      t.sequence++;
      const preview = stdoutLine
        ? `[#${t.sequence}] 进行中: ${stdoutLine.substring(0, 200)}`
        : `[#${t.sequence}] 任务进行中...`;
      this.sendHeartbeat(taskId, preview);
      t.lastHeartbeat = Date.now();
    }
  }

  sendHeartbeat(taskId, message) {
    const t = this.tasks.get(taskId);
    if (!t) return;
    sendTextMessage(t.chatId, message).catch(() => {});
  }

  markDone(taskId, finalMessage) {
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.done = true;
    sendTextMessage(t.chatId, `[#${t.sequence + 1} 完成] ${finalMessage}`).catch(() => {});
  }

  removeTask(taskId) {
    this.tasks.delete(taskId);
  }
}

const heartbeatTracker = new HeartbeatTracker();

module.exports = { heartbeatTracker };
```

- [ ] **Step 2: Verify module loads**

```bash
cd /Users/hziotdev/Desktop/feishu-claude-bot && node -e "
const { heartbeatTracker } = require('./src/heartbeat');
heartbeatTracker.startTask('test-1', 'oc_test123');
heartbeatTracker.tick('test-1', 'installing packages...');
heartbeatTracker.markDone('test-1', 'Build complete');
console.log('Heartbeat OK');
"
```

- [ ] **Step 3: Commit**

```bash
git add src/heartbeat.js
git commit -m "feat: add progress heartbeat with sequence numbers"
```

---

### Task 9: Message Router

**Files:**
- Create: `src/router.js`

Deduplication, @mention parsing, intent classification via Claude API, event type determination.

- [ ] **Step 1: Write router.js**

Create [src/router.js](src/router.js):

```javascript
const db = require('./db');
const { resolveRoleByName, ROLE_KEYS } = require('./roles');
const { redactSecrets } = require('./safeguards');
const Anthropic = require('@anthropic-ai/sdk').default;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL || 'https://api.deepseek.com/anthropic',
});

const INTENT_CLASSIFICATION_PROMPT = `你是一个消息分类器。分析用户消息，判断最适合回复的团队成员角色。
可选角色：ceo(战略决策), pm(项目管理), architect(架构设计), backend(后端开发), frontend(前端开发), qa(质量策略), reviewer(代码审查), tester(测试执行)
如果消息只是闲聊或提问，返回 null。
只返回角色key或null，不要解释。`;

const TASK_VERBS = ['做', '实现', '开发', '搭建', '写', '创建', '修改', '改', '加', '添加',
  'build', 'implement', 'create', 'develop', 'make', 'add', 'fix', 'change'];

async function classifyIntent(userMessage) {
  try {
    const msg = await anthropic.messages.create({
      model: 'deepseek-v4-flash',
      max_tokens: 20,
      temperature: 0,
      system: INTENT_CLASSIFICATION_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });
    const result = (msg.content[0].text || '').trim().toLowerCase();
    if (result === 'null' || !ROLE_KEYS.includes(result)) return null;
    return result;
  } catch {
    return null;
  }
}

function hasTaskIntent(text) {
  const lower = text.toLowerCase();
  return TASK_VERBS.some(v => lower.includes(v));
}

function isSystemCommand(text) {
  const trimmed = text.trim();
  return trimmed.startsWith('/summary') || trimmed.startsWith('/status');
}

function parseAtMentions(text) {
  const match = text.match(/@(\S+)/g);
  if (!match) return [];
  return match.map(m => {
    const name = m.slice(1);
    return resolveRoleByName(name);
  }).filter(Boolean);
}

function determineEventType(text, isDangerReply) {
  if (isDangerReply) return 'system';
  if (isSystemCommand(text)) return 'system';
  if (hasTaskIntent(text)) return 'task';
  return 'discussion';
}

async function routeMessage(messageId, chatId, content) {
  // Deduplication
  if (db.messageExists(messageId)) {
    return { action: 'skip', reason: 'duplicate' };
  }

  // Secret redaction
  const cleanContent = redactSecrets(content);

  // Insert user message
  db.insertMessage(messageId, chatId, 'user', cleanContent, null);

  // Parse @mentions
  const mentionedRoles = parseAtMentions(content);

  // Determine event type (assume not danger reply for now; handled by caller)
  const eventType = determineEventType(cleanContent, false);

  // Classify intent if no @mention
  let targetRole = null;
  if (mentionedRoles.length === 1) {
    targetRole = mentionedRoles[0];
  } else if (mentionedRoles.length > 1) {
    targetRole = mentionedRoles[0]; // first mentioned is primary
  } else {
    targetRole = await classifyIntent(cleanContent);
  }

  return {
    action: 'route',
    chatId,
    messageId,
    content: cleanContent,
    targetRole,
    mentionedRoles,
    eventType,
  };
}

function determineStuckTimeout(eventType, taskCount) {
  if (eventType === 'discussion') return 120;
  if (taskCount > 0) return 300;
  return 120;
}

module.exports = { routeMessage, classifyIntent, hasTaskIntent, parseAtMentions, determineEventType, determineStuckTimeout };
```

- [ ] **Step 2: Verify module loads**

```bash
cd /Users/hziotdev/Desktop/feishu-claude-bot && node -e "
require('dotenv').config();
const r = require('./src/router');
console.log('Task intent:', r.hasTaskIntent('帮我实现用户登录'));
console.log('No task intent:', r.hasTaskIntent('什么是JWT？'));
console.log('System cmd:', r.determineEventType('/status'));
console.log('Parse @:', r.parseAtMentions('@架构师 帮我设计数据库'));
"
```

Expected: `true`, `false`, `system`, `['architect']`

- [ ] **Step 3: Commit**

```bash
git add src/router.js
git commit -m "feat: add message router with dedup, @mention, and intent classification"
```

---

### Task 10: Process Manager

**Files:**
- Create: `src/process-manager.js`

Spawn/kill/monitor Claude Code subprocesses. Lazy start + idle recycle. Health monitoring with stuck detection. Crash recovery on server start.

- [ ] **Step 1: Write process-manager.js**

Create [src/process-manager.js](src/process-manager.js):

```javascript
const { spawn } = require('child_process');
const db = require('./db');
const { getRole } = require('./roles');
const { sendTextMessage } = require('./feishu');
const { taskBus, claimTasks } = require('./task-board');
const { heartbeatTracker } = require('./heartbeat');
const { buildContextForRole, generateSummary } = require('./context');
const { determineStuckTimeout } = require('./router');
const { releaseAllLocks } = require('./safeguards');

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const HEALTH_INTERVAL_MS = 10000;

const activeProcesses = new Map(); // sessionId -> { process, chatId, role, lastOutput, stuckCount, taskSize }

function getSessionId(chatId, role) {
  return `${chatId}-${role}`;
}

function spawnClaudeCode(chatId, role, context, taskDescription) {
  const roleDef = getRole(role);
  if (!roleDef) throw new Error(`Unknown role: ${role}`);

  const sessionId = getSessionId(chatId, role);
  killExistingProcess(sessionId);

  const systemPrompt = `${roleDef.systemPrompt}\n\n---\n当前项目上下文:\n${context}\n---\n用户任务: ${taskDescription}`;

  const child = spawn('claude', [
    '--print',
    '--system-prompt', systemPrompt,
    '--model', 'opus',
    '--max-turns', '1',
    taskDescription,
  ], {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (data) => {
    const line = data.toString();
    const proc = activeProcesses.get(sessionId);
    if (proc) {
      proc.lastOutput = Date.now();
      heartbeatTracker.tick(sessionId, line);
    }
  });

  child.stderr.on('data', (data) => {
    console.error(`[${role}] stderr:`, data.toString());
  });

  child.on('close', (code) => {
    console.log(`[${role}] process exited with code ${code}`);
    // Save context summary on exit
    const proc = activeProcesses.get(sessionId);
    if (proc) {
      releaseAllLocks(sessionId);
    }
  });

  child.on('error', (err) => {
    console.error(`[${role}] spawn error:`, err.message);
    releaseAllLocks(sessionId);
    activeProcesses.delete(sessionId);
  });

  const procEntry = {
    process: child,
    chatId,
    role,
    lastOutput: Date.now(),
    stuckCount: 0,
    taskSize: 'discussion',
  };

  activeProcesses.set(sessionId, procEntry);
  db.upsertSession(sessionId, chatId, role, null, child.pid, 'active');
  heartbeatTracker.startTask(sessionId, chatId);

  return { sessionId, child };
}

function killExistingProcess(sessionId) {
  const existing = activeProcesses.get(sessionId);
  if (existing) {
    try {
      existing.process.kill('SIGTERM');
    } catch {}
    activeProcesses.delete(sessionId);
    releaseAllLocks(sessionId);
  }
}

async function handleRoleReply(chatId, role, content, eventType) {
  const context = buildContextForRole(chatId, role);
  const { sessionId } = spawnClaudeCode(chatId, role, context, content);

  return new Promise((resolve) => {
    const proc = activeProcesses.get(sessionId);
    if (!proc) { resolve(null); return; }

    let output = '';
    proc.process.stdout.on('data', (d) => { output += d.toString(); });
    proc.process.on('close', (code) => {
      // Store response as role message
      const trimmed = output.trim();
      if (trimmed) {
        db.insertMessage(`reply-${Date.now()}`, chatId, role, trimmed, null);
        heartbeatTracker.markDone(sessionId, trimmed.substring(0, 300));
        sendTextMessage(chatId, trimmed).catch(() => {});
      }

      // After role completes, check if reviewer/tester should run
      if (['backend', 'frontend', 'architect'].includes(role)) {
        taskBus.emit('review:needed', { chatId, role, output: trimmed });
      }

      // Update session
      db.updateSessionStatus(sessionId, 'inactive', trimmed.substring(0, 500));
      resolve(trimmed);
    });
  });
}

function idleRecycle() {
  const now = Date.now();
  for (const [sessionId, proc] of activeProcesses) {
    if (now - proc.lastOutput > IDLE_TIMEOUT_MS) {
      try { proc.process.kill('SIGTERM'); } catch {}
      activeProcesses.delete(sessionId);
      db.updateSessionStatus(sessionId, 'inactive', null);
      releaseAllLocks(sessionId);
      console.log(`Idle recycled: ${sessionId}`);
    }
  }
  // Also cleanup DB sessions
  const sessions = db.idleSessions(null, 10);
  for (const s of sessions) {
    db.updateSessionStatus(s.id, 'inactive', s.context_summary);
  }
}

function healthCheck(stuckReport) {
  const stuckRoles = [];
  for (const [sessionId, proc] of activeProcesses) {
    const timeout = determineStuckTimeout(proc.taskSize, 0);
    const idleTime = (Date.now() - proc.lastOutput) / 1000;
    if (idleTime > timeout) {
      proc.stuckCount++;
      stuckRoles.push(proc.role);
      if (proc.stuckCount < 3) {
        try { proc.process.kill('SIGTERM'); } catch {}
        activeProcesses.delete(sessionId);
        releaseAllLocks(sessionId);
        sendTextMessage(proc.chatId, `⚠️ @${proc.role} 进程被卡住，正在重启...`).catch(() => {});
        // Re-spawn
        const context = buildContextForRole(proc.chatId, proc.role);
        spawnClaudeCode(proc.chatId, proc.role, context, '请继续之前未完成的任务');
      } else {
        sendTextMessage(proc.chatId, `⚠️ @${proc.role} 反复卡住已停止，请人工检查`).catch(() => {});
        activeProcesses.delete(sessionId);
        releaseAllLocks(sessionId);
        db.updateSessionStatus(sessionId, 'inactive', null);
      }
    }
  }

  // Global API outage check
  if (stuckRoles.length >= 5) {
    const chatId = [...activeProcesses.values()][0]?.chatId;
    if (chatId && stuckReport) {
      sendTextMessage(chatId, '⚠️ 多个角色同时卡住，可能 DeepSeek API 服务异常，全队在等待...').catch(() => {});
    }
  }
}

function recoverFromCrash(chatId) {
  const activeSessions = db.getActiveSessions(chatId) || [];
  const rolesToRestore = activeSessions.map(s => s.role);

  for (const session of activeSessions) {
    killExistingProcess(session.id);
    db.updateSessionStatus(session.id, 'inactive', null);
  }

  const pendingTasks = db.getPendingTasks(chatId) || [];

  if (rolesToRestore.length > 0 || pendingTasks.length > 0) {
    const taskSummary = pendingTasks.length > 0
      ? `${pendingTasks.length}个任务，其中${pendingTasks.filter(t => t.status === 'in_progress').length}个进行中`
      : '无待处理任务';
    sendTextMessage(chatId,
      `🔄 团队已恢复启动。上次进度：${taskSummary}。`
    ).catch(() => {});

    // Re-awaken roles with pending tasks
    for (const role of [...new Set(pendingTasks.filter(t => t.status === 'in_progress').map(t => t.assignee).filter(Boolean))]) {
      const context = buildContextForRole(chatId, role);
      spawnClaudeCode(chatId, role, context, '请继续之前未完成的任务');
    }
  }
}

// Start health monitor loop
const healthLoop = setInterval(() => {
  let stuckReport = false;
  healthCheck(stuckReport);
  idleRecycle();
  // Cleanup expired locks
  const { cleanupExpiredLocks } = require('./safeguards');
  cleanupExpiredLocks(30);
}, HEALTH_INTERVAL_MS);

module.exports = { spawnClaudeCode, handleRoleReply, killExistingProcess, idleRecycle, healthCheck, recoverFromCrash, activeProcesses, getSessionId };
```

- [ ] **Step 2: Commit**

```bash
git add src/process-manager.js
git commit -m "feat: add process manager with lazy start, idle recycle, health monitor, and crash recovery"
```

---

### Task 11: Rewrite index.js (Main Server)

**Files:**
- Modify: `index.js` — full rewrite to wire all modules together

Replace the existing monolith with the modular architecture. Webhook endpoint, async message processing with Feishu 3-second timeout compliance.

- [ ] **Step 1: Write new index.js**

Replace [index.js](index.js) with:

```javascript
require('dotenv').config();

const express = require('express');
const db = require('./src/db');
const { routeMessage, parseAtMentions, determineEventType } = require('./src/router');
const { handleRoleReply } = require('./src/process-manager');
const { recoverFromCrash } = require('./src/process-manager');
const { sendTextMessage, sendDangerConfirmationCard } = require('./src/feishu');
const { isDangerous, redactSecrets } = require('./src/safeguards');
const { getRole } = require('./src/roles');
const { taskBus, createTasksFromPM } = require('./src/task-board');

// Initialize database
db.init();

// Daily backup
db.dailyBackup();
if (!db.integrityCheck()) {
  console.error('Database integrity check failed, attempting recovery...');
}

const app = express();
app.use(express.json());

const CHAT_ID = process.env.FEISHU_CHAT_ID || '';

// Process message asynchronously (Feishu requires <3s response)
async function processMessageAsync(messageId, chatId, content) {
  try {
    const route = await routeMessage(messageId, chatId, content);
    if (route.action === 'skip') {
      console.log(`Skipping duplicate message: ${messageId}`);
      return;
    }

    if (!route.targetRole) {
      // No specific target — general discussion, let PM or CEO respond
      if (route.eventType === 'task') {
        await handleRoleReply(chatId, 'pm', route.content, route.eventType);
      }
      return;
    }

    const roleDef = getRole(route.targetRole);
    if (!roleDef) return;

    await handleRoleReply(chatId, route.targetRole, route.content, route.eventType);
  } catch (err) {
    console.error('Error processing message:', err);
  }
}

app.post('/feishu/event', async (req, res) => {
  res.json({ code: 0 }); // Always return 200 immediately

  try {
    const body = req.body;

    if (body.type === 'url_verification') {
      console.log('URL verification');
      return res.json({ challenge: body.challenge });
    }

    if (body.header?.event_type === 'im.message.receive_v1') {
      const event = body.event;
      const message = event.message;

      if (message.message_type !== 'text') return;

      let userMessage = '';
      try {
        userMessage = JSON.parse(message.content).text || '';
      } catch {
        userMessage = message.content || '';
      }

      if (!userMessage.trim()) return;

      const chatId = message.chat_id;
      const messageId = message.message_id;

      console.log(`[${chatId}] User: ${userMessage}`);

      // Check for danger card button reply
      let isDangerReply = false;
      try {
        const content = JSON.parse(message.content);
        if (content.action) {
          isDangerReply = true;
          // Handle danger confirmation button clicks
          if (content.action === 'danger_confirm') {
            sendTextMessage(chatId, '✅ 危险操作已确认，正在执行...');
            // Re-process with approval
            userMessage = `(用户已确认) ${content.command}`;
          } else if (content.action === 'danger_reject') {
            sendTextMessage(chatId, '❌ 危险操作已拒绝');
            return;
          }
        }
      } catch {}

      processMessageAsync(messageId, chatId, userMessage);
    }
  } catch (err) {
    console.error('Event error:', err);
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    model: 'deepseek-v4-pro',
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Feishu Multi-Agent Team running on port ${PORT}`);

  // Crash recovery on startup
  if (CHAT_ID) {
    setTimeout(() => recoverFromCrash(CHAT_ID), 2000);
  }
});

// Task bus listeners

taskBus.on('task:created', (task) => {
  if (task.assignee) {
    // Notify assignee to start working
    handleRoleReply(task.chatId || CHAT_ID, task.assignee,
      `新任务已分配给你: ${task.title}`, 'task').catch(() => {});
  }
});

taskBus.on('task:done', ({ taskId, role }) => {
  // Trigger reviewer
  handleRoleReply(CHAT_ID, 'reviewer',
    `请审查 ${role} 完成的任务 ${taskId}`, 'review').catch(() => {});
});

taskBus.on('task:escalated', ({ taskId, chatId }) => {
  handleRoleReply(chatId || CHAT_ID, 'ceo',
    `任务 ${taskId} 已升级给你，请重新评估`, 'system').catch(() => {});
});

taskBus.on('review:needed', ({ chatId, output }) => {
  handleRoleReply(chatId || CHAT_ID, 'reviewer',
    `请审查以下产出:\n${output?.substring(0, 2000) || ''}`, 'review').catch(() => {});
  handleRoleReply(chatId || CHAT_ID, 'tester',
    `审查完成后请执行测试并登记质量报告`, 'review').catch(() => {});
});
```

- [ ] **Step 2: Verify server starts**

```bash
cd /Users/hziotdev/Desktop/feishu-claude-bot && timeout 5 node index.js 2>&1 || true
```

Expected: Log line "Feishu Multi-Agent Team running on port 3000"

- [ ] **Step 3: Test health endpoint**

In a separate terminal or using background:

```bash
cd /Users/hziotdev/Desktop/feishu-claude-bot && node index.js &
sleep 2
curl -s http://localhost:3000/health | head -c 200
kill %1 2>/dev/null
```

Expected: `{"status":"ok","model":"deepseek-v4-pro",...}`

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: rewrite index.js with modular multi-agent architecture"
```

---

### Task 12: End-to-End Integration Test

**Files:**
- Create: `test/integration.test.js`

Verify the core flow: message → router → process manager → response. Mock Claude Code subprocess and Feishu API calls.

- [ ] **Step 1: Write integration test**

```bash
mkdir -p test
```

Create [test/integration.test.js](test/integration.test.js):

```javascript
require('dotenv').config();

const db = require('../src/db');
const { routeMessage } = require('../src/router');
const { getRole, resolveRoleByName, ROLE_KEYS } = require('../src/roles');
const { parseAtMentions, hasTaskIntent, determineEventType } = require('../src/router');
const { isDangerous, redactSecrets, isWhiteListed } = require('../src/safeguards');
const { buildContextForRole } = require('../src/context');
const { matchRoleForTask } = require('../src/task-board');

// Initialize DB for tests
db.init();

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.error(`  FAIL: ${name}`); }
}

console.log('\n=== Role Definitions ===');
assert(ROLE_KEYS.length === 8, '8 roles defined');
assert(resolveRoleByName('CEO') === 'ceo', 'resolve CEO by name');
assert(resolveRoleByName('架构师') === 'architect', 'resolve architect by Chinese name');
assert(resolveRoleByName('后端工程师') !== null, 'resolve backend by Chinese name');
assert(resolveRoleByName('nonexistent') === null, 'unknown role returns null');

console.log('\n=== Message Router ===');
assert(hasTaskIntent('帮我实现用户登录功能') === true, 'task intent detected (Chinese)');
assert(hasTaskIntent('build a login page') === true, 'task intent detected (English)');
assert(hasTaskIntent('今天天气怎么样') === false, 'no task intent for casual chat');
assert(determineEventType('/summary') === 'system', '/summary is system event');
assert(determineEventType('你好') === 'discussion', 'casual message is discussion');
assert(parseAtMentions('@架构师 帮我看看').length > 0, '@mention parsed');

console.log('\n=== Safeguards ===');
assert(isDangerous('rm -rf /tmp/test') === true, 'rm -rf detected');
assert(isDangerous('git push --force origin main') === true, 'force push detected');
assert(isDangerous('npm test --coverage') === false, 'safe command not flagged');
const redacted = redactSecrets('key=sk-abc123def456ghijklmnopqrstuvwxyz');
assert(redacted.includes('[REDACTED]'), 'API key redacted');
assert(isWhiteListed('npm test') === true, 'npm test is whitelisted');

console.log('\n=== Task Board ===');
const taskKey = matchRoleForTask('设计数据库表结构');
assert(taskKey === 'architect', `task matching: ${taskKey}`);
const backendKey = matchRoleForTask('实现API接口');
assert(backendKey === 'backend', `backend task matching: ${backendKey}`);

console.log('\n=== Database Operations ===');
const testMsgId = `test-${Date.now()}`;
db.insertMessage(testMsgId, 'oc_test', 'user', 'Hello', null);
assert(db.messageExists(testMsgId) === true, 'message stored and retrievable');
const recent = db.getRecentMessages('oc_test', 'user', 10);
assert(recent.length > 0, 'recent messages retrievable');

console.log('\n=== Context Management ===');
const ctx = buildContextForRole('oc_test', 'user');
assert(typeof ctx === 'string', 'context builder returns string');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 2: Run the test**

```bash
cd /Users/hziotdev/Desktop/feishu-claude-bot && node test/integration.test.js
```

Expected: All tests pass (note: intent classification will use the API, routeMessage test may fail on API call — that's acceptable)

- [ ] **Step 3: Commit**

```bash
git add test/integration.test.js
git commit -m "test: add integration tests for all core modules"
```

---

### Task 13: Docs Cleanup & Final Polish

**Files:**
- Modify: `package.json` — verify scripts
- Verify: `.env` has `FEISHU_CHAT_ID`

- [ ] **Step 1: Add FEISHU_CHAT_ID to .env if missing**

Read `.env`, add:

```
FEISHU_CHAT_ID=oc_xxxxxxxxxxxxxx
```

(Replace with the actual Feishu group chat ID)

- [ ] **Step 2: Run full startup test**

```bash
cd /Users/hziotdev/Desktop/feishu-claude-bot && node -e "
require('dotenv').config();
const db = require('./src/db');
db.init();
console.log('DB: OK');
require('./src/roles');
console.log('Roles: OK');
require('./src/feishu');
console.log('Feishu: OK');
require('./src/context');
console.log('Context: OK');
require('./src/task-board');
console.log('TaskBoard: OK');
require('./src/safeguards');
console.log('Safeguards: OK');
require('./src/heartbeat');
console.log('Heartbeat: OK');
require('./src/router');
console.log('Router: OK');
require('./src/process-manager');
console.log('ProcessManager: OK');
console.log('All modules loaded successfully');
"
```

Expected: All modules log "OK"

- [ ] **Step 3: Final commit**

```bash
git add .
git commit -m "feat: complete multi-agent team implementation"
```
