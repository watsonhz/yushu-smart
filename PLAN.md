# 禹枢大模型管理平台 (yushu-smart) — 计划书

## 项目里程碑

| 阶段 | 状态 | 内容 |
|------|------|------|
| Phase 1 | ✅ 完成 | 单角色飞书 Claude 机器人 |
| Phase 2 | ✅ 完成 | 8 角色自治团队 + 消息路由 |
| Phase 3 | ✅ 完成 | WP1.2 调度引擎 + WP1.3 审计/费用 |
| Phase 4 | ✅ 完成 | WP4 交付部署 + 安全加固 + 管理仪表盘 |
| Phase 5 | 🔜 规划中 | 多群聊支持、持久化会话恢复、性能监控 |

---

## 已完成事项

### 核心架构
- [x] Express Webhook 服务器（端口 3032）
- [x] 飞书消息接收与异步处理（<3s 返回 200）
- [x] 消息去重（message_id）
- [x] JSON 解析错误优雅处理

### 消息路由
- [x] @mention 显式路由（支持中文角色名）
- [x] API 意图分类（DeepSeek v4-flash）
- [x] 关键词匹配降级
- [x] 默认回退到通用助手

### 8 角色团队
- [x] CEO / PM / Architect / Backend / Frontend / QA / Reviewer / Tester
- [x] 各角色独立 System Prompt（中文）
- [x] 关键词触发 + API 智能分类
- [x] 统一角色 Key（backend / frontend）

### 进程管理
- [x] Claude Code CLI 子进程管理
- [x] Lazy-start（按需启动）
- [x] Idle recycle（10 分钟空闲回收）
- [x] 5 分钟超时保护
- [x] stdin 管道传参（防注入）
- [x] 模型名环境变量化（`CLAUDE_MODEL`）
- [x] 崩溃恢复与进程清理

### 安全机制
- [x] API Secret scrypt 哈希存储
- [x] 50 处 API 错误信息脱敏
- [x] 危险命令检测（8 种模式）
- [x] 白名单安全命令
- [x] 密钥自动遮盖
- [x] 文件锁 + Chat Lock
- [x] releaseAllLocks 按 holder 释放
- [x] 错误日志替代空 `.catch()`

### 数据持久化
- [x] SQLite WAL 模式
- [x] messages / sessions / tasks / locks 表
- [x] 22 张 WP1/WP4 数据表
- [x] 文件日志模块（`.data/logs/`）

### WP1.2 调度引擎
- [x] 资源池管理（FIFO / 公平(DRF) / 优先级）
- [x] 节点注册与心跳
- [x] GPU 设备追踪
- [x] 任务调度与事件流
- [x] 队列状态与调度器控制
- [x] 调度策略参数验证
- [x] 抢占机制（优先级补偿 +20，日上限 3 次）

### WP1.3 审计与费用
- [x] SHA256 哈希链审计日志
- [x] 审计事件查询与 CSV 导出
- [x] 内部审计写入（Internal Token 鉴权）
- [x] 哈希链完整性校验
- [x] 费用计算与汇总

### WP4 交付部署
- [x] 多环境管理（dev/staging/prod）
- [x] 推理服务一键部署（事务组合操作）
- [x] 部署版本历史与回滚
- [x] API 凭据管理（scrypt 哈希）
- [x] 金丝雀/蓝绿/镜像流量规则
- [x] 自动扩缩容策略
- [x] 部署流水线记录

### 管理仪表盘
- [x] 系统状态卡片（Phase / 版本 / 模型 / 进程）
- [x] 8 角色展示
- [x] API 端点列表
- [x] 10 秒自动刷新

### 日志
- [x] 文件日志模块（按日滚动）
- [x] LOG_LEVEL 环境变量控制
- [x] stderr/stdout 分级输出

### 测试
- [x] 集成测试（43 项全部通过）
- [x] WP4 测试（47 项全部通过）
- [x] 补充测试（95 项全部通过）
- [x] 总计 185 个自动化测试

### CSV 导出
- [x] 审计事件导出
- [x] 费用记录导出
- [x] 字段转义（双引号/逗号/换行）

---

## 待规划事项

### 短期（Phase 5）
- [ ] 多群聊支持
- [ ] `--resume` 持久化会话恢复
- [ ] 速率限制（express-rate-limit）
- [ ] 请求日志中间件（morgan）
- [ ] 数据库定期备份自动化
- [ ] 健康检查增强（DB 连接状态检查）

### 中期
- [ ] WebSocket 实时状态推送
- [ ] 任务执行结果缓存
- [ ] 飞书卡片消息按钮交互
- [ ] 角色对话历史可视化
- [ ] GPU 利用率实时监控面板

### 长期
- [ ] K8s 集成（Volcano Job 真实调度）
- [ ] 多租户隔离
- [ ] Grafana 监控集成
- [ ] Slack/Discord 多平台支持

---

## 技术债务

| 优先级 | 项目 | 说明 |
|--------|------|------|
| P2 | 分布式锁阻塞等待 | `acquireLock` 无重试机制 |
| P2 | `sendTextMessage` 飞书 API 无重试 | 网络抖动时消息丢失 |
| P3 | scheduler `default` pool 无匹配 | 未配置 pool 的任务调度异常 |
| P3 | node 操作缺少存在性检查 | PUT/POST 部分端点未验证资源存在 |

---

## 技术栈

| 层 | 技术 |
|----|------|
| 运行时 | Node.js v24 |
| Web 框架 | Express 4.x |
| 数据库 | SQLite (better-sqlite3, WAL) |
| AI 模型 | DeepSeek v4-pro / v4-flash（Anthropic 兼容） |
| AI 引擎 | Claude Code CLI |
| 消息平台 | 飞书开放平台 |
| 认证 | API Key + Secret（scrypt 哈希） |
| 审计 | SHA256 哈希链 |
| 测试 | 手动 assert（185 项） |
| 模块系统 | CommonJS |

---

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3000` |
| `APP_ID` | 飞书应用 ID | — |
| `APP_SECRET` | 飞书应用密钥 | — |
| `FEISHU_CHAT_ID` | 飞书群聊 ID | — |
| `ANTHROPIC_API_KEY` | API 密钥 | — |
| `ANTHROPIC_BASE_URL` | API 地址 | `https://api.deepseek.com/anthropic` |
| `CLAUDE_MODEL` | Claude 模型 | `sonnet` |
| `LOG_LEVEL` | 日志级别 | `info` |
| `INTERNAL_TOKEN` | 内部 API 鉴权 | — |

---

*计划更新时间: 2026-05-27 · Phase 4 · v4.0.0*
