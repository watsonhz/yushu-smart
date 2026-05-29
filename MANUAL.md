# 禹枢大模型管理平台 (yushu-smart) — 使用手册

## 一、产品概述

禹枢大模型管理平台是一套基于飞书/企业微信群聊的多角色自治 AI 团队系统。系统将 8 个专业 AI 角色（CEO、PM、架构师、后端工程师、前端工程师、QA、代码审查员、测试工程师）接入群聊，用户通过 @角色名 即可与对应专家交互。同时提供大模型推理服务的一键部署、资源池调度、审计日志等企业级管理功能。

**适用场景：** 软件开发团队协作、大模型推理服务管理、GPU 资源调度

---

## 二、环境要求

| 项目 | 最低要求 |
|------|---------|
| 操作系统 | macOS / Linux |
| Node.js | v18+ |
| 包管理器 | npm |
| 硬件 | 2GB 内存，1GB 磁盘空间 |
| 网络 | 需能访问 DeepSeek API 和飞书/企微开放平台 |
| 额外依赖 | Claude Code CLI（已安装并配置） |

---

## 三、安装部署

### 3.1 下载项目

```bash
git clone https://github.com/watsonhz/yushu-smart.git
cd yushu-smart
npm install
```

### 3.2 配置环境变量

编辑项目根目录下的 `.env` 文件：

```env
# 服务端口（默认 3000）
PORT=3032

# 飞书应用凭证（从飞书开放平台获取）
APP_ID="cli_xxxxxxxxxxxxx"
APP_SECRET="xxxxxxxxxxxxxxxxxxxx"
FEISHU_CHAT_ID="oc_xxxxxxxxxxxxxxxx"

# Claude API Key（DeepSeek 兼容接口）
ANTHROPIC_API_KEY="sk-xxxxxxxxxxxxxxxxxxxx"

# Claude 模型选择（默认 sonnet）
CLAUDE_MODEL="sonnet"

# 日志级别（debug / info / warn / error）
LOG_LEVEL="info"

# 内部 API 鉴权 Token（用于审计日志写入）
INTERNAL_TOKEN=""

# 企业微信机器人配置（可选，不填则仅启用飞书）
WECOM_WEBHOOK_URL=""
WECOM_BOT_TOKEN=""
WECOM_BOT_ENCODING_AES_KEY=""
```

### 3.3 启动服务

```bash
npm start
```

启动后终端显示：
```
禹枢大模型管理平台 (yushu-smart): http://localhost:3032/health
```

访问 `http://localhost:3032` 即可看到管理仪表盘。

---

## 四、通道配置

### 4.1 飞书通道

1. 登录 [飞书开放平台](https://open.feishu.cn)
2. 创建自建应用 → 添加"机器人"能力
3. 在"事件订阅"中配置请求网址：
   ```
   https://<隧道域名>/feishu/event
   ```
4. 订阅事件类型：`im.message.receive_v1`
5. 将 `.env` 中的 `APP_ID`、`APP_SECRET` 替换为实际值
6. 重启服务

### 4.2 企业微信通道

1. 登录企业微信管理后台 → 应用管理 → 机器人
2. 创建一个群机器人，获取 Webhook URL
3. 将 `WECOM_WEBHOOK_URL` 填入 `.env`
4. 重启服务

---

## 五、功能说明

### 5.1 群聊多角色交互

在飞书或企业微信群中发送消息，系统会自动路由到最合适的 AI 角色处理。

**直接 @角色名：**
```
@架构师 帮我设计用户认证系统的数据库表结构
@PM 把这个需求拆成几个子任务
@后端 实现登录接口
@审查 帮我检查这段代码的安全问题
```

**自然语言路由（无需 @）：**
```
帮我实现用户注册功能
写一个获取用户列表的 API 接口
审查一下最近的代码变更
```

**系统命令：**
| 命令 | 说明 |
|------|------|
| `/board` 或 `/看板` | 查看任务看板 |
| `/mytasks` 或 `/我的任务` | 查看自己的任务 |
| `/roles` 或 `/团队` | 查看团队角色列表 |
| `/status` 或 `/状态` | 查看系统运行状态 |
| `/task:标题 | 优先级:high | 负责人: backend` | 创建新任务 |

### 5.2 管理仪表盘

访问 `http://localhost:3032` 可查看：
- 系统运行状态（阶段、版本、模型、活跃进程）
- 飞书/企微通道连接状态
- 8 个团队角色及其职责
- 26 个 API 端点列表
- 页面每 10 秒自动刷新

### 5.3 资源池管理 API

```
POST /api/v1/pools                   创建资源池
GET  /api/v1/pools                   查询资源池列表
GET  /api/v1/pools/:id               查询资源池详情
PUT  /api/v1/pools/:id               更新资源池
DELETE /api/v1/pools/:id             删除资源池（无活跃节点时）
```

**支持的调度策略：** `fifo`（先入先出）、`fair`（公平调度）、`priority`（优先级）

### 5.4 节点管理 API

```
POST /api/v1/pools/:poolId/nodes     注册计算节点
GET  /api/v1/pools/:poolId/nodes     查询节点列表
GET  /api/v1/nodes/:id              查询节点详情（含 GPU 信息）
PUT  /api/v1/nodes/:id              更新节点状态
DELETE /api/v1/nodes/:id            删除节点
POST /api/v1/nodes/:id/heartbeat    节点心跳上报
POST /api/v1/nodes/:id/drain        节点排空
```

### 5.5 任务调度 API

```
POST /api/v1/tasks                   创建调度任务
GET  /api/v1/tasks                   查询任务列表
GET  /api/v1/tasks/:id              查询任务详情（含规格和事件）
POST /api/v1/tasks/:id/cancel       取消任务
POST /api/v1/tasks/:id/priority     修改任务优先级（0-100）
GET  /api/v1/tasks/:id/events       查询任务事件流
GET  /api/v1/queue                  查看调度队列状态
GET  /api/v1/scheduler/status       查看调度器运行状态
POST /api/v1/scheduler/tick         手动触发调度周期
```

### 5.6 推理服务部署 API

```
POST /api/v1/services                一键部署推理服务
GET  /api/v1/services                查询推理服务列表
GET  /api/v1/services/:id            查询服务详情
PUT  /api/v1/services/:id            更新服务配置
DELETE /api/v1/services/:id          删除服务
POST /api/v1/services/:id/rollback   服务版本回滚
GET  /api/v1/services/:id/revisions  查看部署版本历史
```

### 5.7 审计与费用

```
GET  /api/v1/audit-events           审计事件查询（分页）
GET  /api/v1/audit-events/:id       审计事件详情
GET  /api/v1/audit-events/export    CSV 导出审计事件
GET  /api/v1/audit/verify           哈希链完整性校验
POST /api/v1/cost-records           创建费用记录
GET  /api/v1/cost-records           查询费用记录
GET  /api/v1/cost-records/summary   费用汇总
GET  /api/v1/cost-records/export    CSV 导出费用记录
```

---

## 六、安全说明

- **凭据保护**：API Secret 使用 scrypt 哈希存储，仅在创建时一次性返回明文
- **错误脱敏**：所有 API 错误返回通用消息，不暴露内部实现
- **危险操作拦截**：自动检测 rm -rf、DROP TABLE 等 8 种危险操作
- **密钥遮盖**：运行时自动过滤 ANTHROPIC_API_KEY、APP_SECRET 等敏感信息
- **文件锁**：多角色并发写入时通过数据库锁机制保证安全

---

## 七、故障排查

| 问题 | 解决方案 |
|------|---------|
| 端口被占用 | `lsof -ti :3032 \| xargs kill` 后重启 |
| 飞书消息无响应 | 检查飞书开放平台回调地址是否匹配隧道 URL |
| 企微消息无响应 | 确认 `WECOM_WEBHOOK_URL` 配置正确 |
| Claude 进程超时 | 5 分钟超时自动终止，可简化任务后重试 |
| 隧道断开 | 隧道随机域名重启后需更新飞书回调地址 |
| 数据库损坏 | 服务启动自动执行 `PRAGMA integrity_check` |

---

## 八、命令行参考

```bash
# 启动服务
node index.js

# 查看健康状态
curl http://localhost:3032/health

# 创建资源池
curl -X POST http://localhost:3032/api/v1/pools \
  -H "Content-Type: application/json" \
  -d '{"name":"gpu-cluster-1","scheduler_policy":"priority"}'

# 一键部署推理服务
curl -X POST http://localhost:3032/api/v1/services \
  -H "Content-Type: application/json" \
  -d '{"name":"llama-service","env_id":"env-prod","model_name":"llama-3-70b","model_version":"v1.0"}'

# 运行测试套件
npm test
```

---

*文档版本: v4.0.0 · 更新日期: 2026-05-27*
