package audit

import (
	"crypto/sha256"
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

// ── Audit Events ──

func (r *Repository) CreateAuditEvent(e *AuditEvent) error {
	e.CreatedAt = time.Now()

	// Build hash chain
	var prevHash string
	r.db.QueryRow(`SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1`).Scan(&prevHash)
	e.PrevEventHash = prevHash

	hashInput := fmt.Sprintf("%s|%s|%s|%s|%s|%s|%s|%d|%s",
		e.EventID, e.TenantID, e.ActorID, e.ResourceID, e.Action, e.Result,
		string(e.Detail), e.CreatedAt.UnixNano(), prevHash)
	e.EventHash = sha256Hex(hashInput)

	detailJSON, _ := json.Marshal(e.Detail)
	extraJSON, _ := json.Marshal(e.Extra)
	_, err := r.db.Exec(`
		INSERT INTO audit_events (event_id, tenant_id, actor_type, actor_id, actor_name,
		                           resource_type, resource_id, resource_name, action, result,
		                           detail, client_ip, user_agent, extra, prev_event_hash, event_hash, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
		e.EventID, e.TenantID, e.ActorType, e.ActorID, e.ActorName,
		e.ResourceType, e.ResourceID, e.ResourceName, e.Action, e.Result,
		detailJSON, e.ClientIP, e.UserAgent, extraJSON, e.PrevEventHash, e.EventHash, e.CreatedAt)
	return err
}

func (r *Repository) ListAuditEvents(f AuditFilter) ([]AuditEvent, int, error) {
	where := []string{}
	args := []interface{}{}
	idx := 1

	if f.TenantID != "" {
		where = append(where, fmt.Sprintf("tenant_id = $%d", idx))
		args = append(args, f.TenantID)
		idx++
	}
	if f.ActorID != "" {
		where = append(where, fmt.Sprintf("actor_id = $%d", idx))
		args = append(args, f.ActorID)
		idx++
	}
	if f.ResourceType != "" {
		where = append(where, fmt.Sprintf("resource_type = $%d", idx))
		args = append(args, f.ResourceType)
		idx++
	}
	if f.Action != "" {
		where = append(where, fmt.Sprintf("action = $%d", idx))
		args = append(args, f.Action)
		idx++
	}
	if f.Result != "" {
		where = append(where, fmt.Sprintf("result = $%d", idx))
		args = append(args, f.Result)
		idx++
	}
	if f.StartTime != "" {
		where = append(where, fmt.Sprintf("created_at >= $%d", idx))
		args = append(args, f.StartTime)
		idx++
	}
	if f.EndTime != "" {
		where = append(where, fmt.Sprintf("created_at <= $%d", idx))
		args = append(args, f.EndTime)
		idx++
	}

	whereClause := ""
	if len(where) > 0 {
		whereClause = " WHERE " + strings.Join(where, " AND ")
	}

	var total int
	r.db.QueryRow("SELECT COUNT(*) FROM audit_events"+whereClause, args...).Scan(&total)

	if f.Page < 1 {
		f.Page = 1
	}
	if f.PageSize < 1 || f.PageSize > 100 {
		f.PageSize = 20
	}
	offset := (f.Page - 1) * f.PageSize

	sortClause := "ORDER BY created_at DESC"
	if f.Sort != "" {
		if strings.Contains(f.Sort, "created_at asc") {
			sortClause = "ORDER BY created_at ASC"
		}
	}

	query := `SELECT id, event_id, tenant_id, actor_type, actor_id, actor_name,
	                  resource_type, resource_id, resource_name, action, result,
	                  client_ip, user_agent, created_at
	           FROM audit_events` + whereClause + ` ` + sortClause +
		` LIMIT $` + fmt.Sprintf("%d", idx) + ` OFFSET $` + fmt.Sprintf("%d", idx+1)

	rows, err := r.db.Query(query, append(args, f.PageSize, offset)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var events []AuditEvent
	for rows.Next() {
		var e AuditEvent
		if err := rows.Scan(&e.ID, &e.EventID, &e.TenantID, &e.ActorType, &e.ActorID, &e.ActorName,
			&e.ResourceType, &e.ResourceID, &e.ResourceName, &e.Action, &e.Result,
			&e.ClientIP, &e.UserAgent, &e.CreatedAt); err != nil {
			return nil, 0, err
		}
		events = append(events, e)
	}
	return events, total, nil
}

func (r *Repository) GetAuditEvent(id int64) (*AuditEvent, error) {
	e := &AuditEvent{}
	err := r.db.QueryRow(`
		SELECT id, event_id, tenant_id, actor_type, actor_id, actor_name,
		       resource_type, resource_id, resource_name, action, result,
		       detail::text, client_ip, user_agent, extra::text,
		       prev_event_hash, event_hash, created_at
		FROM audit_events WHERE id = $1`, id).Scan(
		&e.ID, &e.EventID, &e.TenantID, &e.ActorType, &e.ActorID, &e.ActorName,
		&e.ResourceType, &e.ResourceID, &e.ResourceName, &e.Action, &e.Result,
		&e.Detail, &e.ClientIP, &e.UserAgent, &e.Extra,
		&e.PrevEventHash, &e.EventHash, &e.CreatedAt)
	if err != nil {
		return nil, err
	}
	return e, nil
}

// ── Cost Records ──

func (r *Repository) CreateCostRecord(c *CostRecord) error {
	c.CreatedAt = time.Now()
	return r.db.QueryRow(`
		INSERT INTO cost_records (tenant_id, team_id, task_id, task_name, gpu_count, gpu_model,
		                           duration_seconds, unit_price_per_hour, total_cost, billing_mode,
		                           discount_rate, started_at, ended_at, status, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
		RETURNING id`,
		c.TenantID, c.TeamID, c.TaskID, c.TaskName, c.GPUCount, c.GPUModel,
		c.DurationSeconds, c.UnitPricePerHour, c.TotalCost, c.BillingMode,
		c.DiscountRate, c.StartedAt, c.EndedAt, c.Status, c.CreatedAt).Scan(&c.ID)
}

func (r *Repository) ListCostRecords(f CostFilter) ([]CostRecord, int, error) {
	where := []string{}
	args := []interface{}{}
	idx := 1

	if f.TeamID != "" {
		where = append(where, fmt.Sprintf("team_id = $%d", idx))
		args = append(args, f.TeamID)
		idx++
	}
	if f.TenantID != "" {
		where = append(where, fmt.Sprintf("tenant_id = $%d", idx))
		args = append(args, f.TenantID)
		idx++
	}
	if f.Status != "" {
		where = append(where, fmt.Sprintf("status = $%d", idx))
		args = append(args, f.Status)
		idx++
	}

	whereClause := ""
	if len(where) > 0 {
		whereClause = " WHERE " + strings.Join(where, " AND ")
	}

	var total int
	r.db.QueryRow("SELECT COUNT(*) FROM cost_records"+whereClause, args...).Scan(&total)

	if f.Page < 1 {
		f.Page = 1
	}
	if f.PageSize < 1 || f.PageSize > 100 {
		f.PageSize = 20
	}
	offset := (f.Page - 1) * f.PageSize

	rows, err := r.db.Query(`
		SELECT id, tenant_id, team_id, task_id, task_name, gpu_count, gpu_model,
		       duration_seconds, unit_price_per_hour, total_cost, billing_mode,
		       discount_rate, started_at, ended_at, status, created_at
		FROM cost_records`+whereClause+` ORDER BY created_at DESC
		LIMIT $`+fmt.Sprintf("%d", idx)+` OFFSET $`+fmt.Sprintf("%d", idx+1),
		append(args, f.PageSize, offset)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var records []CostRecord
	for rows.Next() {
		var c CostRecord
		if err := rows.Scan(&c.ID, &c.TenantID, &c.TeamID, &c.TaskID, &c.TaskName,
			&c.GPUCount, &c.GPUModel, &c.DurationSeconds, &c.UnitPricePerHour, &c.TotalCost,
			&c.BillingMode, &c.DiscountRate, &c.StartedAt, &c.EndedAt, &c.Status, &c.CreatedAt); err != nil {
			return nil, 0, err
		}
		records = append(records, c)
	}
	return records, total, nil
}

func (r *Repository) GetCostSummaryByTeam(tenantID, startTime, endTime string) ([]CostSummary, error) {
	rows, err := r.db.Query(`
		SELECT team_id,
		       COALESCE(SUM(duration_seconds)/3600.0, 0) as total_gpu_hours,
		       COALESCE(SUM(total_cost), 0) as total_cost,
		       COUNT(*) as task_count
		FROM cost_records
		WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3 AND status != 'refunded'
		GROUP BY team_id ORDER BY total_cost DESC`,
		tenantID, startTime, endTime)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var summaries []CostSummary
	for rows.Next() {
		var s CostSummary
		s.TenantID = tenantID
		if err := rows.Scan(&s.TeamID, &s.TotalGPUHours, &s.TotalCost, &s.TaskCount); err != nil {
			return nil, err
		}
		summaries = append(summaries, s)
	}
	return summaries, nil
}

// ── Price Configs ──

func (r *Repository) GetPriceConfig(gpuModel string) (*PriceConfig, error) {
	p := &PriceConfig{}
	err := r.db.QueryRow(`
		SELECT id, gpu_model, unit_price, billing_mode, min_billing_seconds,
		       effective_from, effective_to, created_at
		FROM price_configs WHERE gpu_model = $1 AND (effective_to IS NULL OR effective_to > now())
		ORDER BY effective_from DESC LIMIT 1`, gpuModel).Scan(
		&p.ID, &p.GPUModel, &p.UnitPrice, &p.BillingMode, &p.MinBillingSecs,
		&p.EffectiveFrom, &p.EffectiveTo, &p.CreatedAt)
	if err != nil {
		return nil, err
	}
	return p, nil
}

// ── CSV Export ──

func (r *Repository) ExportAuditEvents(f AuditFilter) ([]AuditEvent, error) {
	where := []string{}
	args := []interface{}{}
	idx := 1

	if f.TenantID != "" {
		where = append(where, fmt.Sprintf("tenant_id = $%d", idx))
		args = append(args, f.TenantID)
		idx++
	}
	if f.StartTime != "" {
		where = append(where, fmt.Sprintf("created_at >= $%d", idx))
		args = append(args, f.StartTime)
		idx++
	}
	if f.EndTime != "" {
		where = append(where, fmt.Sprintf("created_at <= $%d", idx))
		args = append(args, f.EndTime)
		idx++
	}

	whereClause := ""
	if len(where) > 0 {
		whereClause = " WHERE " + strings.Join(where, " AND ")
	}

	rows, err := r.db.Query(`
		SELECT id, event_id, tenant_id, actor_type, actor_id, actor_name,
		       resource_type, resource_id, resource_name, action, result,
		       client_ip, user_agent, created_at
		FROM audit_events`+whereClause+` ORDER BY created_at LIMIT 100000`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []AuditEvent
	for rows.Next() {
		var e AuditEvent
		if err := rows.Scan(&e.ID, &e.EventID, &e.TenantID, &e.ActorType, &e.ActorID, &e.ActorName,
			&e.ResourceType, &e.ResourceID, &e.ResourceName, &e.Action, &e.Result,
			&e.ClientIP, &e.UserAgent, &e.CreatedAt); err != nil {
			return nil, err
		}
		events = append(events, e)
	}
	return events, nil
}

func sha256Hex(input string) string {
	h := sha256.Sum256([]byte(input))
	return fmt.Sprintf("%x", h)
}
