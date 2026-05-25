# 测试框架架构设计

## 1. 选型决策

| 维度 | 选择 | 理由 |
|------|------|------|
| 测试运行器 | **Jest** v29 | 零配置、内置覆盖率、内置 mock、describe/it/beforeEach、快照 |
| HTTP Mock | **nock** | 拦截 axios HTTP 请求，无需修改业务代码即可 mock 飞书 API |
| 子进程 Mock | 自定义 Agent Strategy 接口 | Jest 无法直接 mock `child_process.spawn` 的异步行为 |
| 覆盖率 | Jest 内置 `--coverage` | V8 引擎原生支持，支持 `lcov` + `text` 输出 |
| E2E 断言 | **SuperTest** (supertest) | Express 应用级测试，无需启动服务器，直接发送 HTTP 请求 |
| 代码质量 | **ESLint** + **Prettier** | 可选，与测试框架不冲突 |

---

## 2. 分层架构

```
test/
├── unit/                    # 单元测试 — 纯函数 + 单一模块
│   ├── roles.test.js
│   ├── router.test.js
│   ├── security.test.js
│   ├── context.test.js
│   └── heartbeat.test.js
├── integration/             # 集成测试 — 模块间协作
│   ├── db.test.js           #   DB CRUD 全流程
│   ├── tasks.test.js        #   tasks → db 协作
│   ├── process-manager.test.js  # session + agent 管理
│   └── webhook.test.js      #   Express 路由 + SuperTest
├── e2e/                     # 端到端测试 — 跨域场景
│   └── cross-domain/        # 对应 qa-cross-domain-integration.md
│       ├── e2e-01-model-lifecycle.test.js
│       ├── e2e-02-ci-cd-pipeline.test.js
│       └── ...
├── mocks/                   # Mock 实现
│   ├── feishu.js            #   飞书 API Mock Server
│   └── agent.js             #   Agent 调用 Mock
├── seeds/                   # 种子数据
│   ├── __base__.sql
│   └── *.sql
├── factories.js             # 夹具工厂
├── setup.js                 # Jest 全局 setup
└── seed.js                  # Seed 加载器
```

### 测试金字塔与当前项目

```
         ╱╲
        ╱  ╲        E2E (20 跨域场景)
       ╱    ╲       慢、覆盖关键路径
      ╱──────╲
     ╱        ╲     集成测试 (DB + HTTP + Agent)
    ╱          ╲    中等粒度、覆盖模块协作
   ╱────────────╲
  ╱              ╲  单元测试 (纯函数 + DB mock)
 ╱                ╲ 快速、覆盖边界和异常、占 70%+
╱──────────────────╲
```

**估算规模**:
- 单元测试: ~150 个（覆盖 8 模块的纯函数 + DB 操作）
- 集成测试: ~40 个（模块协作 + Webhook 路由）
- E2E: 20 个（跨域场景）

---

## 3. Jest 配置

```js
// jest.config.js
module.exports = {
  testEnvironment: 'node',
  
  // 路径别名
  moduleNameMapper: {
    '^@src/(.*)$': '<rootDir>/src/$1',
  },
  
  // Setup 文件（全局执行一次）
  setupFiles: ['<rootDir>/test/setup.js'],
  
  // 每个测试文件前执行
  setupFilesAfterSetup: [],
  
  // 覆盖率配置
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/index.js',        // 入口文件不测覆盖率
    '!src/process-manager.js', // 子进程逻辑走集成测试
  ],
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 70,
      lines: 70,
      statements: 70,
    },
    'src/security.js': {     // 纯函数，要求更高
      branches: 90,
      functions: 90,
      lines: 90,
    },
    'src/router.js': {
      branches: 80,
      functions: 85,
    },
  },
  
  // 测试文件匹配
  testMatch: [
    '**/test/unit/**/*.test.js',
    '**/test/integration/**/*.test.js',
    '**/test/e2e/**/*.test.js',
  ],
  
  // 超时设置
  testTimeout: 10000,        // 默认 10s
  // E2E 单独使用更长超时
};
```

### NPM Scripts

```json
{
  "scripts": {
    "test": "jest",
    "test:unit": "jest test/unit",
    "test:integration": "jest test/integration",
    "test:e2e": "jest test/e2e --testTimeout 60000",
    "test:coverage": "jest --coverage",
    "test:watch": "jest --watch",
    "test:ci": "jest --coverage --ci --maxWorkers=2"
  }
}
```

---

## 4. Setup 文件设计

```js
// test/setup.js
// Jest 的 setupFiles 在每个 worker 中，所有测试文件之前执行

// 1. 设置测试环境变量
process.env.NODE_ENV = 'test';
process.env.DB_MODE = ':memory:';
process.env.MOCK_FEISHU = 'true';
process.env.MOCK_AGENT = 'true';
process.env.APP_ID = 'mock-app-id';
process.env.APP_SECRET = 'mock-app-secret';
process.env.ANTHROPIC_API_KEY = 'mock-api-key';
process.env.FEISHU_CHAT_ID = 'test-chat-id';

// 2. nock 拦截所有 HTTP 出站请求（可选严格模式）
const nock = require('nock');
beforeAll(() => {
  if (process.env.MOCK_FEISHU === 'true') {
    // 拦截飞书 API 请求
    nock('https://open.feishu.cn')
      .persist()
      .post('/open-apis/auth/v3/tenant_access_token/internal')
      .reply(200, { tenant_access_token: 'mock-token', expire: 7200 })
      .post('/open-apis/im/v1/messages')
      .query(true)
      .reply(200, { code: 0, message: 'ok' });
  }
});

afterAll(() => {
  nock.cleanAll();
});
```

---

## 5. 模块级测试策略

### 5.1 单元测试 — 纯函数模块

**Router** (`test/unit/router.test.js`):

```js
const { parseAtMentions, hasTaskIntent, determineEventType, classifyByKeywords } = require('../../src/router');

describe('parseAtMentions', () => {
  test('parses @角色名 mentions', () => {
    expect(parseAtMentions('@架构师 帮我设计系统')).toEqual(['architect']);
  });

  test('returns empty for no mentions', () => {
    expect(parseAtMentions('你好')).toEqual([]);
  });

  test('handles multiple mentions', () => {
    expect(parseAtMentions('@后端 @前端 一起做')).toEqual(['backend-dev', 'frontend-dev']);
  });
});

describe('hasTaskIntent', () => {
  test.each([
    ['帮我实现登录', true],
    ['build a page', true],
    ['今天天气怎么样', false],
  ])('%s → %s', (input, expected) => {
    expect(hasTaskIntent(input)).toBe(expected);
  });
});

describe('classifyByKeywords', () => {
  test.each([
    ['审查代码', 'reviewer'],
    ['写接口', 'backend-dev'],
    ['设计架构', 'architect'],
    ['随便聊聊', null],
  ])('%s → %s', (input, expected) => {
    expect(classifyByKeywords(input)).toBe(expected);
  });
});
```

**Security** (`test/unit/security.test.js`):

```js
describe('isDangerous', () => {
  test('detects rm -rf', () => {
    expect(isDangerous('rm -rf /')).toBe(true);
  });

  test('safe command not flagged', () => {
    expect(isDangerous('npm test')).toBe(false);
  });

  // 边界: 白名单前缀但不是安全命令
  test('git push --force is dangerous', () => {
    expect(isDangerous('git push --force origin main')).toBe(true);
  });
});

describe('redactSecrets', () => {
  test('redacts API keys', () => {
    const result = redactSecrets('key=sk-abc123def456ghijklmnopqrstuvwxyz');
    expect(result).not.toContain('sk-abc123def456');
    expect(result).toContain('REDACTED-API-KEY');
  });
});
```

### 5.2 单元测试 — DB 模块（使用 :memory:）

```js
// test/unit/db.test.js
const db = require('../../src/db');

describe('Database', () => {
  beforeAll(() => {
    db.init(':memory:');
  });

  afterAll(() => {
    db.getDb().close();
  });

  // 清理但不销毁 DB
  afterEach(() => {
    db.getDb().exec('DELETE FROM messages; DELETE FROM sessions; DELETE FROM tasks; DELETE FROM locks;');
  });

  test('inserts and retrieves messages', () => {
    db.insertMessage('msg-1', 'chat-1', 'user', 'Hello');
    expect(db.messageExists('msg-1')).toBe(true);
    const msgs = db.getRecentMessages('chat-1');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('Hello');
  });

  test('task CRUD', () => {
    db.createTask('task-1', 'chat-1', 'Test', null, 'high', null, 'pm');
    db.assignTask('task-1', 'backend-dev');
    let tasks = db.getTasks('chat-1');
    expect(tasks[0].assigned_role).toBe('backend-dev');

    db.updateTaskStatus('task-1', 'completed', 'All done');
    tasks = db.getTasks('chat-1');
    expect(tasks[0].status).toBe('completed');
  });

  test('dependency resolution for ready tasks', () => {
    db.createTask('task-a', 'chat-1', 'Task A', null, 'medium', null, 'pm');
    db.createTask('task-b', 'chat-1', 'Task B', null, 'medium', 'task-a', 'pm');
    
    let ready = db.getReadyTasks('chat-1');
    expect(ready).toHaveLength(1); // only task-a (no dependency)
    expect(ready[0].id).toBe('task-a');
    
    db.updateTaskStatus('task-a', 'completed', 'Done');
    ready = db.getReadyTasks('chat-1');
    expect(ready).toHaveLength(1); // now task-b is ready
    expect(ready[0].id).toBe('task-b');
  });

  test('expired lock can be reacquired', () => {
    db.acquireLock('lock-1', 'holder-1', 0); // 0 TTL = immediately expired
    expect(db.acquireLock('lock-1', 'holder-2', 30000)).toBe(true);
  });
});
```

### 5.3 集成测试 — HTTP 层 (SuperTest)

```js
// test/integration/webhook.test.js
const request = require('supertest');
const db = require('../../src/db');
let app;

beforeAll(() => {
  db.init(':memory:');
  app = require('../../index'); // Express app
});

describe('Webhook Endpoint', () => {
  test('responds to URL verification', async () => {
    const res = await request(app)
      .post('/feishu/event')
      .send({ type: 'url_verification', challenge: 'test123' });
    expect(res.status).toBe(200);
    expect(res.body.challenge).toBe('test123');
  });

  test('health check returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body).toHaveProperty('activeProcesses');
  });

  test('handles text message event', async () => {
    const res = await request(app)
      .post('/feishu/event')
      .send({
        header: { event_type: 'im.message.receive_v1' },
        event: {
          message: {
            message_id: 'test-webhook-1',
            message_type: 'text',
            chat_id: 'test-chat',
            content: JSON.stringify({ text: '你好' }),
          },
        },
      });
    expect(res.status).toBe(200);
  });
});
```

---

## 6. E2E 测试模板

```js
// test/e2e/cross-domain/e2e-01-model-lifecycle.test.js
const request = require('supertest');
const db = require('../../src/db');
const { loadScenario } = require('../../test/seed');

describe('E2E-01: 模型全生命周期', () => {
  beforeAll(() => {
    db.init(':memory:');
    loadScenario('chat_with_tasks');
    app = require('../../index');
  });

  test('创建模型 → 提交训练 → 评估 → 注册 → 部署', async () => {
    // Step 1: 模拟用户创建模型
    const msg1 = await sendWebhookMessage('创建新模型 ResNet-50', 'chat-model-lifecycle');
    expect(msg1).toContain('创建');
    
    // Step 2: 提交训练任务
    const msg2 = await sendWebhookMessage('提交训练任务', 'chat-model-lifecycle');
    expect(msg2).toContain('提交');
    
    // Step 3: 验证任务状态
    const tasks = db.getTasks('chat-model-lifecycle');
    expect(tasks.length).toBeGreaterThan(0);
  });
});
```

---

## 7. 覆盖率目标

| 模块 | 目标覆盖率 | 策略 |
|------|-----------|------|
| `router.js` | 90%+ | 纯函数，每路径穷举 |
| `security.js` | 90%+ | 纯函数，每模式穷举 |
| `roles.js` | 85%+ | 配置类，验证所有角色 |
| `db.js` | 85%+ | 所有 CRUD + 边界条件 |
| `tasks.js` | 80%+ | 核心逻辑 + DB 协作 |
| `context.js` | 75%+ | 消息分区逻辑 |
| `feishu.js` | 60%+ | HTTP mock 验证 |
| `process-manager.js` | 50%+ | 通过集成测试覆盖 session 管理 |
| `index.js` | 40%+ | 端到端覆盖，不追求覆盖率 |
| **整体** | **70%+** | |

---

## 8. CI 集成

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '18' }
      - run: npm ci
      - run: npm run test:ci
      - name: Upload coverage
        uses: codecov/codecov-action@v3
```

---

## 9. 实施路线图

| 阶段 | 内容 | 估算人天 |
|------|------|---------|
| **Phase 1: 基础搭建** | Jest 配置 + nock + SuperTest 安装；setup.js 环境变量；`:memory:` DB 模式；2 个模块的单元测试示例（router, security） | 1 天 |
| **Phase 2: 核心覆盖** | DB 模块完整测试；Feishu mock 完善；tasks/context/roles 单元测试；第一个 Webhook 集成测试 | 2 天 |
| **Phase 3: Agent 测试** | Agent Strategy 接口抽象 + MockAgent 实现；process-manager 集成测试；Heartbeat 测试 | 2 天 |
| **Phase 4: E2E** | 夹具工厂 + Seed 系统；20 个跨域场景覆盖前 5 个 P0 场景 | 3 天 |
| **Phase 5: CI + 收尾** | GitHub Actions 配置；覆盖率门禁配置；测试文档 + README badge | 0.5 天 |
| **合计** | | **~8.5 天** |
