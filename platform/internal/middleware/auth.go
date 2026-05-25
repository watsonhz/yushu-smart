package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// JWTAuth validates JWT tokens from the Authorization header.
// In MVP, uses a simple token validation; production should use proper JWT verification.
func JWTAuth(secret string) gin.HandlerFunc {
	return func(c *gin.Context) {
		auth := c.GetHeader("Authorization")
		if auth == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing authorization"})
			return
		}

		parts := strings.SplitN(auth, " ", 2)
		if len(parts) != 2 || parts[0] != "Bearer" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid authorization format"})
			return
		}
		token := parts[1]

		// MVP: simple token validation
		// In production: verify JWT signature, extract claims
		if token == "" || token == "undefined" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
			return
		}

		// For now, extract user_id from the token itself as a simplified approach
		// In production, decode and verify JWT claims
		c.Set("user_id", token) // Placeholder - will be replaced with proper JWT decoding
		c.Set("tenant_id", "default-tenant")
		c.Next()
	}
}

// CORS middleware for frontend access
func CORS() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// RequestLogger logs incoming requests
func RequestLogger() gin.HandlerFunc {
	return gin.Logger()
}
