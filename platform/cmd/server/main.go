package main

import (
	"context"
	"database/sql"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	_ "github.com/lib/pq"

	"github.com/feishu-claude-bot/platform/internal/audit"
	"github.com/feishu-claude-bot/platform/internal/config"
	"github.com/feishu-claude-bot/platform/internal/middleware"
	"github.com/feishu-claude-bot/platform/internal/scheduler"
)

func main() {
	cfg := config.Load()

	// ── Database ──
	db, err := sql.Open("postgres", cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer db.Close()

	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)

	if err := db.Ping(); err != nil {
		log.Fatalf("Failed to ping database: %v", err)
	}
	log.Println("Connected to PostgreSQL")

	// Run migrations
	runMigrations(db)

	// ── Redis ──
	redisOpts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		log.Fatalf("Failed to parse Redis URL: %v", err)
	}
	rdb := redis.NewClient(redisOpts)
	defer rdb.Close()

	if _, err := rdb.Ping(context.Background()).Result(); err != nil {
		log.Fatalf("Failed to connect to Redis: %v", err)
	}
	log.Println("Connected to Redis")

	// ── Initialize Modules ──

	// Scheduler
	schedRepo := scheduler.NewRepository(db)
	schedEngine := scheduler.NewEngine(schedRepo, cfg.SchedulerTick)
	schedSvc := scheduler.NewService(schedRepo, schedEngine)
	schedHandler := scheduler.NewHandler(schedSvc)

	// Audit
	auditRepo := audit.NewRepository(db)
	auditSvc := audit.NewService(auditRepo, cfg.InternalToken)
	auditHandler := audit.NewHandler(auditSvc)
	auditWorker := audit.NewWorker(rdb, auditRepo, "audit-workers", "worker-1")

	// ── Start Background Services ──
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	schedEngine.Start()
	auditWorker.Start(ctx)

	// ── HTTP Router ──
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(middleware.CORS())
	r.Use(middleware.RequestLogger())
	r.Use(gin.Recovery())

	// Health check
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "time": time.Now().Unix()})
	})

	// Static files (frontend)
	r.Static("/web", "./web")
	r.StaticFile("/", "./web/index.html")
	r.StaticFile("/index.html", "./web/index.html")

	// API v1
	v1 := r.Group("/api/v1")
	v1.Use(middleware.JWTAuth(cfg.JWTSecret))
	{
		schedHandler.RegisterRoutes(v1)
		auditHandler.RegisterRoutes(v1)
	}

	// ── Graceful Shutdown ──
	srv := &http.Server{
		Addr:    cfg.Address(),
		Handler: r,
	}

	go func() {
		log.Printf("Server starting on %s", cfg.Address())
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down...")
	schedEngine.Stop()
	auditWorker.Stop()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Fatalf("Server forced shutdown: %v", err)
	}
	log.Println("Server stopped")
}

func runMigrations(db *sql.DB) {
	migrations := []string{
		migrationScheduler,
		migrationAudit,
	}
	for i, m := range migrations {
		if _, err := db.Exec(m); err != nil {
			log.Fatalf("Migration %d failed: %v", i+1, err)
		}
	}
	log.Println("Database migrations completed")
}

const migrationScheduler = `
CREATE TABLE IF NOT EXISTS resource_pools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(128) NOT NULL UNIQUE,
    scheduler_policy VARCHAR(16) NOT NULL DEFAULT 'fifo',
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    labels JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pool_queues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id UUID NOT NULL REFERENCES resource_pools(id) ON DELETE CASCADE,
    team_id UUID,
    name VARCHAR(128) NOT NULL,
    priority_weight INT NOT NULL DEFAULT 1,
    max_running INT NOT NULL DEFAULT 5,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id UUID NOT NULL REFERENCES resource_pools(id) ON DELETE CASCADE,
    hostname VARCHAR(256) NOT NULL UNIQUE,
    ip_address INET NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'online',
    specs JSONB DEFAULT '{}',
    labels JSONB DEFAULT '{}',
    last_heartbeat TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gpu_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    index INT NOT NULL,
    memory_total_mb INT NOT NULL,
    memory_used_mb INT NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL DEFAULT 'free',
    temperature_c REAL DEFAULT 0,
    power_w REAL DEFAULT 0,
    topology VARCHAR(64) DEFAULT '',
    UNIQUE (node_id, index)
);

CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID,
    user_id UUID NOT NULL,
    pool_id UUID NOT NULL REFERENCES resource_pools(id),
    name VARCHAR(256) NOT NULL,
    type VARCHAR(16) NOT NULL DEFAULT 'training',
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    priority INT NOT NULL DEFAULT 50,
    preempt_count INT NOT NULL DEFAULT 0,
    queue_position INT DEFAULT 0,
    estimated_wait_seconds INT DEFAULT 0,
    k8s_job_name VARCHAR(256),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS task_specs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
    gpu_count INT NOT NULL,
    gpu_memory_mb INT DEFAULT 0,
    cpu_cores INT NOT NULL DEFAULT 1,
    memory_mb INT NOT NULL DEFAULT 1024,
    max_runtime_seconds INT NOT NULL DEFAULT 86400,
    image VARCHAR(512) NOT NULL,
    entrypoint TEXT DEFAULT '',
    env_vars JSONB DEFAULT '{}',
    volume_mounts JSONB DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS task_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    event_type VARCHAR(32) NOT NULL,
    detail JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_team_id ON tasks(team_id);
CREATE INDEX IF NOT EXISTS idx_nodes_pool_id ON nodes(pool_id);
CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id);
`

const migrationAudit = `
CREATE TABLE IF NOT EXISTS audit_events (
    id BIGSERIAL PRIMARY KEY,
    event_id UUID NOT NULL UNIQUE,
    tenant_id UUID NOT NULL,
    actor_type VARCHAR(16) NOT NULL DEFAULT 'user',
    actor_id VARCHAR(128) NOT NULL,
    actor_name VARCHAR(256) DEFAULT '',
    resource_type VARCHAR(32) NOT NULL,
    resource_id VARCHAR(128) NOT NULL,
    resource_name VARCHAR(256) DEFAULT '',
    action VARCHAR(32) NOT NULL,
    result VARCHAR(16) NOT NULL DEFAULT 'success',
    detail JSONB DEFAULT '{}',
    client_ip INET,
    user_agent TEXT DEFAULT '',
    extra JSONB DEFAULT '{}',
    prev_event_hash VARCHAR(64) DEFAULT '',
    event_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cost_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    team_id UUID NOT NULL,
    task_id UUID NOT NULL UNIQUE,
    task_name VARCHAR(256) NOT NULL,
    gpu_count INT NOT NULL,
    gpu_model VARCHAR(64) DEFAULT '',
    duration_seconds INT NOT NULL,
    unit_price_per_hour DECIMAL(12, 4) NOT NULL,
    total_cost DECIMAL(14, 4) NOT NULL,
    billing_mode VARCHAR(32) NOT NULL DEFAULT 'per_gpu_hour',
    discount_rate DECIMAL(4, 2) NOT NULL DEFAULT 1.00,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS price_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gpu_model VARCHAR(64) NOT NULL UNIQUE,
    unit_price DECIMAL(12, 4) NOT NULL,
    billing_mode VARCHAR(32) NOT NULL DEFAULT 'per_gpu_hour',
    min_billing_seconds INT NOT NULL DEFAULT 60,
    effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_to TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO price_configs (gpu_model, unit_price) VALUES
    ('A100', 10.00), ('A800', 8.00), ('H800', 25.00)
ON CONFLICT (gpu_model) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_id ON audit_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor_id ON audit_events(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_resource_type ON audit_events(resource_type);
CREATE INDEX IF NOT EXISTS idx_audit_events_action ON audit_events(action);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at);
CREATE INDEX IF NOT EXISTS idx_cost_records_team_id ON cost_records(team_id);
CREATE INDEX IF NOT EXISTS idx_cost_records_status ON cost_records(status);
`
