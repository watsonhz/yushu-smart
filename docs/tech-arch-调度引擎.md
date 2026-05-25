# 技术方案：统一调度引擎

> 作者: 架构师
> 日期: 2026-05-25（V2 优化）
> 状态: 定稿
> 关联用户故事: US1.2.1 ~ US1.2.5

---

## 1. 技术选型

### 1.1 调度架构选型

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| K8s Native (Kueue / Volcano) | 生态成熟、与 K8s 深度集成、社区活跃 | 学习曲线陡、定制抢占策略困难、K8s 版本依赖 | ⚠️ **候选** |
| 自研调度器 + K8s 资源管理 | 灵活可控、可定制任意调度策略、轻量 | 重复造轮子、需自行管理资源生命周期 | ❌ |
| **K8s + Volcano 增强调度** | 原生 GPU 调度、支持 gang-scheduling、优先级队列、公平调度 | Volcano CRD 有学习成本 | ✅ **选用** |

**决策理由**：
- Volcano 是 CNCF 毕业项目，专为 AI/ML 负载设计，原生支持 GPU 调度、gang scheduling（All-or-Nothing）、优先级队列和公平调度
- 团队无需从零构建资源管理，利用 K8s 的 node/pod 管理能力
- 自定义策略通过 Volcano 的 Action/Plugin 机制扩展，满足 P1/P2 需求
- 与现有 K8s 生态（监控、日志、网络）无缝集成

### 1.2 队列与存储

| 组件 | 选型 | 理由 |
|------|------|------|
| 任务队列 | Redis Streams | 支持消费者组、消息持久化、ACK 机制、延迟队列 |
| 任务元数据 | PostgreSQL | 与权限中心共用数据库、事务支持 |
| 任务状态缓存 | Redis | 快速查询排队/运行状态 |
| 调度器锁 | Redis Redlock | 调度器高可用 Leader Election |
| 镜像仓库 | Harbor (内部) | 训练镜像管理 |

### 1.3 资源抽象层

```
物理资源：
  Host GPU (NVIDIA A100/A800/H800)
      ├── GPU Memory (显存)
      ├── GPU Cores (CUDA Core/Tensor Core)
      └── GPU Link (NVLink/NVSwitch)

逻辑资源池：
  Pool ─── 一组具有相同标签的 GPU 节点
      ├── Queue ─── 按团队/优先级划分的子队列
      ├── Node ─── 物理/虚拟 GPU 节点
      │   ├── GPU Device ─── 单个 GPU 卡
      │   └── GPU Fragment ─── GPU 显存分片（MIG / 时间片）
      └── Quota ─── 团队资源配额上限
```

---

## 2. 核心数据模型

### 2.1 ER 图

```mermaid
erDiagram
    ResourcePool ||--o{ Node : contains
    ResourcePool ||--o{ PoolQueue : partitions
    PoolQueue ||--o{ Task : queues
    Node ||--o{ GPUDevice : has
    Task ||--|| TaskSpec : has
    Task ||--o{ TaskEvent : generates

    ResourcePool {
        uuid id PK
        string name
        string scheduler_policy "fifo/fair/priority"
        string status "active/paused"
        jsonb labels "{\"gpu_type\": \"A100\", \"location\": \"机房A\"}"
        timestamp created_at
    }

    PoolQueue {
        uuid id PK
        uuid pool_id FK
        uuid team_id FK "绑定的团队，null=公共队列"
        int priority_weight "公平调度权重"
        int max_running "最大并发数"
    }

    Node {
        uuid id PK
        uuid pool_id FK
        string hostname UK
        string ip_address
        string status "online/offline/maintenance"
        jsonb specs "{\"gpu_model\":\"A100\",\"gpu_count\":8,\"cpu\":128,\"memory_gb\":1024}"
        jsonb labels
        timestamp last_heartbeat
        timestamp created_at
    }

    GPUDevice {
        uuid id PK
        uuid node_id FK
        int index "0-based GPU index"
        int memory_total_mb
        int memory_used_mb
        string status "free/allocated/error/degraded"
        string topology "NVLink domain info"
    }

    Task {
        uuid id PK
        uuid team_id FK
        uuid user_id FK
        string name
        string type "training/evaluation/serving"
        string status "pending/queued/running/completed/failed/preempted"
        int priority "0-100, default 50"
        int preempt_count "被抢占次数"
        timestamp created_at
        timestamp started_at
        timestamp completed_at
    }

    TaskSpec {
        uuid id PK
        uuid task_id FK
        int gpu_count
        int gpu_memory_mb
        int cpu_cores
        int memory_mb
        int max_runtime_seconds
        string image
        string entrypoint
        jsonb env_vars
        jsonb volume_mounts
    }

    TaskEvent {
        uuid id PK
        uuid task_id FK
        string event_type "queued/scheduled/started/completed/failed/preempted"
        jsonb detail
        timestamp created_at
    }
```

### 2.2 核心数据结构

```go
type Task struct {
    ID          string     `json:"id" gorm:"type:uuid;primaryKey"`
    TeamID      string     `json:"team_id" gorm:"type:uuid;index"`
    UserID      string     `json:"user_id" gorm:"type:uuid;index"`
    Name        string     `json:"name"`
    Type        string     `json:"type"`     // training | evaluation | serving
    Status      string     `json:"status"`   // pending | queued | running | completed | failed | preempted
    Priority    int        `json:"priority"` // 0-100, default 50
    PreemptCount int       `json:"preempt_count"`
    SpecID      string     `json:"spec_id"`
    K8sJobName  string     `json:"k8s_job_name,omitempty"`
    CreatedAt   time.Time  `json:"created_at"`
    StartedAt   *time.Time `json:"started_at,omitempty"`
    CompletedAt *time.Time `json:"completed_at,omitempty"`
}

type ResourcePool struct {
    ID             string   `json:"id" gorm:"type:uuid;primaryKey"`
    Name           string   `json:"name"`
    SchedulerPolicy string  `json:"scheduler_policy"` // fifo | fair | priority
    Status         string   `json:"status"`            // active | paused
    Labels         JSONB    `json:"labels"`
}

// 节点 GPU 资源快照（内存状态，定时同步 DB）
type NodeResource struct {
    NodeID      string       `json:"node_id"`
    GPUs        []GPUStatus  `json:"gpus"`
    CPUAvailable int         `json:"cpu_available"`
    MemAvailable int64       `json:"mem_available_mb"`
    LastUpdated  time.Time   `json:"last_updated"`
}

type GPUStatus struct {
    Index       int    `json:"index"`
    TotalMemMB  int    `json:"total_mem_mb"`
    UsedMemMB   int    `json:"used_mem_mb"`
    Temperature float64 `json:"temperature_c"`
    PowerW      float64 `json:"power_w"`
    Status      string `json:"status"` // free | allocated | error
}
```

---

## 3. API 设计

### 3.1 资源池管理

```
POST   /api/v1/pools                        # 创建资源池
GET    /api/v1/pools                        # 资源池列表
GET    /api/v1/pools/:id                    # 资源池详情（含节点统计）
PUT    /api/v1/pools/:id                    # 更新调度策略/标签
DELETE /api/v1/pools/:id                    # 删除资源池（需无活跃节点）

POST   /api/v1/pools/:pool/nodes            # 注册节点
GET    /api/v1/pools/:pool/nodes            # 节点列表
PUT    /api/v1/pools/:pool/nodes/:nid       # 更新节点标签/状态
DELETE /api/v1/pools/:pool/nodes/:nid       # 移除节点
POST   /api/v1/pools/:pool/nodes/:nid/drain # 排空节点（维护模式）

POST   /api/v1/pools/:pool/queues           # 创建子队列（团队队列）
GET    /api/v1/pools/:pool/queues           # 队列列表
PUT    /api/v1/pools/:pool/queues/:qid      # 更新队列权重
```

### 3.2 任务管理

```
POST   /api/v1/tasks                    # 提交训练任务
GET    /api/v1/tasks                    # 任务列表（支持过滤: status, team_id, time_range）
GET    /api/v1/tasks/:id                # 任务详情
POST   /api/v1/tasks/:id/cancel         # 取消任务
POST   /api/v1/tasks/:id/priority       # 调整优先级（管理员）
GET    /api/v1/tasks/:id/logs           # 获取任务日志（关联 K8s pod）
GET    /api/v1/tasks/:id/events         # 任务事件时间线
```

### 3.3 队列与调度

```
GET    /api/v1/queue                    # 队列状态（排队任务列表 + 预计等待时间）
GET    /api/v1/queue/stats              # 队列统计（等待数/运行数/平均等待时间）
POST   /api/v1/queue/reorder            # 强制调整队列顺序（管理员）
POST   /api/v1/queue/preempt            # 抢占低优先级任务（管理员）
```

### 3.4 关键接口请求/响应示例

```http
# 提交训练任务
POST /api/v1/tasks
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
Content-Type: application/json

{
  "name": "bert-finetune-v3",
  "type": "training",
  "pool_id": "pool-01",
  "priority": 50,
  "spec": {
    "gpu_count": 4,
    "gpu_memory_mb": 81920,
    "cpu_cores": 16,
    "memory_mb": 65536,
    "max_runtime_seconds": 86400,
    "image": "harbor.internal/ai-training/bert:latest",
    "entrypoint": "python train.py --config configs/bert-finetune.yaml",
    "env_vars": {
      "WANDB_API_KEY": "xxx",
      "MODEL_NAME": "bert-base-chinese"
    },
    "volume_mounts": [
      {"name": "data", "mount_path": "/data", "pvc": "team-dataset-pvc"},
      {"name": "output", "mount_path": "/output", "pvc": "team-output-pvc"}
    ]
  }
}

# 响应 202
{
  "id": "task-xyz789",
  "status": "queued",
  "queue_position": 3,
  "estimated_wait_seconds": 1200,
  "created_at": "2026-05-25T10:00:00Z"
}
```

```http
# 抢占低优任务
POST /api/v1/queue/preempt
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
Content-Type: application/json

{
  "task_id": "task-high-priority",
  "victim_task_id": "task-low-priority"
}

# 响应
{
  "preempted": true,
  "victim_task_id": "task-low-priority",
  "victim_new_status": "preempted",
  "victim_compensation_priority": 70,
  "scheduled_task_id": "task-high-priority"
}
```

---

## 4. 调度流程

### 4.1 任务提交流程（含多级队列）

```mermaid
sequenceDiagram
    participant U as 用户
    participant G as API 网关
    participant A as Auth 服务
    participant S as Scheduler
    participant Q as Redis Streams
    participant V as Volcano
    participant K as K8s API

    U->>G: 1. POST /tasks
    G->>A: 2. 校验权限 + 团队配额
    A->>G: 3. allow + quota_remaining
    G->>S: 4. 创建任务
    S->>S: 5. 校验 spec 合法性（GPU 数/内存/时长）
    S->>Q: 6. 任务入队（按 team 写入对应子队列）
    S-->>U: 7. 返回 202 + queue_position + estimated_wait

    loop 调度循环（每 5s tick）
        S->>S: 8. 按调度策略选择下一个任务
        Note over S: fair: 轮转各 team 队列<br/>priority: 全局最高优先<br/>fifo: 最早入队
        S->>S: 9. 匹配可用资源（GPU 拓扑感知）
        alt 资源充足
            S->>V: 10. 创建 Volcano PodGroup + Job
            V->>K: 11. 调度到最优 Node
            S->>Q: 12. XACK 移除已调度任务
            S->>DB: 13. 更新任务状态为 running
        else 资源不足
            S->>Q: 14. 任务延期重试（backoff）
        end
    end
```

### 4.2 优先级与抢占流程

```mermaid
sequenceDiagram
    participant U as 管理员
    participant S as Scheduler
    participant Q as Redis Streams
    participant K as K8s API

    U->>S: 1. POST /queue/preempt {task_id, victim_task_id}
    S->>S: 2. 校验 victim.priority < new_task.priority
    S->>S: 3. 检查 victim 已运行时长
    alt victim 运行 < min_guarantee_time (5min)
        S-->>U: 409 抢占失败（任务仍在保护期）
    else victim >= min_guarantee_time
        S->>K: 4. 删除 victim 的 K8s Job（graceful shutdown 30s）
        K-->>S: 5. Pod 终止事件
        S->>S: 6. 记录 preempt_count++
        S->>Q: 7. victim 重新入队（补偿优先级 +20）
        S->>K: 8. 创建 new_task 的 Volcano Job
        S-->>U: 9. 返回抢占成功
    end

    Note over S: 保护策略：同一任务每 24h 最多被抢占 3 次
```

### 4.3 GPU 拓扑感知调度

```mermaid
graph TD
    subgraph "节点 A - 8×A100 NVLink"
        GPU0 --- GPU1
        GPU0 --- GPU2
        GPU0 --- GPU3
        GPU1 --- GPU2
        GPU1 --- GPU3
        GPU2 --- GPU3
        GPU4 --- GPU5
        GPU4 --- GPU6
        GPU4 --- GPU7
        GPU5 --- GPU6
        GPU5 --- GPU7
        GPU6 --- GPU7
    end

    subgraph "节点 B - 8×A100 PCIe"
        GPU8 --- GPU9
        GPU10 --- GPU11
        GPU12 --- GPU13
        GPU14 --- GPU15
    end
```

- **NVLink Domain**：同 domain 内 GPU 间带宽 600GB/s，适合多卡并行训练
- 调度器优先将多卡任务分配到同一 NVLink domain，避免跨 PCIe Switch 通信瓶颈
- 单卡任务优先分配到剩余 GPU 最多的节点（减少碎片）

### 4.4 节点故障检测与自愈

```mermaid
sequenceDiagram
    participant S as Scheduler
    participant N as Node
    participant K as K8s API
    participant M as Monitor

    loop 每 15s 心跳检测
        N->>S: heartbeat
    end

    alt 心跳超时 30s
        S->>S: 标记 Node status = offline
        S->>M: 发出 NodeDown 告警
        S->>K: 查询该节点上所有 Running Pod
        K->>S: 返回 Pod 列表
        loop 每个受影响的任务
            S->>K: 删除 Pod（触发重新调度）
            S->>Q: 任务自动重新入队
        end
    end

    alt 节点恢复
        N->>S: heartbeat 恢复
        S->>S: 标记 Node status = online
        S->>M: 发出 NodeRecovered 通知
    end
```

### 4.5 调度策略详解

| 策略 | 适用场景 | 实现方式 |
|------|---------|---------|
| FIFO | 调试环境、个人使用 | 按 `enqueued_at` 升序 |
| 优先级 (Priority) | 生产环境、混合负载 | 按 `priority` 降序，同优先级按 FIFO |
| 公平 (Fair) | 多团队共享集群 | 基于 DRF (Dominant Resource Fairness)，确保每个 team 最小资源保证 |
| 优先级+公平 (Hybrid) | 综合场景 | 全局按优先级，同级内按公平调度 |

---

## 5. 资源碎片管理

### 5.1 GPU 显存碎片

多卡任务释放后，集群可能出现 GPU 碎片（如 node 剩余 2 卡但 task 需要 4 卡）：

```
节点状态：  [GPU0:free] [GPU1:free] [GPU2:allocated] [GPU3:free] [GPU4:free] [GPU5:allocated] [GPU6:free] [GPU7:free]
            ↑--- 2卡连续 ---↑                                ↑--- 2卡连续 ---↑
            └── 无法满足 4 卡任务需要
```

**缓解策略**：
- 调度器优先选择"碎片化程度最低"的节点
- 定期执行 defragmentation：将小任务迁移集中，释放连续 GPU 块
- 支持 GPU MIG（Multi-Instance GPU）将大卡切分为独立实例，减少碎片

### 5.2 节点资源均衡

调度器在分配任务时，优先选择剩余资源最多的节点（Most-Requested → Least-Requested 打分），避免任务集中在少数节点。

---

## 6. 调度器高可用

```mermaid
sequenceDiagram
    participant S1 as Scheduler-1 (Leader)
    participant S2 as Scheduler-2 (Standby)
    participant R as Redis
    participant Q as Redis Streams

    Note over S1,S2: Leader Election via Redis Redlock
    S1->>R: SET scheduler:lock {s1_id} NX EX 30
    R-->>S1: OK (成为 Leader)
    S1->>R: 每 20s 续期锁（EXPIRE scheduler:lock 30）

    loop 调度执行
        S1->>Q: 读取队列 + 调度任务
    end

    Note over S1: Leader 宕机
    S2->>R: SET scheduler:lock {s2_id} NX EX 30
    R-->>S2: OK (接管成为 Leader)
    S2->>Q: 读取未 ACK 的任务，继续调度

    Note over S1,S2: 自动故障切换时间 < 30s
```

---

## 7. 模块间契约

### 7.1 对外依赖

| 依赖接口 | 提供方 | 说明 |
|---------|-------|------|
| `check-permission` | 权限中心 | 提交任务前校验操作权限 |
| `get-quota` | 权限中心 | 校验团队 GPU/存储配额 |
| `get-user-info` | 权限中心 | 获取用户所属 team 列表 |
| `record-audit-log` | 审计服务 | 记录任务操作事件 |
| `inference-service` | 推理服务 | 任务完成后触发模型自动部署 |

### 7.2 错误码定义

| 错误码 | HTTP 状态码 | 说明 |
|--------|------------|------|
| SCHED_QUOTA_EXCEEDED | 403 | 团队配额不足 |
| SCHED_PERMISSION_DENIED | 403 | 无任务提交权限 |
| SCHED_INVALID_SPEC | 400 | 任务规格不合法（GPU 数超限等） |
| SCHED_POOL_FULL | 503 | 资源池已满 |
| SCHED_PREEMPT_FAILED | 409 | 抢占失败（目标不可抢占 / 保护期） |
| SCHED_PREEMPT_LIMIT_EXCEEDED | 429 | 该任务今日被抢占次数已达上限 |

### 7.3 监控指标暴露

| 指标名 | 类型 | 标签 | 说明 |
|--------|------|------|------|
| `scheduler_queue_depth` | Gauge | pool, priority | 当前排队任务数 |
| `scheduler_task_runtime_seconds` | Histogram | type, status | 任务运行时长分布 |
| `scheduler_gpu_utilization` | Gauge | node, gpu_index | GPU 利用率 |
| `scheduler_gpu_fragmentation` | Gauge | node | GPU 碎片率（0~1） |
| `scheduler_wait_time_seconds` | Histogram | priority | 排队等待时长 |
| `scheduler_preempt_count` | Counter | pool | 抢占次数 |
| `scheduler_node_heartbeat` | Gauge | node | 节点心跳状态（1=在线） |

---

## 8. 边界与约束

1. **单任务最大 GPU 数**：暂定 64 卡（受 Volcano 和 K8s 规模限制）
2. **最大运行时长**：训练任务默认 7 天，超时自动终止（由 Volcano 的 `maxRetry` + TTL 控制）
3. **节点故障处理**：心跳超时 30s 标记为 offline，自动排空任务到其他节点
4. **被抢占保护**：任务运行前 5min 不可被抢占；同一任务每 24h 最多被抢占 3 次
5. **存储卷限制**：仅支持 PVC 挂载，暂不支持 hostPath（安全考虑）
6. **镜像拉取策略**：Always（确保每次运行最新版本）

---

## 9. 开发工作量评估

| 模块 | 后端(人天) | 说明 |
|------|-----------|------|
| 资源池与节点管理 CRUD | 3 | |
| 任务提交流程（含配额校验） | 4 | 含 Volcano Job 封装 |
| 调度器核心（多级队列 + 策略） | 6 | 含 Redis Streams 消费者 + DRF |
| 优先级调整与抢占 | 3 | 含保护机制 |
| GPU 拓扑感知调度 | 2 | NVLink domain 识别 |
| 节点故障检测与自愈 | 2 | 含 heartbeat + 排空 |
| 任务日志追踪 | 2 | 关联 K8s pod log + 事件时间线 |
| K8s/Volcano 集成适配 | 3 | 含 operator/CRD 管理 |
| 调度器高可用 | 2 | Leader Election |
| 单元测试 + 集成测试 | 3 | |
| **合计** | **30** | |
