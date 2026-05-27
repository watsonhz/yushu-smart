# 禹枢大模型管理平台 (yushu-smart) — 方案设计书

## 项目概述

禹枢大模型管理平台是一个基于飞书群聊的多角色自治 AI 团队系统。通过 Express 服务器接收飞书 Webhook 消息，将消息路由给 8 个 AI 角色（CEO、PM、Architect、Backend、Frontend、QA、Reviewer、Tester），各角色由 Claude Code CLI 子进程驱动，支持 AI 推理服务的调度部署。

**模型后端:** DeepSeek v4-pro / v4-flash（Anthropic 兼容接口）

---

## 系统架构

```
飞书群聊 → Webhook → Express Server (localhost:3032)
                           │
              ┌────────────┼────────────┐
              │      Message Router     │
              │  · @mention 解析        │
              │  · API 意图分类         │
              │  · 关键词降级           │
              └────────────┼────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
    ┌────▼────┐      ┌────▼────┐      ┌────▼────┐
    │  CEO    │      │   PM    │      │  Arch   │  ← lazy-start
    │ claude  │      │ claude  │      │ claude  │    10min idle recycle
    └────┬────┘      └────┬────┘      └────┬────┘
         │                │                │
    ┌────▼─────────────────▼────────────────▼────┐
    │              SQLite (bot.db)                │
    │  messages / tasks / sessions / locks       │
    │  + WP1 调度引擎 / WP4 部署服务             │
    └────────────────────┬───────────────────────┘
                         │
    ┌────────────────────▼───────────────────────┐
    │           WP1 调度引擎 (Scheduler)          │
    │  · 资源池/节点管理 · 任务调度 FIFO/公平/优先级│
    │  · GPU 拓扑感知 · Volcano Job 模拟          │
    └────────────────────┬───────────────────────┘
                         │
    ┌────────────────────▼───────────────────────┐
    │           WP4 交付与部署                    │
    │  · 推理服务一键部署 · 多环境管理            │
    │  · 扩缩容策略 · 流量规则(金丝雀/蓝绿)       │
    │  · 部署版本与回滚 · API 凭据管理            │
    └────────────────────────────────────────────┘
```

---

## 8 个团队角色

| 角色 | Key | Emoji | 职责 | 触发词 |
|------|-----|-------|------|--------|
| CEO | `ceo` | 👔 | 统筹协调、决策拍板、资源分配 | @CEO、@决策 |
| PM | `pm` | 📋 | 需求分析、任务拆解、进度跟踪 | @PM、@需求 |
| Architect | `architect` | 🏗️ | 系统架构设计、技术选型 | @架构师、@架构 |
| Backend Developer | `backend` | ⚙️ | 后端开发、API 设计、数据库 | @后端、@backend |
| Frontend Developer | `frontend` | 🎨 | 前端开发、UI 实现、交互设计 | @前端、@frontend |
| QA Engineer | `qa` | 🔍 | 质量保障、测试用例设计 | @QA、@测试 |
| Code Reviewer | `reviewer` | 👁️ | 代码审查、安全审计 | @审查、@review |
| Test Engineer | `tester` | 🧪 | 自动化测试、单元测试 | @测试工程师 |

---

## 消息路由

```
用户消息
  ├── @mention 显式提及 → 直接路由到指定角色
  ├── 无 @mention → API 意图分类（DeepSeek v4-flash）
  │     └── 失败降级 → 关键词匹配
  └── 无匹配 → 回退到通用助手
```

### 事件类型
- **Discussion** — 闲聊、提问
- **Task** — 包含任务动词（做/实现/开发/build/implement 等）
- **System** — `/status`、`/board`、危险确认回复

---

## 进程管理

### Lazy Start + Idle Recycle
- 角色仅在被 @或匹配到时启动子进程
- 空闲 10 分钟 → 进程退出，状态标记为 recycled
- 健康检查每 30 秒运行一次

### 安全机制
- **Chat Lock** — 同一群聊同时只处理一条消息
- **文件锁** — 按 holder 验证身份后释放
- **危险命令检测** — rm -rf、git push --force 等 8 种模式
- **密钥遮盖** — API Key / Secret 自动脱敏
- **Prompt stdin 管道** — 防止命令行参数注入

---

## 数据持久化 (SQLite WAL)

### 核心表
| 表 | 说明 |
|----|------|
| `messages` | 聊天消息记录 |
| `sessions` | 角色会话状态（idle/running/crashed） |
| `tasks` | 用户任务看板 |
| `locks` | 分布式文件锁 |

### WP1 调度引擎表
| 表 | 说明 |
|----|------|
| `resource_pools` | 资源池（FIFO/公平/优先级策略） |
| `pool_queues` | 多级队列 |
| `nodes` | 计算节点 |
| `gpu_devices` | GPU 设备 |
| `tasks_schedule` | 调度任务 |
| `task_specs` | 任务规格（GPU/CPU/内存） |
| `task_events` | 任务事件流 |
| `audit_events` | 审计日志（SHA256 哈希链） |
| `cost_records` | 费用记录 |

### WP4 部署表
| 表 | 说明 |
|----|------|
| `deployment_environments` | 多环境（dev/staging/prod） |
| `inference_services` | 推理服务 |
| `deployment_revisions` | 部署版本历史 |
| `api_credentials` | API 凭据（scrypt 哈希存储） |
| `scaling_policies` | 自动扩缩容策略 |
| `traffic_rules` | 流量规则（金丝雀/蓝绿/镜像） |
| `deployment_pipelines` | 部署流水线 |

---

## API 端点（26 个）

### 基础
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 管理仪表盘 |
| GET | `/health` | 系统健康检查 |
| GET | `/health/roles` | 团队角色列表 |

### WP1.2 资源池与节点
| 方法 | 路径 | 说明 |
|------|------|------|
| POST/GET | `/api/v1/pools` | 资源池管理 |
| GET/PUT/DELETE | `/api/v1/pools/:id` | 单个资源池 |
| POST/GET | `/api/v1/pools/:poolId/nodes` | 节点管理 |
| GET/PUT/DELETE | `/api/v1/nodes/:id` | 单个节点 |
| POST | `/api/v1/nodes/:id/heartbeat` | 节点心跳 |
| POST | `/api/v1/nodes/:id/drain` | 节点排空 |

### WP1.2 任务调度
| 方法 | 路径 | 说明 |
|------|------|------|
| POST/GET | `/api/v1/tasks` | 调度任务管理 |
| GET | `/api/v1/tasks/:id` | 任务详情 |
| POST | `/api/v1/tasks/:id/cancel` | 取消任务 |
| POST | `/api/v1/tasks/:id/priority` | 修改优先级 |
| GET | `/api/v1/queue` | 队列状态 |
| GET/POST | `/api/v1/scheduler/status` `/tick` | 调度器 |

### WP4 交付部署
| 方法 | 路径 | 说明 |
|------|------|------|
| POST/GET | `/api/v1/services` | 推理服务 |
| GET/PUT/DELETE | `/api/v1/services/:id` | 单个服务 |
| POST | `/api/v1/services/:id/rollback` | 服务回滚 |
| POST/GET | `/api/v1/services/:id/credentials` | API 凭据 |
| POST/GET | `/api/v1/services/:id/scaling` | 扩缩容策略 |
| POST/GET | `/api/v1/services/:id/traffic-rules` | 流量规则 |
| GET/POST | `/api/v1/environments` | 环境管理 |

### WP1.3 审计与费用
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/audit-events` | 审计事件查询 |
| GET | `/api/v1/audit-events/export` | CSV 导出 |
| POST | `/api/v1/internal/audit-events` | 写入审计事件 |
| POST/GET | `/api/v1/cost-records` | 费用管理 |
| GET | `/api/v1/cost-records/summary` | 费用汇总 |

---

## 项目结构

```
yushu-smart/
├── index.js                    # Express 主入口
├── public/
│   └── index.html              # 管理仪表盘
├── src/
│   ├── db.js                   # SQLite 数据库核心 + buildUpdate 工具
│   ├── feishu.js               # 飞书 API（Token/消息/卡片）
│   ├── router.js               # 消息路由（@mention/API分类/关键词）
│   ├── roles.js                # 8 角色定义 + System Prompts
│   ├── process-manager.js      # Claude 子进程管理（spawn/超时/健康检查）
│   ├── context.js              # 对话上下文构建（hot/warm/cold）
│   ├── security.js             # 危险检测/密钥过滤/锁管理
│   ├── heartbeat.js            # 进度心跳追踪
│   ├── tasks.js                # 任务命令解析/看板
│   ├── logger.js               # 文件日志模块
│   ├── scheduler.js            # WP1.2 调度引擎核心
│   ├── models-wp1.js           # WP1 数据模型（调度+审计+费用）
│   ├── models-wp4.js           # WP4 数据模型（部署+扩缩容+流量）
│   ├── routes-wp1.js           # WP1 API 路由
│   └── routes-wp4.js           # WP4 API 路由
├── test/
│   ├── integration.test.js     # 集成测试（43 项）
│   ├── wp4.test.js             # WP4 测试（47 项）
│   └── supplement.test.js      # 补充测试（95 项）
├── .data/
│   ├── bot.db                  # SQLite 数据库
│   └── logs/                   # 应用日志
├── docs/                       # 文档与报告
├── package.json
└── .env
```

---

## 依赖

| 包 | 用途 |
|----|------|
| `express` | HTTP 服务器 |
| `better-sqlite3` | SQLite 驱动（WAL 模式） |
| `axios` | 飞书 API HTTP 客户端 |
| `dotenv` | 环境变量 |
| `@anthropic-ai/sdk` | 意图分类 API 调用 |
| Claude Code CLI | 子进程角色推理引擎 |

---

## 安全设计

- **API Secret** — scrypt 哈希存储，仅创建时一次性返回明文
- **错误脱敏** — 所有 500 错误返回通用消息，不泄露内部信息
- **Prompt stdin** — 命令行参数通过 stdin 管道传递，防止注入
- **危险确认** — 8 种高危操作模式检测 + 白名单命令
- **密钥遮盖** — 4 种密钥模式自动脱敏
- **路径限制** — 文件锁仅允许项目目录内操作
- **Chat Lock** — 防止同一群聊并发处理

---

## 非目标

- 多群聊支持（当前单群聊，架构支持扩展）
- 图片/语音消息处理
- 云端部署（本地运行）
- Vercel/Serverless 部署

---

*文档更新时间: 2026-05-27 · Phase 4 · v4.0.0*
