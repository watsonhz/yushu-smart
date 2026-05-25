# 测试数据管理方案

## 1. 设计原则

1. **测试隔离** — 每个测试用例独立的数据环境，互不污染
2. **可复现** — 任一时间运行同一套测试，结果一致
3. **轻量无依赖** — 不依赖外部服务即可运行（通过 mock）
4. **生产安全** — 测试数据绝不泄露到生产环境

---

## 2. 数据库策略

### 2.1 三层数据库模式

```
┌─────────────────┐
│   单元测试层      │  SQLite :memory:
│   (每个 test←→   │  测试前后自动创建销毁
│   独立实例)       │
├─────────────────┤
│   集成测试层      │  SQLite 临时文件
│   (每个 describe←→│  test/tmp/*.test.db
│   独立实例)       │
├─────────────────┤
│   E2E 测试层     │  SQLite 文件 + 预置 seed
│   (可配置)        │  test/seeds/*.sql
└─────────────────┘
```

### 2.2 实现方式

```js
// src/db.js — 支持 :memory: 模式
function init(dbPath) {
  if (dbPath === ':memory:') {
    db = new Database(':memory:');
  } else {
    const resolvedPath = dbPath || path.join(__dirname, '..', '.data', 'bot.db');
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    db = new Database(resolvedPath);
  }
  // ... schema 创建 ...
}

// 测试用
afterEach(() => {
  db.close(); // 自动销毁 :memory: 数据库
});
```

---

## 3. 夹具工厂设计

### 3.1 基础工厂

为每个核心实体提供工厂函数:

| 实体 | 工厂函数 | 默认值策略 |
|------|---------|-----------|
| Chat/租户 | `buildChat(overrides)` | 自动生成唯一 ID |
| Message | `buildMessage(overrides)` | 关联 chat + 自动时间戳 |
| Session | `buildSession(overrides)` | 状态 = 'idle' |
| Task | `buildTask(overrides)` | 优先级 = 'medium' |
| Lock | `buildLock(overrides)` | TTL = 30s |

### 3.2 实现示例

```js
// test/factories.js
let counter = 0;

function buildChat(overrides = {}) {
  const id = `test-chat-${++counter}-${Date.now()}`;
  return { id, name: 'Test Chat', ...overrides };
}

function buildMessage(overrides = {}) {
  const id = `test-msg-${++counter}-${Date.now()}`;
  return {
    id, chat_id: 'test-chat', role: 'user',
    content: 'test message',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildTask(overrides = {}) {
  const id = `test-task-${++counter}-${Date.now()}`;
  return {
    id, chat_id: 'test-chat', title: 'Test Task',
    description: null, status: 'pending', priority: 'medium',
    assigned_role: null, depends_on: null, result: null,
    created_by: 'tester',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}
```

---

## 4. Seeder 系统

### 4.1 种子数据分类

| 类别 | 用途 | 加载时机 |
|------|------|---------|
| **基础 seed** | 必选数据（schema、默认角色） | beforeEach |
| **场景 seed** | 特定场景预制数据（如已存在 100 条消息） | 按需加载 |
| **边界 seed** | 边界状态（数据库满、损坏等） | 特定测试 |

### 4.2 场景 Seed 文件

```
test/seeds/
  __base__.sql          — 基础 Schema + 默认元数据
  chat_with_msgs.sql    — 一个 chat 含 50 条历史消息
  chat_with_tasks.sql   — 一个 chat 含完整的任务依赖链
  multi_chat.sql        — 3 个 chat 用于并发测试
  locked_resources.sql  — 部分资源被锁定的场景
```

### 4.3 Seeder 加载器

```js
// test/seed.js
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

function loadSeed(name) {
  const sql = fs.readFileSync(
    path.join(__dirname, 'seeds', `${name}.sql`), 'utf8'
  );
  db.getDb().exec(sql);
}

function loadScenario(name) {
  loadSeed('__base__');
  loadSeed(name);
}

module.exports = { loadSeed, loadScenario };
```

---

## 5. Mock 数据管理

### 5.1 飞书 API Mock

```js
// test/mocks/feishu.js
const mockResponses = {
  tenantAccessToken: { tenant_access_token: 'mock-token', expire: 7200 },
};

// 录制/回放模式
class FeishuMockServer {
  constructor() {
    this.recordings = new Map(); // url → [{ request, response }]
    this.mode = process.env.FEISHU_MOCK_MODE || 'replay'; // record | replay | passthrough
  }
  
  async handleRequest(url, data) {
    if (this.mode === 'record') {
      const response = await realAxios.post(url, data);
      this.recordings.set(url, [...(this.recordings.get(url) || []), { request: data, response: response.data }]);
      return response.data;
    }
    if (this.mode === 'replay') {
      const recorded = this.recordings.get(url);
      if (!recorded) throw new Error(`No recording for ${url}`);
      return recorded.shift().response;
    }
    return realAxios.post(url, data); // passthrough
  }
}
```

### 5.2 Agent 调用 Mock

```js
// test/mocks/agent.js
class MockAgentStrategy {
  constructor(responseMap) {
    this.responseMap = responseMap; // 关键词 → 预设回复
  }
  
  async execute(chatId, roleName, prompt, messageId) {
    for (const [keyword, response] of Object.entries(this.responseMap)) {
      if (prompt.includes(keyword)) return response;
    }
    return `[${roleName}] Mocked response for: ${prompt.substring(0, 50)}...`;
  }
}
```

---

## 6. 测试用户/租户体系

### 6.1 角色模拟

| 测试用户 | mock ID | 用途 |
|---------|---------|------|
| Tester | `test-tester` | 执行操作的默认用户 |
| Admin | `test-admin` | 测试权限边界 |
| Multi-role | `test-multi` | 多角色路由测试 |

### 6.2 Chat ID 命名规范

```
test-{场景}-{编号}
示例: test-crossdomain-e2e-01, test-concurrent-001
```

---

## 7. 数据清理策略

| 层级 | 清理策略 | 实现 |
|------|---------|------|
| 单元测试 | 自动销毁 | `:memory:` DB 随 db.close() 释放 |
| 集成测试 | 临时文件清理 | `afterAll(() => fs.unlinkSync(tmpDbPath))` |
| E2E 测试 | Seed 重置 | `beforeEach(() => reloadSeed('__base__'))` |
| 遗留数据 | TTL 自动清理 | 为临时 DB 文件设置 maxAge |

---

## 8. 环境变量模板

```bash
# .env.test — 测试专用环境变量
NODE_ENV=test
DB_MODE=:memory:

# 飞书 Mock（不填则自动 mock）
APP_ID=mock-app-id
APP_SECRET=mock-app-secret

# Claude API（部分测试需要真实调用时可设置）
ANTHROPIC_API_KEY=mock-key
ANTHROPIC_BASE_URL=

# Test control
MOCK_FEISHU=true
MOCK_AGENT=true
FEISHU_MOCK_MODE=replay  # record | replay | passthrough
```
