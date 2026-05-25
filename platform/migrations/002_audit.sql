-- Audit Log Schema v1
-- Audit events table (with hash chain for tamper resistance)
CREATE TABLE IF NOT EXISTS audit_events (
    id              BIGSERIAL PRIMARY KEY,
    event_id        UUID NOT NULL UNIQUE,
    tenant_id       UUID NOT NULL,
    actor_type      VARCHAR(16) NOT NULL DEFAULT 'user'
                    CHECK (actor_type IN ('user', 'system')),
    actor_id        VARCHAR(128) NOT NULL,
    actor_name      VARCHAR(256) DEFAULT '',
    resource_type   VARCHAR(32) NOT NULL,
    resource_id     VARCHAR(128) NOT NULL,
    resource_name   VARCHAR(256) DEFAULT '',
    action          VARCHAR(32) NOT NULL,
    result          VARCHAR(16) NOT NULL DEFAULT 'success'
                    CHECK (result IN ('success', 'failure')),
    detail          JSONB DEFAULT '{}',
    client_ip       INET,
    user_agent      TEXT DEFAULT '',
    extra           JSONB DEFAULT '{}',
    prev_event_hash VARCHAR(64) DEFAULT '',
    event_hash      VARCHAR(64) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

-- Monthly partitions
CREATE TABLE audit_events_2026_05 PARTITION OF audit_events
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE audit_events_2026_06 PARTITION OF audit_events
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE audit_events_2026_07 PARTITION OF audit_events
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE audit_events_default PARTITION OF audit_events
    DEFAULT;

-- Daily merkle root for integrity verification
CREATE TABLE IF NOT EXISTS audit_merkle_roots (
    id              BIGSERIAL PRIMARY KEY,
    date            DATE NOT NULL UNIQUE,
    merkle_root     VARCHAR(64) NOT NULL,
    event_count     INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cost records (billing)
CREATE TABLE IF NOT EXISTS cost_records (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL,
    team_id             UUID NOT NULL,
    task_id             UUID NOT NULL UNIQUE,
    task_name           VARCHAR(256) NOT NULL,
    gpu_count           INT NOT NULL,
    gpu_model           VARCHAR(64) DEFAULT '',
    duration_seconds    INT NOT NULL,
    unit_price_per_hour DECIMAL(12, 4) NOT NULL,
    total_cost          DECIMAL(14, 4) NOT NULL,
    billing_mode        VARCHAR(32) NOT NULL DEFAULT 'per_gpu_hour',
    discount_rate       DECIMAL(4, 2) NOT NULL DEFAULT 1.00,
    started_at          TIMESTAMPTZ NOT NULL,
    ended_at            TIMESTAMPTZ NOT NULL,
    status              VARCHAR(16) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'settled', 'refunded')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Price configuration
CREATE TABLE IF NOT EXISTS price_configs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gpu_model           VARCHAR(64) NOT NULL UNIQUE,
    unit_price          DECIMAL(12, 4) NOT NULL,
    billing_mode        VARCHAR(32) NOT NULL DEFAULT 'per_gpu_hour',
    min_billing_seconds INT NOT NULL DEFAULT 60,
    effective_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_to        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Default pricing
INSERT INTO price_configs (gpu_model, unit_price, billing_mode) VALUES
    ('A100',  10.00, 'per_gpu_hour'),
    ('A800',  8.00,  'per_gpu_hour'),
    ('H800',  25.00, 'per_gpu_hour')
ON CONFLICT (gpu_model) DO NOTHING;

CREATE INDEX idx_audit_events_tenant_id ON audit_events(tenant_id);
CREATE INDEX idx_audit_events_actor_id ON audit_events(actor_id);
CREATE INDEX idx_audit_events_resource_type ON audit_events(resource_type);
CREATE INDEX idx_audit_events_action ON audit_events(action);
CREATE INDEX idx_audit_events_created_at ON audit_events(created_at);
CREATE INDEX idx_cost_records_team_id ON cost_records(team_id);
CREATE INDEX idx_cost_records_tenant_id ON cost_records(tenant_id);
CREATE INDEX idx_cost_records_status ON cost_records(status);
