# 技术方案：统一审计日志

> 作者: 架构师
> 日期: 2026-05-25
> 状态: V2 优化
> 关联用户故事: US1.3.1 ~ US1.3.4, US2.2.5, US3.3.1

---

## 1. 技术选型

### 1.1 存储方案

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| **PostgreSQL（独立实例）** | 与业务库隔离、支持事务、查询灵活 | 数据量超 5000 万后查询变慢 | ✅ **MVP 选用** |
| Elasticsearch | 全文搜索强、聚合分析快 | 运维复杂、资源消耗高、写入延迟抖动 | ❌ |
| **ClickHouse** | 列式存储、写入吞吐 10w+/s、压缩比 5~10x、时序聚合极快 | 不支持单行高并发更新、JOIN 较弱 | ✅ **生产选用** |

**决策理由**：
- MVP 阶段审计日志量预估 < 1000 条/天，PostgreSQL 独立实例完全胜任
- 生产阶段选用 **ClickHouse**（而非 ES），因为审计日志是"写多读少+范围聚合"场景，ClickHouse 列式存储天然匹配
- 双写/迁移方案见下方演进路径

### 1.2 存储演进路径

```
MVP (0-3月):     PostgreSQL 独立实例 → 日活 < 1000 条，按月分区
V2 (3-6月):     ClickHouse 为主存储 → PG 仅保留费用流水（合规要求）
V3 (6月+):      ClickHouse + 冷热分层 → 热数据 SSD，冷数据 S3/MinIO
```

ClickHouse 迁移方案：
```
1. Audit Worker 增加 ClickHouse 写入目标（与 PG 双写）
2. 查询接口增加 data_source 参数: pg | clickhouse | auto
3. 逐步灰度切换：10% → 50% → 100% 查询走 ClickHouse
4. ClickHouse 稳定后 PG 审计数据按 TTL 自动清理
```

### 1.2 消息队列方案

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| **异步写入（Redis Streams → PG）** | 不阻塞主业务、削峰填谷 | 最终一致性、丢失窗口极小 | ✅ **选用** |
| 同步写入（直接 INSERT） | 实时性强、实现简单 | 业务请求尾延迟增加 | ❌ |
| 本地文件 + 采集器 (Filebeat) | 完全解耦 | 延迟高、运维复杂 | ❌ |

**决策理由**：审计日志允许秒级延迟，异步写入是最佳选择。Redis Streams 支持 ACK 确认，确保不会丢失。

### 1.4 技术栈

| 组件 | 选型 | 理由 |
|------|------|------|
| 语言/框架 | Go + Gin | 与权限中心统一技术栈 |
| 数据库 | PostgreSQL（独立实例） | |
| 消息队列 | Redis Streams | 与调度引擎共用 Redis |
| 事件采集 | 异步 SDK（各服务嵌入） | 通过 HTTP 或 MQ 上报审计事件 |

---

## 2. 核心数据模型

### 2.1 ER 图 (Mermaid)

```mermaid
erDiagram
    AuditEvent ||--|| Actor : performed_by
    AuditEvent ||--|| Resource : targets

    AuditEvent {
        bigint id PK "自增雪花 ID"
        uuid event_id UK "业务唯一 ID"
        string tenant_id
        string actor_type "user/system"
        string actor_id
        string actor_name
        string resource_type "job/node/quota/role/user/team"
        string resource_id
        string resource_name
        string action "create/update/delete/start/stop/assign/login"
        string result "success/failure"
        jsonb detail "请求详情快照"
        string client_ip
        string user_agent
        jsonb extra "扩展字段"
        timestamp created_at "事件发生时间"
    }

    CostRecord {
        uuid id PK
        uuid tenant_id
        uuid team_id
        uuid task_id
        string task_name
        int gpu_count
        string gpu_model
        int duration_seconds
        decimal unit_price_per_hour
        decimal total_cost
        string billing_mode "per_gpu_hour/per_task"
        decimal discount_rate "0~1, 默认1=无折扣"
        timestamp started_at
        timestamp ended_at
        string status "pending/settled/refunded"
    }
```

### 2.2 核心数据结构

```go
// 审计事件
type AuditEvent struct {
    ID           int64     `json:"id" gorm:"primaryKey;autoIncrement"`
    EventID      string    `json:"event_id" gorm:"type:uuid;uniqueIndex"`
    TenantID     string    `json:"tenant_id" gorm:"type:uuid;index;not null"`
    ActorType    string    `json:"actor_type"`    // user | system
    ActorID      string    `json:"actor_id" gorm:"index;not null"`
    ActorName    string    `json:"actor_name"`
    ResourceType string    `json:"resource_type" gorm:"index"`  // job | node | quota | role | user | team
    ResourceID   string    `json:"resource_id" gorm:"index"`
    ResourceName string    `json:"resource_name"`
    Action       string    `json:"action" gorm:"index"`  // create | update | delete | start | stop
    Result       string    `json:"result"`                // success | failure
    Detail       JSONB     `json:"detail"`                // 操作前后的数据快照
    ClientIP     string    `json:"client_ip"`
    UserAgent    string    `json:"user_agent"`
    Extra        JSONB     `json:"extra"`
    CreatedAt    time.Time `json:"created_at" gorm:"index;not null"`
}

// 费用记录
type CostRecord struct {
    ID               string    `json:"id" gorm:"type:uuid;primaryKey"`
    TenantID         string    `json:"tenant_id" gorm:"type:uuid;index"`
    TeamID           string    `json:"team_id" gorm:"type:uuid;index"`
    TaskID           string    `json:"task_id" gorm:"type:uuid;uniqueIndex"`
    TaskName         string    `json:"task_name"`
    GPUCount         int       `json:"gpu_count"`
    GPUModel         string    `json:"gpu_model"`
    DurationSeconds  int       `json:"duration_seconds"`
    UnitPricePerHour float64   `json:"unit_price_per_hour"`
    TotalCost        float64   `json:"total_cost"`
    StartedAt        time.Time `json:"started_at"`
    EndedAt          time.Time `json:"ended_at"`
    Status           string    `json:"status"` // pending | settled | refunded
}

// 价格配置表
type PriceConfig struct {
    ID              string     `json:"id" gorm:"type:uuid;primaryKey"`
    GPUModel        string     `json:"gpu_model" gorm:"uniqueIndex"` // A100 | A800 | H800
    UnitPrice       float64    `json:"unit_price"`                   // 元/GPU-小时
    BillingMode     string     `json:"billing_mode"`                 // per_gpu_hour
    MinBillingSecs  int        `json:"min_billing_secs"`             // 最小计费秒数(60)
    EffectiveFrom   time.Time  `json:"effective_from"`
    EffectiveTo     *time.Time `json:"effective_to,omitempty"`       // null=当前生效
}
```

### 2.3 审计事件分类

| 分类 | 操作类型 | 示例 |
|------|---------|------|
| 认证 | login, logout, refresh | 用户登录成功/失败 |
| 资源 CRUD | create, update, delete | 创建/修改/删除任务、节点 |
| 权限变更 | assign_role, revoke_role, change_quota | 分配角色、修改配额 |
| 操作执行 | start, stop, restart, preempt | 启动/停止任务、抢占 |
| 系统管理 | node_drain, node_maintenance, config_change | 排空节点、修改配置 |

---

## 3. API 设计

### 3.1 审计日志接口

```
# 查询审计日志（支持筛选 + 分页 + 排序）
GET /api/v1/audit-events
  ?tenant_id=t-tenant01
  &actor_id=u-abc123
  &resource_type=job
  &action=create,delete
  &result=failure
  &start=2026-05-01T00:00:00Z
  &end=2026-05-25T23:59:59Z
  &page=1
  &page_size=50
  &sort=created_at desc

# 查询单条审计事件详情
GET /api/v1/audit-events/:id

# 导出审计日志 (CSV)
GET /api/v1/audit-events/export
  ?tenant_id=t-tenant01
  &start=2026-05-01T00:00:00Z
  &end=2026-05-25T23:59:59Z
```

### 3.2 费用流水接口

```
# 查询团队费用流水
GET /api/v1/cost-records
  ?team_id=tm-001
  &start=2026-05-01T00:00:00Z
  &end=2026-05-25T23:59:59Z
  &page=1
  &page_size=50

# 费用汇总（按团队/时间聚合）
GET /api/v1/cost-records/summary
  ?tenant_id=t-tenant01
  &group_by=team
  &start=2026-05-01T00:00:00Z
  &end=2026-05-25T23:59:59Z

# 导出费用报表 (CSV)
GET /api/v1/cost-records/export
  ?tenant_id=t-tenant01
  &start=2026-05-01T00:00:00Z
  &end=2026-05-25T23:59:59Z
```

### 3.3 内部写入接口

```http
# 内部：写入审计事件（由各业务服务调用）
POST /api/v1/internal/audit-events
Content-Type: application/json
X-Internal-Token: svc-secret-token

{
  "event_id": "evt-unique-001",
  "tenant_id": "t-tenant01",
  "actor_type": "user",
  "actor_id": "u-abc123",
  "actor_name": "张三",
  "resource_type": "job",
  "resource_id": "job-xyz789",
  "resource_name": "bert-finetune-v3",
  "action": "create",
  "result": "success",
  "detail": {
    "before": null,
    "after": {
      "name": "bert-finetune-v3",
      "gpu_count": 4,
      "priority": 50
    }
  },
  "client_ip": "10.0.1.100",
  "user_agent": "feishu-claude-bot/1.0",
  "extra": {"request_id": "req-xxx"}
}

# 响应
{
  "event_id": "evt-unique-001",
  "status": "accepted"
}
```

### 3.4 关键接口响应示例

```http
# 查询审计日志
GET /api/v1/audit-events?tenant_id=t-tenant01&page=1&page_size=10
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...

# 响应
{
  "items": [
    {
      "id": 10001,
      "event_id": "evt-unique-001",
      "actor": {
        "id": "u-abc123",
        "name": "张三",
        "type": "user"
      },
      "resource": {
        "type": "job",
        "id": "job-xyz789",
        "name": "bert-finetune-v3"
      },
      "action": "create",
      "result": "success",
      "created_at": "2026-05-25T10:00:00Z"
    }
  ],
  "total": 1250,
  "page": 1,
  "page_size": 10
}
```

---

## 4. 核心流程

### 4.1 审计事件采集流程

```mermaid
sequenceDiagram
    participant C as 业务服务 (调度/权限)
    participant M as Redis Streams
    participant W as Audit Worker
    participant DB as PostgreSQL (审计独立)
    participant U as 审计员

    C->>C: 1. 业务操作完成
    C->>M: 2. XADD audit:stream {event}
    M-->>C: 3. 返回消息 ID
    W->>M: 4. XREADGROUP 消费事件
    W->>W: 5. 校验 + 丰富（补充 actor 名称等）
    W->>DB: 6. INSERT INTO audit_events
    DB-->>W: 7. OK
    W->>M: 8. XACK 确认消费

    Note over W: 消费失败 → 死信队列 audit:dlq
    Note over C,W: 端到端延迟 < 500ms

    U->>DB: 9. GET /api/v1/audit-events
    DB-->>U: 10. 分页查询结果
```

### 4.2 费用计算流程

```mermaid
sequenceDiagram
    participant S as 调度引擎
    participant A as 审计服务
    participant DB as PostgreSQL

    S->>A: 1. Task 完成事件 (task_id, started_at, completed_at, gpu_count)
    A->>DB: 2. 查询任务单价配置
    A->>A: 3. 计算费用: duration * gpu_count * unit_price
    A->>DB: 4. INSERT cost_record
    A->>DB: 5. 更新配额使用量
    A-->>S: 6. 返回确认

    Note over A: 单价策略: A100 10元/GPU-小时, A800 8元/GPU-小时
    Note over A: 不足1小时按分钟计费, 最小计费单位 1 分钟
```

### 4.3 审计日志防篡改方案

```mermaid
sequenceDiagram
    participant S as 业务服务
    participant A as Audit 服务
    participant DB as PostgreSQL
    participant AR as 归档服务

    S->>A: 1. 上报审计事件
    A->>A: 2. 计算 SHA256(event_data + prev_hash)
    Note over A: hash_chain = SHA256(event_json + prev_event_hash)
    A->>DB: 3. INSERT audit_events + hash 值
    DB-->>A: 4. OK

    Note over A,DB: 每日凌晨归档作业
    AR->>DB: 5. 读取昨日所有事件
    AR->>AR: 6. 校验 hash 链完整性
    AR->>AR: 7. 计算 Merkle 根哈希
    AR->>DB: 8. 写入 daily_merkle_root 表
    AR->>DB: 9. 逾期事件移到 history 分区

    Note over AR: 校验失败 → 触发安全告警
```

```
hash_chain 实现:
  - 每条审计事件记录 prev_event_hash（上一条事件的 hash）
  - hash = SHA256(event_id + timestamp + actor + action + detail + prev_hash)
  - 每日凌晨计算 Merkle 树，根哈希存数据库
  - 定期将 Merkle 根哈希发送到外部存储（如打印到日志、发送到监控系统）
  - 任何中间数据的篡改都会导致后续所有 hash 校验失败
```

### 4.4 审计日志归档策略

| 时间范围 | 存储位置 | 查询性能 | 说明 |
|---------|---------|---------|------|
| 0-90 天 | PostgreSQL 主表 | 毫秒级 | 在线查询 |
| 91-365 天 | PostgreSQL 分区表（按月） | 秒级 | 可查询但较慢 |
| 365 天+ | 归档到对象存储 (S3/MinIO) | 分钟级 | 需恢复后查询 |

### 4.5 计费策略与定价模型

#### 定价标准

| GPU 型号 | 单价（元/GPU-小时） | 适用场景 |
|---------|-------------------|---------|
| NVIDIA A100 80GB | 10.00 | 大模型训练 |
| NVIDIA A800 80GB | 8.00 | 分布式训练 |
| NVIDIA H800 80GB | 25.00 | 高性能训练 |
| 存储 (PVC) | 0.10 元/GB/天 | 数据存储 |

#### 计费规则

```
费用 = 实际使用量 × 单价 × 折扣率

GPU 计费:
  - 按秒计费，向上取整到分钟
  - 最小计费单位: 1 分钟
  - 不足 1 分钟按 1 分钟计
  - 抢占任务免除被抢占段的费用

存储计费:
  - 按天计费（取每日峰值）
  - 最小计费单位: 1 GB/天

折扣体系:
  - 团队包月: 使用量超过 1000 GPU-小时/月，超出部分 9 折
  - 预留资源: 包周 8 折，包月 7 折
  - 教育/科研: 特殊申请折扣（通过 PriceConfig 配置）
```

#### 计费周期

```
实时计费: 任务完成后 5 分钟内生成 CostRecord（status=pending）
日汇总:  每日凌晨 2:00 生成昨日费用汇总快照
月结算:  每月 1 日 00:00 将所有 pending → settled，生成账单
退款:    支持对指定 CostRecord 发起退款（status=refunded），需管理员审批
```

---

## 5. 模块间契约

### 5.1 提供的接口

| 接口 | 协议 | 消费者 | 说明 |
|------|------|--------|------|
| `POST /api/v1/internal/audit-events` | HTTP (内部 Token) | 所有业务服务 | 异步写入审计事件 |
| `GET /api/v1/audit-events` | HTTP (Bearer Token) | 前端 UI | 审计日志查询 |
| `GET /api/v1/audit-events/export` | HTTP (Bearer Token) | 前端 UI | CSV 导出 |
| `GET /api/v1/cost-records/*` | HTTP (Bearer Token) | 前端 UI | 费用管理 |

### 5.2 依赖的接口

| 接口 | 提供方 | 说明 |
|------|-------|------|
| `verify-token` | 权限中心 | 校验操作者身份 |
| `check-permission` | 权限中心 | 校验审计日志查看权限 |
| `POST /task-complete` (webhook) | 调度引擎 | 接收任务完成事件触发计费 |

### 5.3 错误码

| 错误码 | HTTP 状态码 | 说明 |
|--------|------------|------|
| AUDIT_INVALID_EVENT | 400 | 审计事件格式不合法 |
| AUDIT_INTERNAL_ERROR | 500 | 写入失败 |
| AUDIT_EXPORT_TOO_LARGE | 413 | 导出数据量超过限制（> 10 万条） |

---

## 6. 安全考量

1. **审计日志不可篡改**：一旦写入不允许 UPDATE/DELETE，仅支持 INSERT + SELECT
2. **内部接口鉴权**：使用 Service Token（mTLS 或固定密钥），不依赖用户 Token
3. **敏感信息脱敏**：Detail 字段中自动过滤密码/Token 等敏感字段
4. **导出限制**：单次最多导 10 万条，且必须指定时间范围
5. **数据删除合规**：即使删除租户，审计日志保留不可删除

---

## 7. 开发工作量评估

| 模块 | 后端(人天) | 说明 |
|------|-----------|------|
| 审计事件模型与数据库 | 2 | 含分区表策略 |
| 异步消费者 Worker | 2 | Redis Streams 消费 |
| 各业务服务埋点 SDK | 2 | 每个服务嵌入审计 SDK |
| 审计日志查询 API | 2 | 含筛选/分页/排序 |
| CSV 导出功能 | 1 | 流式导出 |
| 费用流水计算 | 3 | 含计费策略引擎 |
| 费用汇总统计 API | 1.5 | |
| **合计** | **13.5** | |
