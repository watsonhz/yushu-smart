package scheduler

import (
	"context"
	"log"
	"math"
	"sort"
	"sync"
	"time"
)

type Engine struct {
	repo      *Repository
	tickSec   int
	ctx       context.Context
	cancel    context.CancelFunc
	wg        sync.WaitGroup
}

func NewEngine(repo *Repository, tickSec int) *Engine {
	return &Engine{
		repo:    repo,
		tickSec: tickSec,
	}
}

func (e *Engine) Start() {
	e.ctx, e.cancel = context.WithCancel(context.Background())
	e.wg.Add(1)
	go e.loop()
	log.Printf("[Scheduler] Engine started (tick=%ds)", e.tickSec)
}

func (e *Engine) Stop() {
	if e.cancel != nil {
		e.cancel()
	}
	e.wg.Wait()
	log.Println("[Scheduler] Engine stopped")
}

func (e *Engine) loop() {
	defer e.wg.Done()

	// Initial tick
	e.tick()

	ticker := time.NewTicker(time.Duration(e.tickSec) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-e.ctx.Done():
			return
		case <-ticker.C:
			e.tick()
		}
	}
}

func (e *Engine) tick() {
	pools, err := e.repo.ListPools()
	if err != nil {
		log.Printf("[Scheduler] Failed to list pools: %v", err)
		return
	}

	for _, pool := range pools {
		if pool.Status != "active" {
			continue
		}
		e.schedulePool(&pool)
	}
}

func (e *Engine) schedulePool(pool *ResourcePool) {
	// Get pending tasks for this pool
	queuedTasks, _, err := e.repo.ListTasks(TaskFilter{Status: "queued", PoolID: pool.ID})
	if err != nil || len(queuedTasks) == 0 {
		return
	}

	// Get running tasks count
	runningTasks, _, _ := e.repo.ListTasks(TaskFilter{Status: "running", PoolID: pool.ID})

	// Get pool queues
	queues, _ := e.repo.ListPoolQueues(pool.ID)

	// Get available nodes
	nodes, err := e.repo.ListNodes(pool.ID)
	if err != nil {
		return
	}
	availableGPUs := countAvailableGPUs(nodes)

	// Calculate available slots
	availableSlots := availableGPUs - countRunningGPUs(runningTasks)

	if pool.SchedulerPolicy == "fair" && len(queues) > 0 {
		e.scheduleFair(queues, queuedTasks, availableSlots)
	} else if pool.SchedulerPolicy == "priority" {
		e.schedulePriority(queuedTasks, availableSlots)
	} else {
		e.scheduleFIFO(queuedTasks, availableSlots)
	}
}

func (e *Engine) scheduleFIFO(tasks []Task, availableSlots int) {
	sort.Slice(tasks, func(i, j int) bool {
		return tasks[i].CreatedAt.Before(tasks[j].CreatedAt)
	})
	e.dispatchTasks(tasks, availableSlots)
}

func (e *Engine) schedulePriority(tasks []Task, availableSlots int) {
	sort.Slice(tasks, func(i, j int) bool {
		if tasks[i].Priority != tasks[j].Priority {
			return tasks[i].Priority > tasks[j].Priority
		}
		return tasks[i].CreatedAt.Before(tasks[j].CreatedAt)
	})
	e.dispatchTasks(tasks, availableSlots)
}

func (e *Engine) scheduleFair(queues []PoolQueue, tasks []Task, availableSlots int) {
	// Group tasks by team_id -> queue mapping
	teamTasks := map[string][]Task{}
	for _, t := range tasks {
		teamID := "default"
		if t.TeamID != nil {
			teamID = *t.TeamID
		}
		teamTasks[teamID] = append(teamTasks[teamID], t)
	}

	// Sort by priority weight: teams with higher weight get more slots
	sort.Slice(queues, func(i, j int) bool {
		return queues[i].PriorityWeight > queues[j].PriorityWeight
	})

	totalWeight := 0
	for _, q := range queues {
		totalWeight += q.PriorityWeight
	}

	if totalWeight == 0 {
		totalWeight = 1
	}

	for _, q := range queues {
		teamID := ""
		if q.TeamID != nil {
			teamID = *q.TeamID
		}
		teamTaskList := teamTasks[teamID]

		if len(teamTaskList) == 0 {
			continue
		}

		// Allocate proportional slots
		teamSlots := int(math.Ceil(float64(availableSlots) * float64(q.PriorityWeight) / float64(totalWeight)))
		if teamSlots > q.MaxRunning {
			teamSlots = q.MaxRunning
		}
		if teamSlots > len(teamTaskList) {
			teamSlots = len(teamTaskList)
		}

		// Within team, sort by priority then FIFO
		sort.Slice(teamTaskList, func(i, j int) bool {
			if teamTaskList[i].Priority != teamTaskList[j].Priority {
				return teamTaskList[i].Priority > teamTaskList[j].Priority
			}
			return teamTaskList[i].CreatedAt.Before(teamTaskList[j].CreatedAt)
		})

		e.dispatchTasks(teamTaskList[:teamSlots], teamSlots)
	}
}

func (e *Engine) dispatchTasks(tasks []Task, maxSlots int) {
	dispatched := 0
	for _, t := range tasks {
		if dispatched >= maxSlots {
			break
		}
		// Get task spec to check GPU requirement
		fullTask, err := e.repo.GetTask(t.ID)
		if err != nil || fullTask.Spec == nil {
			continue
		}

		gpuNeeded := fullTask.Spec.GPUCount
		gpuAvailable := maxSlots - dispatched

		if gpuNeeded > gpuAvailable {
			continue
		}

		if err := e.repo.UpdateTaskStatus(t.ID, "running"); err != nil {
			log.Printf("[Scheduler] Failed to dispatch task %s: %v", t.ID, err)
			continue
		}

		e.repo.CreateTaskEvent(t.ID, "scheduled", map[string]interface{}{
			"pool":       t.PoolID,
			"gpu_count":  gpuNeeded,
			"policy":     "active",
		})

		dispatched += gpuNeeded
		log.Printf("[Scheduler] Dispatched task %s (%s) [%d GPU]", t.ID, t.Name, gpuNeeded)
	}
}

func countAvailableGPUs(nodes []Node) int {
	total := 0
	for _, n := range nodes {
		if n.Status == "online" {
			specs := string(n.Specs)
			// Parse gpu_count from specs JSON
			// Simple parsing - in production use proper JSON unmarshaling
			_ = specs
			total += 8 // default assumption, will be properly parsed
		}
	}
	return total
}

func countRunningGPUs(tasks []Task) int {
	total := 0
	for _, t := range tasks {
		_ = t
		total += 1 // simplified
	}
	return total
}
