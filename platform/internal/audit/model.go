package audit

import (
	"encoding/json"
	"time"
)

type AuditEvent struct {
	ID            int64           `json:"id" gorm:"primaryKey;autoIncrement"`
	EventID       string          `json:"event_id" gorm:"type:uuid;uniqueIndex;not null"`
	TenantID      string          `json:"tenant_id" gorm:"type:uuid;not null;index"`
	ActorType     string          `json:"actor_type" gorm:"default:user"`
	ActorID       string          `json:"actor_id" gorm:"not null;index"`
	ActorName     string          `json:"actor_name"`
	ResourceType  string          `json:"resource_type" gorm:"not null;index"`
	ResourceID    string          `json:"resource_id" gorm:"not null;index"`
	ResourceName  string          `json:"resource_name"`
	Action        string          `json:"action" gorm:"not null;index"`
	Result        string          `json:"result" gorm:"default:success"`
	Detail        json.RawMessage `json:"detail,omitempty" gorm:"type:jsonb;default:'{}'"`
	ClientIP      string          `json:"client_ip,omitempty" gorm:"type:inet"`
	UserAgent     string          `json:"user_agent,omitempty"`
	Extra         json.RawMessage `json:"extra,omitempty" gorm:"type:jsonb;default:'{}'"`
	PrevEventHash string          `json:"prev_event_hash,omitempty"`
	EventHash     string          `json:"event_hash" gorm:"not null"`
	CreatedAt     time.Time       `json:"created_at" gorm:"not null;index"`
}

type CostRecord struct {
	ID               string    `json:"id" gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	TenantID         string    `json:"tenant_id" gorm:"type:uuid;not null;index"`
	TeamID           string    `json:"team_id" gorm:"type:uuid;not null;index"`
	TaskID           string    `json:"task_id" gorm:"type:uuid;uniqueIndex;not null"`
	TaskName         string    `json:"task_name"`
	GPUCount         int       `json:"gpu_count"`
	GPUModel         string    `json:"gpu_model"`
	DurationSeconds  int       `json:"duration_seconds"`
	UnitPricePerHour float64   `json:"unit_price_per_hour" gorm:"type:decimal(12,4)"`
	TotalCost        float64   `json:"total_cost" gorm:"type:decimal(14,4)"`
	BillingMode      string    `json:"billing_mode" gorm:"default:per_gpu_hour"`
	DiscountRate     float64   `json:"discount_rate" gorm:"type:decimal(4,2);default:1.00"`
	StartedAt        time.Time `json:"started_at"`
	EndedAt          time.Time `json:"ended_at"`
	Status           string    `json:"status" gorm:"default:pending;index"` // pending | settled | refunded
	CreatedAt        time.Time `json:"created_at"`
}

type PriceConfig struct {
	ID               string     `json:"id" gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	GPUModel         string     `json:"gpu_model" gorm:"uniqueIndex;not null"`
	UnitPrice        float64    `json:"unit_price" gorm:"type:decimal(12,4);not null"`
	BillingMode      string     `json:"billing_mode" gorm:"default:per_gpu_hour"`
	MinBillingSecs   int        `json:"min_billing_seconds" gorm:"default:60"`
	EffectiveFrom    time.Time  `json:"effective_from" gorm:"not null"`
	EffectiveTo      *time.Time `json:"effective_to,omitempty"`
	CreatedAt        time.Time  `json:"created_at"`
}

type AuditFilter struct {
	TenantID     string `json:"tenant_id,omitempty"`
	ActorID      string `json:"actor_id,omitempty"`
	ResourceType string `json:"resource_type,omitempty"`
	Action       string `json:"action,omitempty"`
	Result       string `json:"result,omitempty"`
	StartTime    string `json:"start_time,omitempty"`
	EndTime      string `json:"end_time,omitempty"`
	Page         int    `json:"page"`
	PageSize     int    `json:"page_size"`
	Sort         string `json:"sort,omitempty"`
}

type CreateAuditEventRequest struct {
	EventID      string          `json:"event_id" binding:"required"`
	TenantID     string          `json:"tenant_id" binding:"required"`
	ActorType    string          `json:"actor_type"`
	ActorID      string          `json:"actor_id" binding:"required"`
	ActorName    string          `json:"actor_name"`
	ResourceType string          `json:"resource_type" binding:"required"`
	ResourceID   string          `json:"resource_id" binding:"required"`
	ResourceName string          `json:"resource_name"`
	Action       string          `json:"action" binding:"required"`
	Result       string          `json:"result"`
	Detail       json.RawMessage `json:"detail"`
	ClientIP     string          `json:"client_ip"`
	UserAgent    string          `json:"user_agent"`
	Extra        json.RawMessage `json:"extra"`
}

type CostFilter struct {
	TeamID    string `json:"team_id,omitempty"`
	TenantID  string `json:"tenant_id,omitempty"`
	Status    string `json:"status,omitempty"`
	StartTime string `json:"start_time,omitempty"`
	EndTime   string `json:"end_time,omitempty"`
	Page      int    `json:"page"`
	PageSize  int    `json:"page_size"`
}

type CostSummary struct {
	TenantID      string  `json:"tenant_id,omitempty"`
	TeamID        string  `json:"team_id,omitempty"`
	TotalGPUHours float64 `json:"total_gpu_hours"`
	TotalCost     float64 `json:"total_cost"`
	TaskCount     int     `json:"task_count"`
}
