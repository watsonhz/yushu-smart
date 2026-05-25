package scheduler

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type Repository struct {
	db *sql.DB
}

func NewRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

// ── Resource Pools ──

func (r *Repository) CreatePool(p *ResourcePool) error {
	p.CreatedAt = time.Now()
	p.UpdatedAt = time.Now()
	labelsJSON, _ := json.Marshal(p.Labels)
	return r.db.QueryRow(`
		INSERT INTO resource_pools (name, scheduler_policy, status, labels, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id`,
		p.Name, p.SchedulerPolicy, p.Status, labelsJSON, p.CreatedAt, p.UpdatedAt,
	).Scan(&p.ID)
}

func (r *Repository) ListPools() ([]ResourcePool, error) {
	rows, err := r.db.Query(`
		SELECT id, name, scheduler_policy, status, labels::text, created_at, updated_at
		FROM resource_pools ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanPools(rows)
}

func (r *Repository) GetPool(id string) (*ResourcePool, error) {
	p := &ResourcePool{}
	var labelsStr string
	err := r.db.QueryRow(`
		SELECT id, name, scheduler_policy, status, labels::text, created_at, updated_at
		FROM resource_pools WHERE id = $1`, id).Scan(
		&p.ID, &p.Name, &p.SchedulerPolicy, &p.Status, &labelsStr, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, err
	}
	p.Labels = JSONB(labelsStr)
	return p, nil
}

func (r *Repository) UpdatePool(id string, p *ResourcePool) error {
	p.UpdatedAt = time.Now()
	labelsJSON, _ := json.Marshal(p.Labels)
	_, err := r.db.Exec(`
		UPDATE resource_pools SET name=$1, scheduler_policy=$2, status=$3, labels=$4, updated_at=$5
		WHERE id=$6`,
		p.Name, p.SchedulerPolicy, p.Status, labelsJSON, p.UpdatedAt, id)
	return err
}

func (r *Repository) DeletePool(id string) error {
	_, err := r.db.Exec(`DELETE FROM resource_pools WHERE id = $1`, id)
	return err
}

// ── Nodes ──

func (r *Repository) CreateNode(n *Node) error {
	n.CreatedAt = time.Now()
	n.UpdatedAt = time.Now()
	specsJSON, _ := json.Marshal(n.Specs)
	labelsJSON, _ := json.Marshal(n.Labels)
	return r.db.QueryRow(`
		INSERT INTO nodes (pool_id, hostname, ip_address, status, specs, labels, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id`,
		n.PoolID, n.Hostname, n.IPAddress, n.Status, specsJSON, labelsJSON, n.CreatedAt, n.UpdatedAt,
	).Scan(&n.ID)
}

func (r *Repository) ListNodes(poolID string) ([]Node, error) {
	rows, err := r.db.Query(`
		SELECT id, pool_id, hostname, ip_address, status, specs::text, labels::text,
		       last_heartbeat, created_at, updated_at
		FROM nodes WHERE pool_id = $1 ORDER BY hostname`, poolID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanNodes(rows)
}

func (r *Repository) GetNode(id string) (*Node, error) {
	n := &Node{}
	var specsStr, labelsStr string
	err := r.db.QueryRow(`
		SELECT id, pool_id, hostname, ip_address, status, specs::text, labels::text,
		       last_heartbeat, created_at, updated_at
		FROM nodes WHERE id = $1`, id).Scan(
		&n.ID, &n.PoolID, &n.Hostname, &n.IPAddress, &n.Status,
		&specsStr, &labelsStr, &n.LastHeartbeat, &n.CreatedAt, &n.UpdatedAt)
	if err != nil {
		return nil, err
	}
	n.Specs = JSONB(specsStr)
	n.Labels = JSONB(labelsStr)
	return n, nil
}

func (r *Repository) UpdateNode(id string, n *Node) error {
	n.UpdatedAt = time.Now()
	specsJSON, _ := json.Marshal(n.Specs)
	labelsJSON, _ := json.Marshal(n.Labels)
	_, err := r.db.Exec(`
		UPDATE nodes SET status=$1, specs=$2, labels=$3, last_heartbeat=$4, updated_at=$5
		WHERE id=$6`,
		n.Status, specsJSON, labelsJSON, n.LastHeartbeat, n.UpdatedAt, id)
	return err
}

func (r *Repository) DeleteNode(id string) error {
	_, err := r.db.Exec(`DELETE FROM nodes WHERE id = $1`, id)
	return err
}

func (r *Repository) UpdateNodeHeartbeat(id string) error {
	now := time.Now()
	_, err := r.db.Exec(`UPDATE nodes SET last_heartbeat=$1, status='online' WHERE id=$2`, now, id)
	return err
}

// ── GPU Devices ──

func (r *Repository) UpsertGPUDevices(nodeID string, devices []GPUDevice) error {
	for _, d := range devices {
		_, err := r.db.Exec(`
			INSERT INTO gpu_devices (node_id, index, memory_total_mb, memory_used_mb, status, temperature_c, power_w, topology)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (node_id, index) DO UPDATE SET
				memory_used_mb=$4, status=$5, temperature_c=$6, power_w=$7`,
			nodeID, d.Index, d.MemoryTotalMB, d.MemoryUsedMB, d.Status, d.TemperatureC, d.PowerW, d.Topology)
		if err != nil {
			return err
		}
	}
	return nil
}

// ── Tasks ──

func (r *Repository) CreateTask(t *Task, spec *TaskSpec) error {
	t.CreatedAt = time.Now()
	t.Status = "queued"
	err := r.db.QueryRow(`
		INSERT INTO tasks (team_id, user_id, pool_id, name, type, status, priority, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id`,
		t.TeamID, t.UserID, t.PoolID, t.Name, t.Type, t.Status, t.Priority, t.CreatedAt,
	).Scan(&t.ID)
	if err != nil {
		return err
	}

	envJSON, _ := json.Marshal(spec.EnvVars)
	volJSON, _ := json.Marshal(spec.VolumeMounts)
	_, err = r.db.Exec(`
		INSERT INTO task_specs (task_id, gpu_count, gpu_memory_mb, cpu_cores, memory_mb,
		                        max_runtime_seconds, image, entrypoint, env_vars, volume_mounts)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		t.ID, spec.GPUCount, spec.GPUMemoryMB, spec.CPUCores, spec.MemoryMB,
		spec.MaxRuntimeSeconds, spec.Image, spec.Entrypoint, envJSON, volJSON)
	return err
}

func (r *Repository) ListTasks(f TaskFilter) ([]Task, int, error) {
	where := []string{}
	args := []interface{}{}
	idx := 1

	if f.Status != "" {
		where = append(where, fmt.Sprintf("t.status = $%d", idx))
		args = append(args, f.Status)
		idx++
	}
	if f.TeamID != "" {
		where = append(where, fmt.Sprintf("t.team_id = $%d", idx))
		args = append(args, f.TeamID)
		idx++
	}
	if f.PoolID != "" {
		where = append(where, fmt.Sprintf("t.pool_id = $%d", idx))
		args = append(args, f.PoolID)
		idx++
	}

	whereClause := ""
	if len(where) > 0 {
		whereClause = " WHERE " + strings.Join(where, " AND ")
	}

	var total int
	countQuery := "SELECT COUNT(*) FROM tasks t" + whereClause
	r.db.QueryRow(countQuery, args...).Scan(&total)

	if f.Page < 1 {
		f.Page = 1
	}
	if f.PageSize < 1 || f.PageSize > 100 {
		f.PageSize = 20
	}
	offset := (f.Page - 1) * f.PageSize

	rows, err := r.db.Query(`
		SELECT t.id, t.team_id, t.user_id, t.pool_id, t.name, t.type, t.status,
		       t.priority, t.preempt_count, t.queue_position, t.estimated_wait_seconds,
		       t.k8s_job_name, t.created_at, t.started_at, t.completed_at
		FROM tasks t`+whereClause+`
		ORDER BY t.created_at DESC LIMIT $`+fmt.Sprintf("%d", idx)+` OFFSET $`+fmt.Sprintf("%d", idx+1),
		append(args, f.PageSize, offset)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	tasks := []Task{}
	for rows.Next() {
		var t Task
		err := rows.Scan(&t.ID, &t.TeamID, &t.UserID, &t.PoolID, &t.Name, &t.Type, &t.Status,
			&t.Priority, &t.PreemptCount, &t.QueuePosition, &t.EstimatedWaitSeconds,
			&t.K8sJobName, &t.CreatedAt, &t.StartedAt, &t.CompletedAt)
		if err != nil {
			return nil, 0, err
		}
		tasks = append(tasks, t)
	}
	return tasks, total, nil
}

func (r *Repository) GetTask(id string) (*Task, error) {
	t := &Task{}
	err := r.db.QueryRow(`
		SELECT id, team_id, user_id, pool_id, name, type, status, priority, preempt_count,
		       queue_position, estimated_wait_seconds, k8s_job_name, created_at, started_at, completed_at
		FROM tasks WHERE id = $1`, id).Scan(
		&t.ID, &t.TeamID, &t.UserID, &t.PoolID, &t.Name, &t.Type, &t.Status,
		&t.Priority, &t.PreemptCount, &t.QueuePosition, &t.EstimatedWaitSeconds,
		&t.K8sJobName, &t.CreatedAt, &t.StartedAt, &t.CompletedAt)
	if err != nil {
		return nil, err
	}
	// load spec
	t.Spec = &TaskSpec{}
	err = r.db.QueryRow(`
		SELECT gpu_count, gpu_memory_mb, cpu_cores, memory_mb, max_runtime_seconds,
		       image, entrypoint, env_vars::text, volume_mounts::text
		FROM task_specs WHERE task_id = $1`, id).Scan(
		&t.Spec.GPUCount, &t.Spec.GPUMemoryMB, &t.Spec.CPUCores, &t.Spec.MemoryMB,
		&t.Spec.MaxRuntimeSeconds, &t.Spec.Image, &t.Spec.Entrypoint,
		&t.Spec.EnvVars, &t.Spec.VolumeMounts)
	if err != nil {
		// spec might not exist for some queries
		t.Spec = nil
	}
	return t, nil
}

func (r *Repository) UpdateTaskStatus(id, status string) error {
	now := time.Now()
	var startedAt, completedAt *time.Time
	if status == "running" {
		startedAt = &now
	}
	if status == "completed" || status == "failed" || status == "cancelled" {
		completedAt = &now
	}
	_, err := r.db.Exec(`
		UPDATE tasks SET status=$1, started_at=COALESCE($2, started_at),
		                  completed_at=COALESCE($3, completed_at)
		WHERE id=$4`, status, startedAt, completedAt, id)
	return err
}

func (r *Repository) UpdateTaskPriority(id string, priority int) error {
	_, err := r.db.Exec(`UPDATE tasks SET priority=$1 WHERE id=$2`, priority, id)
	return err
}

func (r *Repository) CreateTaskEvent(taskID, eventType string, detail interface{}) error {
	detailJSON, _ := json.Marshal(detail)
	_, err := r.db.Exec(`
		INSERT INTO task_events (task_id, event_type, detail) VALUES ($1, $2, $3)`,
		taskID, eventType, detailJSON)
	return err
}

func (r *Repository) ListTaskEvents(taskID string) ([]TaskEvent, error) {
	rows, err := r.db.Query(`
		SELECT id, task_id, event_type, detail::text, created_at
		FROM task_events WHERE task_id = $1 ORDER BY created_at`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []TaskEvent
	for rows.Next() {
		var e TaskEvent
		var detailStr string
		if err := rows.Scan(&e.ID, &e.TaskID, &e.EventType, &detailStr, &e.CreatedAt); err != nil {
			return nil, err
		}
		e.Detail = []byte(detailStr)
		events = append(events, e)
	}
	return events, nil
}

// ── Queue Operations ──

func (r *Repository) CreatePoolQueue(q *PoolQueue) error {
	q.CreatedAt = time.Now()
	return r.db.QueryRow(`
		INSERT INTO pool_queues (pool_id, team_id, name, priority_weight, max_running, created_at)
		VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		q.PoolID, q.TeamID, q.Name, q.PriorityWeight, q.MaxRunning, q.CreatedAt).Scan(&q.ID)
}

func (r *Repository) ListPoolQueues(poolID string) ([]PoolQueue, error) {
	rows, err := r.db.Query(`
		SELECT id, pool_id, team_id, name, priority_weight, max_running, created_at
		FROM pool_queues WHERE pool_id = $1 ORDER BY name`, poolID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var queues []PoolQueue
	for rows.Next() {
		var q PoolQueue
		if err := rows.Scan(&q.ID, &q.PoolID, &q.TeamID, &q.Name, &q.PriorityWeight, &q.MaxRunning, &q.CreatedAt); err != nil {
			return nil, err
		}
		queues = append(queues, q)
	}
	return queues, nil
}

// ── Helper Scanners ──

func scanPools(rows *sql.Rows) ([]ResourcePool, error) {
	var pools []ResourcePool
	for rows.Next() {
		var p ResourcePool
		var labelsStr string
		if err := rows.Scan(&p.ID, &p.Name, &p.SchedulerPolicy, &p.Status, &labelsStr, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		p.Labels = JSONB(labelsStr)
		pools = append(pools, p)
	}
	return pools, nil
}

func scanNodes(rows *sql.Rows) ([]Node, error) {
	var nodes []Node
	for rows.Next() {
		var n Node
		var specsStr, labelsStr string
		if err := rows.Scan(&n.ID, &n.PoolID, &n.Hostname, &n.IPAddress, &n.Status,
			&specsStr, &labelsStr, &n.LastHeartbeat, &n.CreatedAt, &n.UpdatedAt); err != nil {
			return nil, err
		}
		n.Specs = JSONB(specsStr)
		n.Labels = JSONB(labelsStr)
		nodes = append(nodes, n)
	}
	return nodes, nil
}
