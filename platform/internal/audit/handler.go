package audit

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
	// Public API
	rg.GET("/audit-events", h.ListAuditEvents)
	rg.GET("/audit-events/export", h.ExportAuditEvents)
	rg.GET("/audit-events/:id", h.GetAuditEvent)

	// Cost Records
	rg.GET("/cost-records", h.ListCostRecords)
	rg.GET("/cost-records/summary", h.GetCostSummary)
	rg.GET("/cost-records/export", h.ExportCostRecords)

	// Internal API (service-to-service)
	internal := rg.Group("/internal")
	internal.Use(h.internalAuth())
	{
		internal.POST("/audit-events", h.CreateAuditEvent)
	}
}

func (h *Handler) internalAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		token := c.GetHeader("X-Internal-Token")
		if token != h.svc.internalToken {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid internal token"})
			return
		}
		c.Next()
	}
}

func (h *Handler) CreateAuditEvent(c *gin.Context) {
	var req CreateAuditEventRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.svc.CreateAuditEvent(&req); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusAccepted, gin.H{"event_id": req.EventID, "status": "accepted"})
}

func (h *Handler) ListAuditEvents(c *gin.Context) {
	f := AuditFilter{
		TenantID:     c.Query("tenant_id"),
		ActorID:      c.Query("actor_id"),
		ResourceType: c.Query("resource_type"),
		Action:       c.Query("action"),
		Result:       c.Query("result"),
		StartTime:    c.Query("start"),
		EndTime:      c.Query("end"),
		Page:         parseQueryInt(c.Query("page"), 1),
		PageSize:     parseQueryInt(c.Query("page_size"), 50),
	}
	events, total, err := h.svc.ListAuditEvents(f)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": events, "total": total, "page": f.Page, "page_size": f.PageSize})
}

func (h *Handler) GetAuditEvent(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	event, err := h.svc.GetAuditEvent(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "event not found"})
		return
	}
	c.JSON(http.StatusOK, event)
}

func (h *Handler) ExportAuditEvents(c *gin.Context) {
	f := AuditFilter{
		TenantID:  c.Query("tenant_id"),
		StartTime: c.Query("start"),
		EndTime:   c.Query("end"),
	}
	csvData, err := h.svc.ExportAuditEventsCSV(f)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Header("Content-Disposition", "attachment; filename=audit_events.csv")
	c.String(http.StatusOK, csvData)
}

func (h *Handler) ListCostRecords(c *gin.Context) {
	f := CostFilter{
		TeamID:    c.Query("team_id"),
		TenantID:  c.Query("tenant_id"),
		Status:    c.Query("status"),
		StartTime: c.Query("start"),
		EndTime:   c.Query("end"),
		Page:      parseQueryInt(c.Query("page"), 1),
		PageSize:  parseQueryInt(c.Query("page_size"), 50),
	}
	records, total, err := h.svc.ListCostRecords(f)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": records, "total": total, "page": f.Page, "page_size": f.PageSize})
}

func (h *Handler) GetCostSummary(c *gin.Context) {
	tenantID := c.Query("tenant_id")
	if tenantID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "tenant_id required"})
		return
	}
	startTime := c.Query("start")
	endTime := c.Query("end")

	summary, err := h.svc.GetCostSummary(tenantID, startTime, endTime)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": summary})
}

func (h *Handler) ExportCostRecords(c *gin.Context) {
	f := CostFilter{
		TenantID:  c.Query("tenant_id"),
		TeamID:    c.Query("team_id"),
		StartTime: c.Query("start"),
		EndTime:   c.Query("end"),
	}
	csvData, err := h.svc.ExportCostRecordsCSV(f)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Header("Content-Disposition", "attachment; filename=cost_records.csv")
	c.String(http.StatusOK, csvData)
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
