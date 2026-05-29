#!/usr/bin/env bash
# ============================================================
# CE-Tech Automation — Ops Health Check Script
# Usage: ./scripts/healthcheck.sh [--url http://localhost:3000] [--verbose]
# ============================================================

set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"
VERBOSE=false
FAILED=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_pass() { echo -e "${GREEN}✅ $1${NC}"; }
log_fail() { echo -e "${RED}❌ $1${NC}"; FAILED=$((FAILED + 1)); }
log_warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_info() { echo -e "   $1"; }

echo ""
echo "=================================================="
echo "  CE-Tech Automation — Health Check"
echo "  Target: $BASE_URL"
echo "  Time:   $(date '+%Y-%m-%d %H:%M:%S')"
echo "=================================================="
echo ""

# ----------------------------------------------------------
# 1. Basic HTTP reachability
# ----------------------------------------------------------
echo "1. HTTP Reachability"
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$BASE_URL/health" 2>/dev/null || echo "000")
if [ "$HTTP_STATUS" = "200" ]; then
  log_pass "Service reachable (HTTP $HTTP_STATUS)"
else
  log_fail "Service unreachable (HTTP $HTTP_STATUS)"
fi

# ----------------------------------------------------------
# 2. Health endpoint content
# ----------------------------------------------------------
echo ""
echo "2. Health Endpoint"
HEALTH_BODY=$(curl -s --max-time 5 "$BASE_URL/health" 2>/dev/null || echo '{}')
STATUS=$(echo "$HEALTH_BODY" | grep -o '"status":"[^"]*"' | cut -d'"' -f4 || echo "unknown")
if [ "$STATUS" = "ok" ]; then
  log_pass "Health status: $STATUS"
  UPTIME=$(echo "$HEALTH_BODY" | grep -o '"uptime":[0-9]*' | cut -d':' -f2 || echo "0")
  log_info "Uptime: ${UPTIME}s"
else
  log_fail "Health status: $STATUS (expected ok)"
fi

# ----------------------------------------------------------
# 3. Detailed health (MongoDB, memory)
# ----------------------------------------------------------
echo ""
echo "3. Detailed Health (Services)"
DETAILED=$(curl -s --max-time 5 "$BASE_URL/health/detailed" 2>/dev/null || echo '{}')
MONGO_STATE=$(echo "$DETAILED" | grep -o '"mongodb":"[^"]*"' | cut -d'"' -f4 || echo "unknown")
if [ "$MONGO_STATE" = "connected" ]; then
  log_pass "MongoDB: $MONGO_STATE"
else
  log_fail "MongoDB: $MONGO_STATE (expected connected)"
fi

HEAP=$(echo "$DETAILED" | grep -o '"heapUsedMB":[0-9]*' | cut -d':' -f2 || echo "0")
if [ -n "$HEAP" ] && [ "$HEAP" -lt 350 ]; then
  log_pass "Heap memory: ${HEAP}MB"
else
  log_warn "Heap memory: ${HEAP}MB (approaching limit)"
fi

# ----------------------------------------------------------
# 4. API Issues endpoint
# ----------------------------------------------------------
echo ""
echo "4. Issues API"
ISSUES_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
  -H "X-Api-Key: ${API_KEY:-}" \
  "$BASE_URL/api/issues?limit=1" 2>/dev/null || echo "000")
if [ "$ISSUES_STATUS" = "200" ]; then
  log_pass "Issues API responds (HTTP $ISSUES_STATUS)"
elif [ "$ISSUES_STATUS" = "401" ]; then
  log_warn "Issues API requires API key (set API_KEY env var for full check)"
else
  log_fail "Issues API failed (HTTP $ISSUES_STATUS)"
fi

# ----------------------------------------------------------
# 5. Routing API
# ----------------------------------------------------------
echo ""
echo "5. Routing API"
ROUTING_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
  -H "X-Api-Key: ${API_KEY:-}" \
  "$BASE_URL/api/routing" 2>/dev/null || echo "000")
if [ "$ROUTING_STATUS" = "200" ] || [ "$ROUTING_STATUS" = "401" ]; then
  log_pass "Routing API responds (HTTP $ROUTING_STATUS)"
else
  log_fail "Routing API failed (HTTP $ROUTING_STATUS)"
fi

# ----------------------------------------------------------
# Summary
# ----------------------------------------------------------
echo ""
echo "=================================================="
if [ "$FAILED" -eq 0 ]; then
  echo -e "${GREEN}  ✅ All checks passed${NC}"
  exit 0
else
  echo -e "${RED}  ❌ $FAILED check(s) failed${NC}"
  exit 1
fi
