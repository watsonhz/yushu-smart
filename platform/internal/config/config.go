package config

import (
	"fmt"
	"os"
	"strconv"
)

type Config struct {
	ServerPort     int
	DatabaseURL    string
	RedisURL       string
	JWTSecret      string
	InternalToken  string
	SchedulerTick  int // seconds between scheduler ticks
	KubeConfigPath string
}

func Load() *Config {
	return &Config{
		ServerPort:     getEnvInt("SERVER_PORT", 8080),
		DatabaseURL:    getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/mlplatform?sslmode=disable"),
		RedisURL:       getEnv("REDIS_URL", "redis://localhost:6379/0"),
		JWTSecret:      getEnv("JWT_SECRET", "dev-secret-change-in-production"),
		InternalToken:  getEnv("INTERNAL_TOKEN", "svc-token-change-me"),
		SchedulerTick:  getEnvInt("SCHEDULER_TICK_SECONDS", 5),
		KubeConfigPath: getEnv("KUBECONFIG", ""),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			return i
		}
	}
	return fallback
}

func (c *Config) Address() string {
	return fmt.Sprintf(":%d", c.ServerPort)
}
