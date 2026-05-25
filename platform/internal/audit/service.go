package audit

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"math"
	"time"
)

type Service struct {
	repo          *Repository
	internalToken string
}

func NewService(repo *Repository, internalToken string) *Service {
	return &Service{repo: repo, internalToken: internalToken}
}

// ── Audit Events ──

func (s *Service) CreateAuditEvent(req *CreateAuditEventRequest) error {
	if req.ActorType == "" {
		req.ActorType = "user"
	}
	if req.Result == "" {
		req.Result = "success"
	}

	event := &AuditEvent{
		EventID:      req.EventID,
		TenantID:     req.TenantID,
		ActorType:    req.ActorType,
		ActorID:      req.ActorID,
		ActorName:    req.ActorName,
		ResourceType: req.ResourceType,
		ResourceID:   req.ResourceID,
		ResourceName: req.ResourceName,
		Action:       req.Action,
		Result:       req.Result,
		Detail:       req.Detail,
		ClientIP:     req.ClientIP,
		UserAgent:    req.UserAgent,
		Extra:        req.Extra,
	}
	return s.repo.CreateAuditEvent(event)
}

func (s *Service) ListAuditEvents(f AuditFilter) ([]AuditEvent, int, error) {
	if f.Page < 1 {
		f.Page = 1
	}
	if f.PageSize < 1 || f.PageSize > 100 {
		f.PageSize = 50
	}
	return s.repo.ListAuditEvents(f)
}

func (s *Service) GetAuditEvent(id int64) (*AuditEvent, error) {
	return s.repo.GetAuditEvent(id)
}

func (s *Service) ExportAuditEventsCSV(f AuditFilter) (string, error) {
	events, err := s.repo.ExportAuditEvents(f)
	if err != nil {
		return "", err
	}
	if len(events) > 100000 {
		return "", errors.New("AUDIT_EXPORT_TOO_LARGE: export limited to 100,000 records")
	}

	var buf bytes.Buffer
	writer := csv.NewWriter(&buf)
	writer.Write([]string{"ID", "EventID", "TenantID", "ActorType", "ActorID", "ActorName",
		"ResourceType", "ResourceID", "ResourceName", "Action", "Result",
		"ClientIP", "UserAgent", "CreatedAt"})

	for _, e := range events {
		writer.Write([]string{
			fmt.Sprintf("%d", e.ID),
			e.EventID, e.TenantID, e.ActorType, e.ActorID, e.ActorName,
			e.ResourceType, e.ResourceID, e.ResourceName, e.Action, e.Result,
			e.ClientIP, e.UserAgent,
			e.CreatedAt.Format(time.RFC3339),
		})
	}
	writer.Flush()
	return buf.String(), nil
}

// ── Cost Records ──

func (s *Service) CreateCostRecord(tenantID, teamID string, task AuditEvent, gpuCount int, gpuModel string, startedAt, endedAt time.Time) (*CostRecord, error) {
	price, err := s.repo.GetPriceConfig(gpuModel)
	if err != nil {
		// Default pricing if no config found
		price = &PriceConfig{UnitPrice: 10.0, MinBillingSecs: 60}
	}

	duration := int(endedAt.Sub(startedAt).Seconds())
	if duration < price.MinBillingSecs {
		duration = price.MinBillingSecs
	}
	gpuHours := float64(duration) / 3600.0 * float64(gpuCount)
	totalCost := gpuHours * price.UnitPrice
	totalCost = math.Round(totalCost*100) / 100

	record := &CostRecord{
		TenantID:         tenantID,
		TeamID:           teamID,
		TaskID:           task.ResourceID,
		TaskName:         task.ResourceName,
		GPUCount:         gpuCount,
		GPUModel:         gpuModel,
		DurationSeconds:  duration,
		UnitPricePerHour: price.UnitPrice,
		TotalCost:        totalCost,
		BillingMode:      "per_gpu_hour",
		DiscountRate:     1.00,
		StartedAt:        startedAt,
		EndedAt:          endedAt,
		Status:           "pending",
	}
	if err := s.repo.CreateCostRecord(record); err != nil {
		return nil, err
	}
	return record, nil
}

func (s *Service) ListCostRecords(f CostFilter) ([]CostRecord, int, error) {
	if f.Page < 1 {
		f.Page = 1
	}
	if f.PageSize < 1 || f.PageSize > 100 {
		f.PageSize = 50
	}
	return s.repo.ListCostRecords(f)
}

func (s *Service) GetCostSummary(tenantID, startTime, endTime string) ([]CostSummary, error) {
	if startTime == "" {
		startTime = time.Now().Add(-30 * 24 * time.Hour).Format(time.RFC3339)
	}
	if endTime == "" {
		endTime = time.Now().Format(time.RFC3339)
	}
	return s.repo.GetCostSummaryByTeam(tenantID, startTime, endTime)
}

func (s *Service) ExportCostRecordsCSV(f CostFilter) (string, error) {
	records, _, err := s.repo.ListCostRecords(f)
	if err != nil {
		return "", err
	}
	if len(records) > 100000 {
		return "", errors.New("export limited to 100,000 records")
	}

	var buf bytes.Buffer
	writer := csv.NewWriter(&buf)
	writer.Write([]string{"ID", "TenantID", "TeamID", "TaskID", "TaskName", "GPUCount", "GPUModel",
		"DurationSeconds", "UnitPricePerHour", "TotalCost", "BillingMode",
		"DiscountRate", "StartedAt", "EndedAt", "Status"})

	for _, r := range records {
		writer.Write([]string{
			r.ID, r.TenantID, r.TeamID, r.TaskID, r.TaskName,
			fmt.Sprintf("%d", r.GPUCount), r.GPUModel,
			fmt.Sprintf("%d", r.DurationSeconds),
			fmt.Sprintf("%.4f", r.UnitPricePerHour),
			fmt.Sprintf("%.4f", r.TotalCost),
			r.BillingMode, fmt.Sprintf("%.2f", r.DiscountRate),
			r.StartedAt.Format(time.RFC3339),
			r.EndedAt.Format(time.RFC3339),
			r.Status,
		})
	}
	writer.Flush()
	return buf.String(), nil
}
