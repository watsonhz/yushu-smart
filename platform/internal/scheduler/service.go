package scheduler

import (
	"errors"
	"fmt"
	"math"
	"time"
)

type Service struct {
	repo   *Repository
	engine *Engine
}

func NewService(repo *Repository, engine *Engine) *Service {
	return &Service{repo: repo, engine: engine}
}

// ── Pool Operations ──

func (s *Service) CreatePool(p *ResourcePool) error {
	if p.Name == "" {
		return errors.New("pool name required")
	}
	if p.SchedulerPolicy == "" {
		p.SchedulerPolicy = "fifo"
	}
	if p.Status == "" {
		p.Status = "active"
	}
	return s.repo.CreatePool(p)
}

func (s *Service) ListPools() ([]ResourcePool, error)  { return s.repo.ListPools() }
func (s *Service) GetPool(id string) (*ResourcePool, error) { return s.repo.GetPool(id) }

func (s *Service) UpdatePool(id string, p *ResourcePool) error {
	return s.repo.UpdatePool(id, p)
}
func (s *Service) DeletePool(id string) error { return s.repo.DeletePool(id) }

// ── Node Operations ──

func (s *Service) CreateNode(n *Node) error {
	if n.Hostname == "" {
		return errors.New("hostname required")
	}
	return s.repo.CreateNode(n)
}

func (s *Service) ListNodes(poolID string) ([]Node, error) { return s.repo.ListNodes(poolID) }
func (s *Service) GetNode(id string) (*Node, error)         { return s.repo.GetNode(id) }
func (s *Service) UpdateNode(id string, n *Node) error       { return s.repo.UpdateNode(id, n) }
func (s *Service) DeleteNode(id string) error                { return s.repo.DeleteNode(id) }

func (s *Service) DrainNode(id string) error {
	node, err := s.repo.GetNode(id)
	if err != nil {
		return err
	}
	node.Status = "maintenance"
	return s.repo.UpdateNode(id, node)
}

// ── Queue Operations ──

func (s *Service) CreateQueue(q *PoolQueue) error { return s.repo.CreatePoolQueue(q) }
func (s *Service) ListQueues(poolID string) ([]PoolQueue, error) { return s.repo.ListPoolQueues(poolID) }

// ── Task Operations ──

func (s *Service) SubmitTask(userID string, req *CreateTaskRequest) (*Task, int, error) {
	if req.Spec.GPUCount < 1 {
		return nil, 0, errors.New("SCHED_INVALID_SPEC: gpu_count must be >= 1")
	}
	if req.Spec.MaxRuntimeSeconds <= 0 {
		req.Spec.MaxRuntimeSeconds = 86400
	}
	if req.Priority <= 0 {
		req.Priority = 50
	}

	task := &Task{
		UserID:   userID,
		PoolID:   req.PoolID,
		Name:     req.Name,
		Type:     req.Type,
		Priority: req.Priority,
	}

	spec := &TaskSpec{
		GPUCount:          req.Spec.GPUCount,
		GPUMemoryMB:       req.Spec.GPUMemoryMB,
		CPUCores:          req.Spec.CPUCores,
		MemoryMB:          req.Spec.MemoryMB,
		MaxRuntimeSeconds: req.Spec.MaxRuntimeSeconds,
		Image:             req.Spec.Image,
		Entrypoint:        req.Spec.Entrypoint,
	}

	// Check pool exists
	pool, err := s.repo.GetPool(req.PoolID)
	if err != nil {
		return nil, 0, errors.New("SCHED_INVALID_SPEC: pool not found")
	}
	if pool.Status != "active" {
		return nil, 0, errors.New("SCHED_POOL_FULL: pool is not active")
	}

	// Create task
	if err := s.repo.CreateTask(task, spec); err != nil {
		return nil, 0, err
	}

	// Record event
	s.repo.CreateTaskEvent(task.ID, "submitted", map[string]interface{}{
		"gpu_count":   spec.GPUCount,
		"image":       spec.Image,
		"priority":    task.Priority,
	})

	// Calculate estimated wait time based on queue depth
	waitTime := s.estimateWaitTime(task)
	task.QueuePosition = 0
	task.EstimatedWaitSeconds = waitTime

	return task, waitTime, nil
}

func (s *Service) estimateWaitTime(task *Task) int {
	filter := TaskFilter{Status: "queued", PoolID: task.PoolID}
	_, queuedCount, _ := s.repo.ListTasks(filter)
	if queuedCount == 0 {
		return 0
	}
	// Rough estimate: each task ahead ~avg 30min for training tasks
	avgTaskDuration := 1800
	if task.Type == "evaluation" {
		avgTaskDuration = 600
	}
	return queuedCount * avgTaskDuration
}

func (s *Service) ListTasks(f TaskFilter) ([]Task, int, error) {
	if f.Page < 1 {
		f.Page = 1
	}
	if f.PageSize < 1 || f.PageSize > 100 {
		f.PageSize = 20
	}
	return s.repo.ListTasks(f)
}

func (s *Service) GetTask(id string) (*Task, error) { return s.repo.GetTask(id) }

func (s *Service) CancelTask(id string) error {
	task, err := s.repo.GetTask(id)
	if err != nil {
		return err
	}
	if task.Status == "running" {
		// Would cancel K8s job here
	}
	s.repo.CreateTaskEvent(id, "cancelled", map[string]string{"by": "user"})
	return s.repo.UpdateTaskStatus(id, "cancelled")
}

func (s *Service) UpdatePriority(id string, priority int) error {
	if priority < 0 || priority > 100 {
		return errors.New("priority must be 0-100")
	}
	s.repo.CreateTaskEvent(id, "priority_changed", map[string]int{"new_priority": priority})
	return s.repo.UpdateTaskPriority(id, priority)
}

func (s *Service) ListTaskEvents(id string) ([]TaskEvent, error) { return s.repo.ListTaskEvents(id) }

func (s *Service) GetTaskLogs(id string) (string, error) {
	task, err := s.repo.GetTask(id)
	if err != nil {
		return "", err
	}
	if task.K8sJobName == "" {
		return "No logs available (task not started or K8s job not created)", nil
	}
	// In production, fetch logs from K8s API
	return fmt.Sprintf("Logs for K8s job: %s\n(Integration pending - configure KUBECONFIG)", task.K8sJobName), nil
}

// ── Queue Operations ──

type QueueStatusResult struct {
	Queued  int            `json:"queued"`
	Running int            `json:"running"`
	ByPool  []PoolStatus   `json:"by_pool"`
}

type PoolStatus struct {
	PoolID  string `json:"pool_id"`
	Queued  int    `json:"queued"`
	Running int    `json:"running"`
}

func (s *Service) QueueStatus() (*QueueStatusResult, error) {
	pools, err := s.repo.ListPools()
	if err != nil {
		return nil, err
	}
	result := &QueueStatusResult{}
	for _, p := range pools {
		ps := PoolStatus{PoolID: p.ID}

		queuedTasks, _, _ := s.repo.ListTasks(TaskFilter{Status: "queued", PoolID: p.ID})
		runningTasks, _, _ := s.repo.ListTasks(TaskFilter{Status: "running", PoolID: p.ID})

		ps.Queued = len(queuedTasks)
		ps.Running = len(runningTasks)
		result.Queued += ps.Queued
		result.Running += ps.Running
		result.ByPool = append(result.ByPool, ps)
	}
	return result, nil
}

type QueueStatsResult struct {
	TotalQueued        int     `json:"total_queued"`
	TotalRunning       int     `json:"total_running"`
	AvgWaitTimeSeconds float64 `json:"avg_wait_time_seconds"`
}

func (s *Service) QueueStats() (*QueueStatsResult, error) {
	queuedTasks, _, _ := s.repo.ListTasks(TaskFilter{Status: "queued"})
	runningTasks, _, _ := s.repo.ListTasks(TaskFilter{Status: "running"})

	result := &QueueStatsResult{
		TotalQueued:  len(queuedTasks),
		TotalRunning: len(runningTasks),
	}

	// Calculate average wait time for running tasks
	totalWait := 0.0
	count := 0
	for _, t := range runningTasks {
		if t.StartedAt != nil {
			wait := t.StartedAt.Sub(t.CreatedAt).Seconds()
			totalWait += wait
			count++
		}
	}
	if count > 0 {
		result.AvgWaitTimeSeconds = math.Round(totalWait/float64(count)*100) / 100
	}
	return result, nil
}

// ── Preemption ──

type PreemptResult struct {
	Preempted             bool   `json:"preempted"`
	VictimTaskID          string `json:"victim_task_id"`
	VictimNewStatus       string `json:"victim_new_status"`
	VictimCompensation    int    `json:"victim_compensation_priority"`
	ScheduledTaskID       string `json:"scheduled_task_id"`
}

func (s *Service) PreemptTask(taskID, victimID string) (*PreemptResult, error) {
	task, err := s.repo.GetTask(taskID)
	if err != nil {
		return nil, errors.New("task not found")
	}
	victim, err := s.repo.GetTask(victimID)
	if err != nil {
		return nil, errors.New("victim task not found")
	}

	if task.Priority <= victim.Priority {
		return nil, errors.New("SCHED_PREEMPT_FAILED: can only preempt lower priority tasks")
	}
	if victim.Status != "running" {
		return nil, errors.New("SCHED_PREEMPT_FAILED: victim is not running")
	}

	// Protection: min guarantee time (5 min)
	if victim.StartedAt != nil && time.Since(*victim.StartedAt) < 5*time.Minute {
		return nil, errors.New("SCHED_PREEMPT_FAILED: victim in protection period (< 5min)")
	}

	// Protection: max preempt per 24h (3 times)
	if victim.PreemptCount >= 3 {
		return nil, errors.New("SCHED_PREEMPT_FAILED: SCHED_PREEMPT_LIMIT_EXCEEDED")
	}

	// Execute preemption
	compensationPriority := victim.Priority + 20
	if compensationPriority > 100 {
		compensationPriority = 100
	}

	_ = s.repo.UpdateTaskStatus(victimID, "preempted")
	_ = s.repo.CreateTaskEvent(victimID, "preempted", map[string]interface{}{
		"preempted_by": taskID,
		"compensation": compensationPriority,
	})
	_ = s.repo.UpdateTaskPriority(victimID, compensationPriority)

	// Re-queue victim
	_ = s.repo.UpdateTaskStatus(victimID, "queued")

	_ = s.repo.UpdateTaskStatus(taskID, "running")
	_ = s.repo.CreateTaskEvent(taskID, "scheduled", map[string]string{"via": "preemption"})

	return &PreemptResult{
		Preempted:             true,
		VictimTaskID:          victimID,
		VictimNewStatus:       "preempted",
		VictimCompensation:    compensationPriority,
		ScheduledTaskID:       taskID,
	}, nil
}
