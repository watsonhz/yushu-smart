#!/bin/bash
# AI Training Platform - Quick Start
set -e

echo "🚀 AI Training Platform - Quick Start"
echo "====================================="

# Check prerequisites
command -v docker >/dev/null 2>&1 || { echo "❌ Docker is required. Install from https://docker.com"; exit 1; }
command -v docker-compose >/dev/null 2>&1 || { echo "❌ docker-compose is required"; exit 1; }

echo "✅ Docker found"

# Start services
echo "📦 Starting services..."
docker-compose up -d

echo ""
echo "✅ Platform is starting!"
echo "   Frontend: http://localhost:8080"
echo "   API:      http://localhost:8080/api/v1"
echo "   Health:   http://localhost:8080/health"
echo ""
echo "📋 To view logs: docker-compose logs -f platform"
echo "🛑 To stop:      docker-compose down"
