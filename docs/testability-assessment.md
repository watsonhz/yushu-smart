# 可测试性评估报告

**评估日期**: 2026-05-25
**评估对象**: feishu-claude-bot (Phase 2 多角色自治团队)
**评估目标**: 识别对自动化测试不友好的设计点，为测试框架架构和测试数据管理方案提供输入

---

## 1. 整体评估

| 维度 | 评分 | 说明 |
|------|------|------|
| 模块化 | ⚠️ 中等 | 模块按职责分离，但耦合方式不利于测试 |
| 可 mock 性 | 🔴 差 | 无依赖注入，所有模块直接 `require()` |
| 状态隔离 | 🔴 差 | 全局单例 + 固定 DB 路径 + process.env |
| 边界可控性 | ⚠️ 中等 | SQLite 同步操作可控；外部 API 和子进程不可控 |
| 现有测试基础 | 🟡 自定义框架 | 无标准框架，无覆盖率，无 CI |

---

## 2. 具体问题清单

### 🔴 P0 — 必须解决才能做自动化测试

#### P0-1: 无依赖注入，模块间强耦合

所有模块通过顶层 `require()` 直接引用，无法替换为 mock 实现。

```js
// feishu.js — 每次调用发真实 HTTP 请求
const axios = require('axios');

// process-manager.js — 直接 require db, feishu, security
const { sendTextMessage } = require('./feishu');
const { filterSensitive, confirmDangerousAction } = require('./security');
```

**影响**: 任何测试只要触发 `sendTextMessage` 就会真正调用飞书 API，无法离线运行。

**建议方案**: 引入依赖注入模式或 `jest.mock()` 级别的模块替换。

#### P0-2: `spawnAgent()` 产生真实子进程

`process-manager.js:49` 通过 `spawn('claude', ...)` 启动真实 Claude CLI 进程。这导致：

- 测试需要在 CI 环境中安装 Claude CLI
- 每次 spawn 消耗 API 额度
- 超时机制（5分钟）使测试极慢

**影响**: 20 个跨域场景全部涉及 agent 调用，不经 mock 无法自动化。

**建议方案**: 将 agent 调用层抽象为可替换策略（真实调用 / mock 返回 / 录制回放）。

#### P0-3: SQLite 使用固定文件路径

`db.js:5` 硬编码 `.data/bot.db`，测试与开发环境共用数据库：

```js
const DB_PATH = path.join(__dirname, '..', '.data', 'bot.db');
```

**影响**: 测试数据污染生产数据，并发测试冲突，无法清理。

**建议方案**: 提供 `:memory:` 模式，支持 `init(':memory:')` 或在测试中注入 DB 路径。

### 🟡 P1 — 需要解决以保证测试质量和效率

#### P1-1: 无标准测试框架

当前使用自定义 `assert()` 函数（`test/integration.test.js:16`），不具备：

- 测试报告和格式化输出
- 覆盖率收集
- describe/it/beforeEach 组织
- 快照测试
- mock/stub 工具

#### P1-2: `process.env` 分散在多个模块

| 模块 | 依赖的环境变量 |
|------|---------------|
| `feishu.js` | `APP_ID`, `APP_SECRET` |
| `router.js` | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` |
| `index.js` | `FEISHU_CHAT_ID`, `PORT` |
| `security.js` | `APP_SECRET`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` |

测试需要手动管理环境变量，容易遗漏。

#### P1-3: 全局状态残留

- `feishu.js`: `let token = null; let tokenExpiry = 0` — 全局 token 缓存
- `process-manager.js`: `activeProcesses = new Map()` — 全局进程表
- `heartbeat.js`: `this.tasks = new Map()` — 全局心跳任务表
- `db.js`: `let db` — 全局 DB 实例

测试间共享状态，不清理会导致交叉污染。

#### P1-4: Express 路由与业务逻辑耦合

`index.js` 中 Webhook 处理函数直接调用所有业务模块，没有 Controller → Service 分层。

#### P1-5: `context.js` 的时间敏感性

`buildContext()` 依赖 `db.getRecentMessages()` 的时间顺序，测试需要精准的消息时间线。当前没有提供时间桩（time stub）机制。

### 🟢 P2 — 可优化但非阻塞

#### P2-1: 错误处理路径不可见

- `feishu.js` 中 `sendTextMessage` 的 catch 只 `console.error`，不返回错误
- `process-manager.js` 中子进程错误通过 `sendTextMessage` 异步通知，主流程无法感知

#### P2-2: 没有请求 ID 或追踪链

消息处理流程（`index.js` → `routeMessage` → `getOrSpawnAgent` → `spawnAgent`）没有贯穿的 trace ID，测试断言困难。

---

## 3. 跨域 E2E 场景的可测试性分析

对照 `qa-cross-domain-integration.md` 的 20 个场景，逐场景评估自动化可行性：

| 场景 | 可自动化? | 阻碍因素 |
|------|-----------|---------|
| E2E-01 模型全生命周期 | ⚠️ 部分 | 需要 Agent mock + 飞书 API mock |
| E2E-02 CI/CD 核心链路 | ⚠️ 部分 | 同上，外加 git 操作需要 sandbox |
| E2E-03 调度与监控 | ⚠️ 部分 | 需要 Agent mock + 时间控制 |
| E2E-04 可观测性 | ⚠️ 部分 | 需要 Agent mock |
| E2E-05 安全合规 | 🟢 可自动 | 纯逻辑层，可 mock 外部调用 |
| E2E-06 多集群资源管理 | ⚠️ 部分 | 需要 Agent mock |
| E2E-07 成本与额度 | 🟢 可自动 | 纯逻辑层，可 mock 外部调用 |
| E2E-08 ~ E2E-20 | ⚠️ 部分 | 核心障碍一致：Agent + Feishu API |

**结论**: 在不解决 P0 问题的情况下，**0 个跨域场景可完全自动化**。优先解决 P0-1 和 P0-2 后，约 8 个场景可完全自动化，其余需要 Agent mock 层配合。

---

## 4. 按模块的可测试性细项

### 4.1 Router (`src/router.js`)

| 函数 | 可测试性 | 问题 |
|------|---------|------|
| `parseAtMentions()` | ✅ 高 | 纯函数，输入输出明确 |
| `hasTaskIntent()` | ✅ 高 | 纯函数，关键词匹配 |
| `determineEventType()` | ✅ 高 | 纯函数 |
| `classifyByKeywords()` | ✅ 高 | 纯函数 |
| `routeMessage()` | ✅ 高 | 纯函数 |
| `classifyIntent()` | 🔴 低 | 依赖 Anthropic SDK 真实 API 调用 |

### 4.2 Database (`src/db.js`)

| 函数 | 可测试性 | 问题 |
|------|---------|------|
| `init()` | ⚠️ 中 | 固定路径，无 :memory: 模式 |
| CRUD 操作 | ⚠️ 中 | 依赖 `init()` 后的全局 db 实例 |
| `acquireLock()` | ⚠️ 中 | 依赖时间戳，无时间桩 |

### 4.3 Feishu (`src/feishu.js`)

| 函数 | 可测试性 | 问题 |
|------|---------|------|
| `getAccessToken()` | 🔴 低 | 真实 OAuth 请求，全局 token 缓存 |
| `sendTextMessage()` | 🔴 低 | 真实 HTTP POST |
| `sendCardMessage()` | 🔴 低 | 真实 HTTP POST |
| `replyToMessage()` | 🔴 低 | 内部调用 `sendTextMessage` |

### 4.4 Security (`src/security.js`)

| 函数 | 可测试性 | 问题 |
|------|---------|------|
| `isDangerous()` | ✅ 高 | 纯函数 |
| `isWhiteListed()` | ✅ 高 | 纯函数 |
| `redactSecrets()` | ✅ 高 | 纯函数 |
| `filterSensitive()` | ⚠️ 中 | 依赖 `process.env` |

### 4.5 Process Manager (`src/process-manager.js`)

| 函数 | 可测试性 | 问题 |
|------|---------|------|
| `buildFullPrompt()` | ⚠️ 中 | 依赖 context 和 db（间接耦合） |
| `spawnAgent()` | 🔴 低 | spawn 真实子进程 |
| `ensureSession()` | ⚠️ 中 | 依赖 db |
| `healthCheck()` | ⚠️ 中 | 依赖 activeProcesses 全局状态 |

### 4.6 Context (`src/context.js`)

| 函数 | 可测试性 | 问题 |
|------|---------|------|
| `buildContext()` | ⚠️ 中 | 依赖 db 消息记录，时间敏感 |
| `summarizeWarm()` | ✅ 高 | 纯函数 |
| `summarizeCold()` | ✅ 高 | 纯函数 |

### 4.7 Tasks (`src/tasks.js`)

| 函数 | 可测试性 | 问题 |
|------|---------|------|
| `parseTaskCommand()` | ✅ 高 | 纯函数 |
| `processTaskCommand()` | ⚠️ 中 | 依赖 db createTask |
| `formatTaskBoard()` | ⚠️ 中 | 依赖 db getTasks |
| `autoClaimTask()` | ⚠️ 中 | 依赖 db getReadyTasks |

### 4.8 Heartbeat (`src/heartbeat.js`)

| 函数 | 可测试性 | 问题 |
|------|---------|------|
| 全部 | ⚠️ 中 | 全局 Map 状态，需要手动清理 |

---

## 5. 建议修复优先级

### Phase A（测试框架搭建前完成）

1. **DB 支持 `:memory:` 模式** — `db.init(':memory:')` — 半天
2. **feishu.js 可 mock** — 通过 jest.mock 或依赖注入 — 即时生效（不修改代码即可用工具）
3. **jest 配置 + 基础 setup** — 替代自定义 assert — 半天

### Phase B（E2E 测试前完成）

4. **Agent 调用层抽象** — Strategy 模式，支持 MockAgent — 1 天
5. **全局状态清理机制** — 每个测试 afterEach 重置 — 半天
6. **环境变量集中管理** — 测试用 `.env.test` + jest setupFiles — 半天

### Phase C（性能优化）

7. **时间桩机制** — 支持 Date.now() mock — 配合 jest.useFakeTimers
8. **Trace ID** — 贯穿请求链路的请求标识 — 新功能开发时引入

---

**下一份输出**: 根据此评估结果，设计测试框架架构（第 1 项）和测试数据管理方案（第 2 项）。
