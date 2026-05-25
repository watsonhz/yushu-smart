-- Scheduler Engine Schema v1
-- Resource Pool: logical grouping of GPU nodes
CREATE TABLE IF NOT EXISTS resource_pools (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(128) NOT NULL UNIQUE,
    scheduler_policy VARCHAR(16) NOT NULL DEFAULT 'fifo'
                     CHECK (scheduler_policy IN ('fifo', 'fair', 'priority')),
    status      VARCHAR(16) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'paused')),
    labels      JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pool sub-queues for multi-team scheduling
CREATE TABLE IF NOT EXISTS pool_queues (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id         UUID NOT NULL REFERENCES resource_pools(id) ON DELETE CASCADE,
    team_id         UUID,
    name            VARCHAR(128) NOT NULL,
    priority_weight INT NOT NULL DEFAULT 1 CHECK (priority_weight > 0),
    max_running     INT NOT NULL DEFAULT 5 CHECK (max_running > 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- GPU Nodes registered in the pool
CREATE TABLE IF NOT EXISTS nodes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id         UUID NOT NULL REFERENCES resource_pools(id) ON DELETE CASCADE,
    hostname        VARCHAR(256) NOT NULL UNIQUE,
    ip_address      INET NOT NULL,
    status          VARCHAR(16) NOT NULL DEFAULT 'online'
                    CHECK (status IN ('online', 'offline', 'maintenance')),
    specs           JSONB DEFAULT '{}',
    labels          JSONB DEFAULT '{}',
    last_heartbeat  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-GPU device details
CREATE TABLE IF NOT EXISTS gpu_devices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id         UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    index           INT NOT NULL,
    memory_total_mb INT NOT NULL,
    memory_used_mb  INT NOT NULL DEFAULT 0,
    status          VARCHAR(16) NOT NULL DEFAULT 'free'
                    CHECK (status IN ('free', 'allocated', 'error', 'degraded')),
    temperature_c   REAL DEFAULT 0,
    power_w         REAL DEFAULT 0,
    topology        VARCHAR(64) DEFAULT '',
    UNIQUE (node_id, index)
);

-- Training/Evaluation tasks
CREATE TABLE IF NOT EXISTS tasks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id         UUID,
    user_id         UUID NOT NULL,
    pool_id         UUID NOT NULL REFERENCES resource_pools(id),
    name            VARCHAR(256) NOT NULL,
    type            VARCHAR(16) NOT NULL DEFAULT 'training'
                    CHECK (type IN ('training', 'evaluation', 'serving')),
    status          VARCHAR(16) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'queued', 'running', 'completed', 'failed', 'preempted', 'cancelled')),
    priority        INT NOT NULL DEFAULT 50 CHECK (priority >= 0 AND priority <= 100),
    preempt_count   INT NOT NULL DEFAULT 0,
    queue_position  INT DEFAULT 0,
    estimated_wait_seconds INT DEFAULT 0,
    k8s_job_name    VARCHAR(256),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
);

-- Task resource specification
CREATE TABLE IF NOT EXISTS task_specs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id             UUID NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
    gpu_count           INT NOT NULL CHECK (gpu_count > 0),
    gpu_memory_mb       INT DEFAULT 0,
    cpu_cores           INT NOT NULL DEFAULT 1,
    memory_mb           INT NOT NULL DEFAULT 1024,
    max_runtime_seconds INT NOT NULL DEFAULT 86400,
    image               VARCHAR(512) NOT NULL,
    entrypoint          TEXT DEFAULT '',
    env_vars            JSONB DEFAULT '{}',
    volume_mounts       JSONB DEFAULT '[]'
);

-- Task lifecycle events
CREATE TABLE IF NOT EXISTS task_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    event_type  VARCHAR(32) NOT NULL,
    detail      JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_team_id ON tasks(team_id);
CREATE INDEX idx_tasks_user_id ON tasks(user_id);
CREATE INDEX idx_tasks_created_at ON tasks(created_at);
CREATE INDEX idx_nodes_pool_id ON nodes(pool_id);
CREATE INDEX idx_nodes_status ON nodes(status);
CREATE INDEX idx_task_events_task_id ON task_events(task_id);
CREATE INDEX idx_pool_queues_pool_id ON pool_queues(pool_id);
