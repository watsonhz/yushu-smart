# 禹枢大模型管理平台 — 软件著作权登记申请材料

## 一、软件基本信息

| 项目 | 内容 |
|------|------|
| 软件全称 | **禹枢大模型管理平台** |
| 软件简称 | **禹枢智能 (yushu-smart)** |
| 版本号 | **V4.0.0** |
| 软件分类 | 应用软件 — 人工智能管理平台 |
| 开发完成日期 | 2026年5月27日 |
| 首次发表日期 | 2026年5月27日 |
| 发表状态 | 已发表 |
| 发表地点 | 中国·线上（GitHub） |
| 开发方式 | 独立开发 |
| 著作权人 | 个人 |

---

## 二、开发运行环境

| 项目 | 要求 |
|------|------|
| 操作系统 | macOS 14+ / Linux (Ubuntu 20.04+) |
| 运行平台 | Node.js v24.15.0 |
| 数据库 | SQLite 3 (better-sqlite3) |
| 开发语言 | JavaScript (Node.js CommonJS) |
| Web 框架 | Express 4.x |
| 外部依赖 | axios、dotenv、@anthropic-ai/sdk、better-sqlite3 |
| AI 引擎 | Claude Code CLI（DeepSeek v4-pro Anthropic 兼容接口） |
| 消息通道 | 飞书开放平台 API、企业微信机器人 API |
| 隧道服务 | Cloudflare Tunnel（内网穿透） |

---

## 三、软件技术特点

1. **多角色自治团队架构** — 8 个 AI 角色（CEO/PM/架构师/后端/前端/QA/审查员/测试工程师）通过独立子进程运行，支持 @提及和意图分类两种路由方式，实现群聊中的专业化协作。

2. **大模型推理服务管理** — 支持一键部署推理服务到多环境（开发/预发/生产），内置金丝雀发布、蓝绿部署、自动扩缩容策略和部署回滚能力。

3. **统一调度引擎** — 实现 FIFO、公平(DRF)、优先级三种 GPU 任务调度策略，支持 GPU 拓扑感知分配、任务抢占保护和队列状态可视化。

4. **不可篡改审计日志** — 基于 SHA256 哈希链的审计日志系统，每条记录包含前一条记录的哈希值，可通过 API 验证全链完整性。

5. **多通道消息集成** — 同时支持飞书企业即时通讯平台和企业微信（WeCom）平台的消息收发，消息路由逻辑统一处理。

6. **安全防护体系** — 包含：API Secret scrypt 哈希存储、50 处错误信息脱敏、8 种危险命令检测、4 类密钥模式自动遮盖、文件锁/聊天锁并发控制、Prompt 注入防护（stdin 管道传参）。

7. **管理仪表盘** — 内建 Web 管理界面，实时展示系统状态、通道连接、团队角色和 API 端点清单。

---

## 四、技术架构说明

### 4.1 整体架构

禹枢大模型管理平台采用分层模块化架构，由以下核心层级组成：

```
┌─────────────────────────────────────────┐
│              消息接入层                   │
│  飞书 Webhook · 企业微信 Callback        │
├─────────────────────────────────────────┤
│              消息路由层                   │
│  @mention 解析 · API 意图分类 · 关键词    │
├─────────────────────────────────────────┤
│              角色执行层                   │
│  8 角色 Claude Code 子进程 (lazy-start)  │
├─────────────────────────────────────────┤
│              业务逻辑层                   │
│  WP1 调度引擎 · WP4 部署服务 · 审计日志   │
├─────────────────────────────────────────┤
│              数据持久层                   │
│  SQLite WAL (22张表) · 日志文件系统      │
└─────────────────────────────────────────┘
```

### 4.2 核心模块说明

| 模块 | 文件 | 主要功能 |
|------|------|---------|
| 主入口 | `index.js` | Express 服务器启动、Webhook 处理、中间件配置 |
| 消息路由 | `src/router.js` | 消息去重、@mention 解析、API 意图分类、关键词降级 |
| 角色定义 | `src/roles.js` | 8 个团队角色的 System Prompt 与触发词 |
| 进程管理 | `src/process-manager.js` | Claude 子进程生成/超时/健康检查/回收 |
| 上下文管理 | `src/context.js` | hot/warm/cold 三层对话上下文构建 |
| 安全模块 | `src/security.js` | 危险命令检测、密钥遮盖、文件锁、聊天锁 |
| 飞书 API | `src/feishu.js` | Token 管理、文本/卡片消息发送 |
| 企微 API | `src/wecom.js` | 消息收发、签名验证、AES 解密 |
| 调度引擎 | `src/scheduler.js` | FIFO/公平/优先级调度、GPU 拓扑匹配、抢占 |
| 数据模型 | `src/models-wp1.js` | 调度引擎+审计+费用数据操作（540 行） |
| 数据模型 | `src/models-wp4.js` | 部署服务+扩缩容+流量规则（474 行） |
| API 路由 | `src/routes-wp1.js` | WP1 调度与审计 API（26 个端点） |
| API 路由 | `src/routes-wp4.js` | WP4 部署与交付 API |
| 数据库 | `src/db.js` | SQLite 核心操作、buildUpdate 工具函数 |
| 任务系统 | `src/tasks.js` | 任务命令解析、看板格式化 |
| 心跳追踪 | `src/heartbeat.js` | 子进程进度追踪与增量反馈 |
| 日志系统 | `src/logger.js` | 按日滚动的文件日志 |

### 4.3 数据库设计

系统使用 SQLite 数据库（WAL 模式），包含 22 张业务表：

**核心表：** messages（消息记录）、sessions（会话状态）、tasks（任务看板）、locks（分布式锁）

**WP1 调度引擎表：** resource_pools（资源池）、pool_queues（多级队列）、nodes（计算节点）、gpu_devices（GPU 设备）、tasks_schedule（调度任务）、task_specs（任务规格）、task_events（任务事件）

**WP1 审计与费用表：** audit_events（SHA256 哈希链审计日志）、price_configs（GPU 计费价格）、cost_records（费用记录）

**WP4 部署表：** deployment_environments（多环境）、inference_services（推理服务）、deployment_revisions（部署版本）、api_credentials（API 凭据）、scaling_policies（扩缩容策略）、traffic_rules（流量规则）、deployment_pipelines（部署流水线）

---

## 五、软件规模

| 指标 | 数值 |
|------|------|
| 源代码文件数 | 17 |
| 总代码行数 | 约 3,800 行 |
| API 端点数 | 26 |
| 数据库表数 | 22 |
| 自动化测试数 | 185 |
| 支持 AI 角色数 | 8 |
| 支持的即时通讯平台 | 2（飞书 + 企业微信） |
| 调度策略数 | 3（FIFO / 公平 / 优先级） |
| 部署环境数 | 3（开发 / 预发 / 生产） |

---

## 六、申请材料清单

根据中国版权保护中心要求，本次申请提交以下材料：

| 序号 | 材料名称 | 说明 |
|------|---------|------|
| 1 | 计算机软件著作权登记申请表 | 在线填写提交 |
| 2 | 软件鉴别材料 — 用户操作手册 | 见 [MANUAL.md](MANUAL.md) |
| 3 | 软件鉴别材料 — 源代码文档 | 源程序前 30 页 + 后 30 页 |
| 4 | 申请人身份证明 | 身份证复印件 |
| 5 | 权利归属证明 | 独立开发声明 |

---

## 七、源代码提取说明

源代码文档应提取项目 `src/` 和 `index.js` 目录下的全部 JavaScript 文件，共计 17 个文件、约 3,800 行代码。按文件名字母顺序排列，每页 50 行，提取前 30 页（约 1,500 行）和后 30 页（约最后 1,500 行）提交。

**源代码文件清单（17 个文件）：**

```
index.js                    （主入口，~237 行）
src/context.js              （上下文管理，~34 行）
src/db.js                   （数据库层，~220 行）
src/feishu.js               （飞书 API，~76 行）
src/heartbeat.js            （心跳追踪，~65 行）
src/logger.js               （日志模块，~48 行）
src/models-wp1.js           （WP1 数据模型，~540 行）
src/models-wp4.js           （WP4 数据模型，~474 行）
src/process-manager.js      （进程管理，~210 行）
src/roles.js                （角色定义，~160 行）
src/router.js               （消息路由，~177 行）
src/routes-wp1.js           （WP1 路由，~483 行）
src/routes-wp4.js           （WP4 路由，~343 行）
src/scheduler.js            （调度引擎，~278 行）
src/security.js             （安全模块，~120 行）
src/tasks.js                （任务系统，~98 行）
src/wecom.js                （企业微信 API，~81 行）
```

---

## 八、独立开发声明

本人独立开发完成了"禹枢大模型管理平台 V4.0.0"的全部功能，拥有该软件的完整著作权。项目开发过程中使用的第三方开源库均遵循其各自的开源许可协议（ISC、MIT），包括：

- express（MIT License）
- better-sqlite3（MIT License）
- axios（MIT License）
- dotenv（BSD-2-Clause License）
- @anthropic-ai/sdk（MIT License）

上述第三方组件不纳入本次著作权登记范围。

---

*材料整理日期: 2026年5月27日*
