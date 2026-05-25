package audit

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/go-redis/redis/v8"
)

type Worker struct {
	redisClient *redis.Client
	repo        *Repository
	streamKey   string
	groupName   string
	consumerID  string
	ctx         context.Context
	cancel      context.CancelFunc
	wg          sync.WaitGroup
}

func NewWorker(redisClient *redis.Client, repo *Repository, groupName, consumerID string) *Worker {
	return &Worker{
		redisClient: redisClient,
		repo:        repo,
		streamKey:   "audit:stream",
		groupName:   groupName,
		consumerID:  consumerID,
	}
}

func (w *Worker) Start(ctx context.Context) {
	w.ctx, w.cancel = context.WithCancel(ctx)
	w.wg.Add(1)
	go w.loop()
	log.Println("[Audit Worker] Started")
}

func (w *Worker) Stop() {
	if w.cancel != nil {
		w.cancel()
	}
	w.wg.Wait()
	log.Println("[Audit Worker] Stopped")
}

func (w *Worker) loop() {
	defer w.wg.Done()

	// Ensure consumer group exists
	w.redisClient.XGroupCreateMkStream(w.ctx, w.streamKey, w.groupName, "0").Err()

	for {
		select {
		case <-w.ctx.Done():
			return
		default:
			w.processBatch()
		}
	}
}

func (w *Worker) processBatch() {
	// Read batch of events
	streams, err := w.redisClient.XReadGroup(w.ctx, &redis.XReadGroupArgs{
		Group:    w.groupName,
		Consumer: w.consumerID,
		Streams:  []string{w.streamKey, ">"},
		Count:    10,
		Block:    2 * time.Second,
	}).Result()
	if err != nil {
		if err == redis.Nil {
			return
		}
		log.Printf("[Audit Worker] Read error: %v", err)
		time.Sleep(time.Second)
		return
	}

	for _, stream := range streams {
		for _, msg := range stream.Messages {
			w.processMessage(msg.ID, msg.Values)
		}
	}
}

func (w *Worker) processMessage(msgID string, values map[string]interface{}) {
	data, ok := values["event"].(string)
	if !ok {
		// Not our format, skip
		w.redisClient.XAck(w.ctx, w.streamKey, w.groupName, msgID)
		return
	}

	var req CreateAuditEventRequest
	if err := json.Unmarshal([]byte(data), &req); err != nil {
		log.Printf("[Audit Worker] Invalid event data: %v", err)
		w.redisClient.XAck(w.ctx, w.streamKey, w.groupName, msgID)
		// Move to DLQ
		w.redisClient.XAdd(w.ctx, &redis.XAddArgs{
			Stream: "audit:dlq",
			Values: map[string]interface{}{
				"original_msg_id": msgID,
				"event":           data,
				"error":           err.Error(),
			},
		})
		return
	}

	if err := w.repo.CreateAuditEvent(&AuditEvent{
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
	}); err != nil {
		log.Printf("[Audit Worker] Failed to persist event: %v", err)
		return
	}

	w.redisClient.XAck(w.ctx, w.streamKey, w.groupName, msgID)
}
