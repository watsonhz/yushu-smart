package scheduler

import (
	"encoding/json"
	"time"
)

type ResourcePool struct {
	ID              string    `json:"id" gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	Name            string    `json:"name" gorm:"uniqueIndex;not null"`
	SchedulerPolicy string    `json:"scheduler_policy" gorm:"default:fifo"` // fifo | fair | priority
	Status          string    `json:"status" gorm:"default:active"`         // active | paused
	Labels          JSONB     `json:"labels"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

type PoolQueue struct {
	ID             string    `json:"id" gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	PoolID         string    `json:"pool_id" gorm:"type:uuid;not null"`
	TeamID         *string   `json:"team_id,omitempty" gorm:"type:uuid"`
	Name           string    `json:"name" gorm:"not null"`
	PriorityWeight int       `json:"priority_weight" gorm:"default:1"`
	MaxRunning     int       `json:"max_running" gorm:"default:5"`
	CreatedAt      time.Time `json:"created_at"`
}

type Node struct {
	ID            string     `json:"id" gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	PoolID        string     `json:"pool_id" gorm:"type:uuid;not null"`
	Hostname      string     `json:"hostname" gorm:"uniqueIndex;not null"`
	IPAddress     string     `json:"ip_address" gorm:"type:inet;not null"`
	Status        string     `json:"status" gorm:"default:online"` // online | offline | maintenance
	Specs         JSONB      `json:"specs"`
	Labels        JSONB      `json:"labels"`
	LastHeartbeat *time.Time `json:"last_heartbeat,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

type GPUDevice struct {
	ID            string  `json:"id" gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	NodeID        string  `json:"node_id" gorm:"type:uuid;not null"`
	Index         int     `json:"index" gorm:"not null"`
	MemoryTotalMB int     `json:"memory_total_mb"`
	MemoryUsedMB  int     `json:"memory_used_mb" gorm:"default:0"`
	Status        string  `json:"status" gorm:"default:free"` // free | allocated | error | degraded
	TemperatureC  float64 `json:"temperature_c,omitempty"`
	PowerW        float64 `json:"power_w,omitempty"`
	Topology      string  `json:"topology,omitempty"`
}

type Task struct {
	ID                   string     `json:"id" gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	TeamID               *string    `json:"team_id,omitempty" gorm:"type:uuid"`
	UserID               string     `json:"user_id" gorm:"type:uuid;not null"`
	PoolID               string     `json:"pool_id" gorm:"type:uuid;not null"`
	Name                 string     `json:"name" gorm:"not null"`
	Type                 string     `json:"type" gorm:"default:training"`
	Status               string     `json:"status" gorm:"default:pending"`
	Priority             int        `json:"priority" gorm:"default:50"`
	PreemptCount         int        `json:"preempt_count" gorm:"default:0"`
	QueuePosition        int        `json:"queue_position,omitempty" gorm:"default:0"`
	EstimatedWaitSeconds int        `json:"estimated_wait_seconds,omitempty" gorm:"default:0"`
	K8sJobName           string     `json:"k8s_job_name,omitempty"`
	CreatedAt            time.Time  `json:"created_at"`
	StartedAt            *time.Time `json:"started_at,omitempty"`
	CompletedAt          *time.Time `json:"completed_at,omitempty"`
	Spec                 *TaskSpec  `json:"spec,omitempty" gorm:"foreignKey:TaskID"`
	Events               []TaskEvent `json:"events,omitempty" gorm:"foreignKey:TaskID"`
}

type TaskSpec struct {
	ID                 string          `json:"-" gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	TaskID             string          `json:"-" gorm:"type:uuid;uniqueIndex;not null"`
	GPUCount           int             `json:"gpu_count" gorm:"not null"`
	GPUMemoryMB        int             `json:"gpu_memory_mb" gorm:"default:0"`
	CPUCores           int             `json:"cpu_cores" gorm:"default:1"`
	MemoryMB           int             `json:"memory_mb" gorm:"default:1024"`
	MaxRuntimeSeconds  int             `json:"max_runtime_seconds" gorm:"default:86400"`
	Image              string          `json:"image" gorm:"not null"`
	Entrypoint         string          `json:"entrypoint,omitempty"`
	EnvVars            json.RawMessage `json:"env_vars,omitempty" gorm:"type:jsonb;default:'{}'"`
	VolumeMounts       json.RawMessage `json:"volume_mounts,omitempty" gorm:"type:jsonb;default:'[]'"`
}

type TaskEvent struct {
	ID        string          `json:"id" gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	TaskID    string          `json:"task_id" gorm:"type:uuid;not null;index"`
	EventType string          `json:"event_type" gorm:"not null"`
	Detail    json.RawMessage `json:"detail,omitempty" gorm:"type:jsonb;default:'{}'"`
	CreatedAt time.Time       `json:"created_at"`
}

type NodeResource struct {
	NodeID      string       `json:"node_id"`
	GPUs        []GPUStatus  `json:"gpus"`
	CPUAvailable int         `json:"cpu_available"`
	MemAvailable int64       `json:"mem_available_mb"`
	LastUpdated time.Time    `json:"last_updated"`
}

type GPUStatus struct {
	Index       int     `json:"index"`
	TotalMemMB  int     `json:"total_mem_mb"`
	UsedMemMB   int     `json:"used_mem_mb"`
	Temperature float64 `json:"temperature_c"`
	PowerW      float64 `json:"power_w"`
	Status      string  `json:"status"`
}

type TaskFilter struct {
	Status    string   `json:"status,omitempty"`
	TeamID    string   `json:"team_id,omitempty"`
	UserID    string   `json:"user_id,omitempty"`
	PoolID    string   `json:"pool_id,omitempty"`
	StartTime string   `json:"start_time,omitempty"`
	EndTime   string   `json:"end_time,omitempty"`
	Page      int      `json:"page"`
	PageSize  int      `json:"page_size"`
}

type CreateTaskRequest struct {
	Name       string                `json:"name" binding:"required"`
	Type       string                `json:"type" binding:"required"`
	PoolID     string                `json:"pool_id" binding:"required"`
	Priority   int                   `json:"priority"`
	Spec       CreateTaskSpecRequest `json:"spec" binding:"required"`
}

type CreateTaskSpecRequest struct {
	GPUCount          int               `json:"gpu_count" binding:"required"`
	GPUMemoryMB       int               `json:"gpu_memory_mb"`
	CPUCores          int               `json:"cpu_cores"`
	MemoryMB          int               `json:"memory_mb"`
	MaxRuntimeSeconds int               `json:"max_runtime_seconds"`
	Image             string            `json:"image" binding:"required"`
	Entrypoint        string            `json:"entrypoint"`
	EnvVars           map[string]string `json:"env_vars"`
}

type JSONB []byte

func (j JSONB) MarshalJSON() ([]byte, error) {
	if j == nil {
		return []byte("{}"), nil
	}
	return []byte(j), nil
}

func (j *JSONB) UnmarshalJSON(data []byte) error {
	if j == nil {
		*j = make(JSONB, 0)
	}
	*j = append((*j)[:0], data...)
	return nil
}
