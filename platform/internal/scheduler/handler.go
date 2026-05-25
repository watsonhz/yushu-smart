package scheduler

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

func (h *Handler) RegisterRoutes(rg *gin.RouterGroup) {
	// Resource Pools
	rg.POST("/pools", h.CreatePool)
	rg.GET("/pools", h.ListPools)
	rg.GET("/pools/:id", h.GetPool)
	rg.PUT("/pools/:id", h.UpdatePool)
	rg.DELETE("/pools/:id", h.DeletePool)

	// Nodes
	rg.POST("/pools/:pool/nodes", h.CreateNode)
	rg.GET("/pools/:pool/nodes", h.ListNodes)
	rg.GET("/pools/:pool/nodes/:nid", h.GetNode)
	rg.PUT("/pools/:pool/nodes/:nid", h.UpdateNode)
	rg.DELETE("/pools/:pool/nodes/:nid", h.DeleteNode)
	rg.POST("/pools/:pool/nodes/:nid/drain", h.DrainNode)

	// Queues
	rg.POST("/pools/:pool/queues", h.CreateQueue)
	rg.GET("/pools/:pool/queues", h.ListQueues)

	// Tasks
	rg.POST("/tasks", h.CreateTask)
	rg.GET("/tasks", h.ListTasks)
	rg.GET("/tasks/:id", h.GetTask)
	rg.POST("/tasks/:id/cancel", h.CancelTask)
	rg.POST("/tasks/:id/priority", h.UpdatePriority)
	rg.GET("/tasks/:id/events", h.ListTaskEvents)
	rg.GET("/tasks/:id/logs", h.GetTaskLogs)

	// Queue Operations
	rg.GET("/queue", h.QueueStatus)
	rg.GET("/queue/stats", h.QueueStats)
	rg.POST("/queue/preempt", h.PreemptTask)
}

func (h *Handler) CreatePool(c *gin.Context) {
	var p ResourcePool
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.svc.CreatePool(&p); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, p)
}

func (h *Handler) ListPools(c *gin.Context) {
	pools, err := h.svc.ListPools()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": pools})
}

func (h *Handler) GetPool(c *gin.Context) {
	pool, err := h.svc.GetPool(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "pool not found"})
		return
	}
	c.JSON(http.StatusOK, pool)
}

func (h *Handler) UpdatePool(c *gin.Context) {
	var p ResourcePool
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.svc.UpdatePool(c.Param("id"), &p); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "updated"})
}

func (h *Handler) DeletePool(c *gin.Context) {
	if err := h.svc.DeletePool(c.Param("id")); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "deleted"})
}

func (h *Handler) CreateNode(c *gin.Context) {
	var n Node
	if err := c.ShouldBindJSON(&n); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	n.PoolID = c.Param("pool")
	if err := h.svc.CreateNode(&n); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, n)
}

func (h *Handler) ListNodes(c *gin.Context) {
	nodes, err := h.svc.ListNodes(c.Param("pool"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": nodes})
}

func (h *Handler) GetNode(c *gin.Context) {
	node, err := h.svc.GetNode(c.Param("nid"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "node not found"})
		return
	}
	c.JSON(http.StatusOK, node)
}

func (h *Handler) UpdateNode(c *gin.Context) {
	var n Node
	if err := c.ShouldBindJSON(&n); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.svc.UpdateNode(c.Param("nid"), &n); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "updated"})
}

func (h *Handler) DeleteNode(c *gin.Context) {
	if err := h.svc.DeleteNode(c.Param("nid")); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "deleted"})
}

func (h *Handler) DrainNode(c *gin.Context) {
	if err := h.svc.DrainNode(c.Param("nid")); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "draining"})
}

func (h *Handler) CreateQueue(c *gin.Context) {
	var q PoolQueue
	if err := c.ShouldBindJSON(&q); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	q.PoolID = c.Param("pool")
	if err := h.svc.CreateQueue(&q); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, q)
}

func (h *Handler) ListQueues(c *gin.Context) {
	queues, err := h.svc.ListQueues(c.Param("pool"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": queues})
}

// ── Task Handlers ──

func (h *Handler) CreateTask(c *gin.Context) {
	var req CreateTaskRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	userID := c.GetString("user_id")

	task, waitTime, err := h.svc.SubmitTask(userID, &req)
	if err != nil {
		status := http.StatusInternalServerError
		switch {
		case err.Error() == "SCHED_QUOTA_EXCEEDED":
			status = http.StatusForbidden
		case err.Error() == "SCHED_INVALID_SPEC":
			status = http.StatusBadRequest
		case err.Error() == "SCHED_POOL_FULL":
			status = http.StatusServiceUnavailable
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusAccepted, gin.H{
		"id":                      task.ID,
		"status":                  "queued",
		"queue_position":          task.QueuePosition,
		"estimated_wait_seconds":  waitTime,
		"created_at":              task.CreatedAt,
	})
}

func (h *Handler) ListTasks(c *gin.Context) {
	f := TaskFilter{
		Status:    c.Query("status"),
		TeamID:    c.Query("team_id"),
		UserID:    c.Query("user_id"),
		PoolID:    c.Query("pool_id"),
		StartTime: c.Query("start"),
		EndTime:   c.Query("end"),
		Page:      parseQueryInt(c.Query("page"), 1),
		PageSize:  parseQueryInt(c.Query("page_size"), 20),
	}
	tasks, total, err := h.svc.ListTasks(f)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": tasks, "total": total, "page": f.Page, "page_size": f.PageSize})
}

func (h *Handler) GetTask(c *gin.Context) {
	task, err := h.svc.GetTask(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "task not found"})
		return
	}
	c.JSON(http.StatusOK, task)
}

func (h *Handler) CancelTask(c *gin.Context) {
	if err := h.svc.CancelTask(c.Param("id")); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "cancelled"})
}

func (h *Handler) UpdatePriority(c *gin.Context) {
	var req struct {
		Priority int `json:"priority" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.svc.UpdatePriority(c.Param("id"), req.Priority); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "updated"})
}

func (h *Handler) ListTaskEvents(c *gin.Context) {
	events, err := h.svc.ListTaskEvents(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "task not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": events})
}

func (h *Handler) GetTaskLogs(c *gin.Context) {
	logs, err := h.svc.GetTaskLogs(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"logs": logs})
}

// ── Queue Handlers ──

func (h *Handler) QueueStatus(c *gin.Context) {
	status, err := h.svc.QueueStatus()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, status)
}

func (h *Handler) QueueStats(c *gin.Context) {
	stats, err := h.svc.QueueStats()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, stats)
}

func (h *Handler) PreemptTask(c *gin.Context) {
	var req struct {
		TaskID      string `json:"task_id" binding:"required"`
		VictimID    string `json:"victim_task_id" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	result, err := h.svc.PreemptTask(req.TaskID, req.VictimID)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, result)
}

func parseQueryInt(s string, defaultVal int) int {
	if s == "" {
		return defaultVal
	}
	v, err := strconv.Atoi(s)
	if err != nil {
		return defaultVal
	}
	return v
}
