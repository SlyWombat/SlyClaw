#!/bin/bash
#
#   ____  _            ____ _
#  / ___|| |_   _     / ___| | __ ___      __
#  \___ \| | | | |   | |   | |/ _` \ \ /\ / /
#   ___) | | |_| |   | |___| | (_| |\ V  V /
#  |____/|_|\__, |    \____|_|\__,_| \_/\_/
#           |___/
#  Cunning. Sturdy. Open.
#
#  Based on the NanoClaw project. Modified by Sly Wombat.
#
set -euo pipefail

# 09-verify.sh — End-to-end health check of the full installation

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [verify] $*" >> "$LOG_FILE"; }

cd "$PROJECT_ROOT"

log "Starting verification"

# Detect platform
case "$(uname -s)" in
  Darwin*) PLATFORM="macos" ;;
  Linux*)  PLATFORM="linux" ;;
  *)       PLATFORM="unknown" ;;
esac

# 1. Check service status
SERVICE="not_found"
if [ "$PLATFORM" = "macos" ]; then
  if launchctl list 2>/dev/null | grep -q "com.slyclaw"; then
    # Check if it has a PID (actually running)
    LAUNCHCTL_LINE=$(launchctl list 2>/dev/null | grep "com.slyclaw" || true)
    PID_FIELD=$(echo "$LAUNCHCTL_LINE" | awk '{print $1}')
    if [ "$PID_FIELD" != "-" ] && [ -n "$PID_FIELD" ]; then
      SERVICE="running"
    else
      SERVICE="stopped"
    fi
  fi
elif [ "$PLATFORM" = "linux" ]; then
  if systemctl --user is-active slyclaw >/dev/null 2>&1; then
    SERVICE="running"
  elif systemctl --user list-unit-files 2>/dev/null | grep -q "slyclaw"; then
    SERVICE="stopped"
  fi
fi
log "Service: $SERVICE"

# 2. Check container runtime
CONTAINER_RUNTIME="none"
if command -v container >/dev/null 2>&1; then
  CONTAINER_RUNTIME="apple-container"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  CONTAINER_RUNTIME="docker"
fi
log "Container runtime: $CONTAINER_RUNTIME"

# 3. Check credentials
CREDENTIALS="missing"
if [ -f "$PROJECT_ROOT/.env" ]; then
  if grep -qE "^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=" "$PROJECT_ROOT/.env" 2>/dev/null; then
    CREDENTIALS="configured"
  fi
fi
log "Credentials: $CREDENTIALS"

# 4. Check WhatsApp auth
WHATSAPP_AUTH="not_found"
if [ -d "$PROJECT_ROOT/store/auth" ] && [ "$(ls -A "$PROJECT_ROOT/store/auth" 2>/dev/null)" ]; then
  WHATSAPP_AUTH="authenticated"
fi
log "WhatsApp auth: $WHATSAPP_AUTH"

# 5. Check registered groups (in SQLite — the JSON file gets migrated away on startup)
REGISTERED_GROUPS=0
if [ -f "$PROJECT_ROOT/store/messages.db" ]; then
  REGISTERED_GROUPS=$(sqlite3 "$PROJECT_ROOT/store/messages.db" "SELECT COUNT(*) FROM registered_groups" 2>/dev/null || echo "0")
fi
log "Registered groups: $REGISTERED_GROUPS"

# 6. Check mount allowlist
MOUNT_ALLOWLIST="missing"
if [ -f "$HOME/.config/slyclaw/mount-allowlist.json" ]; then
  MOUNT_ALLOWLIST="configured"
fi
log "Mount allowlist: $MOUNT_ALLOWLIST"

# 7. Check Ollama Docker container
OLLAMA_CONTAINER="not_found"
OLLAMA_API="unreachable"
OLLAMA_MODELS=0

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  CONTAINER_STATUS=$(docker inspect --format='{{.State.Status}}' slyclaw-ollama 2>/dev/null || echo "not_found")
  if [ "$CONTAINER_STATUS" = "running" ]; then
    OLLAMA_CONTAINER="running"
    # Check API reachability
    if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
      OLLAMA_API="reachable"
      # Count installed Qwen models
      OLLAMA_MODELS=$(curl -sf http://localhost:11434/api/tags 2>/dev/null | \
        grep -o '"name":"[^"]*"' | grep -ci "qwen" || echo "0")
    fi
  elif [ "$CONTAINER_STATUS" != "not_found" ]; then
    OLLAMA_CONTAINER="$CONTAINER_STATUS"
  fi
fi
log "Ollama container: $OLLAMA_CONTAINER, API: $OLLAMA_API, Qwen models: $OLLAMA_MODELS"

# 8. Run unit tests (fast, no external deps)
UNIT_TESTS="not_run"
if command -v npm >/dev/null 2>&1 && [ -f "$PROJECT_ROOT/package.json" ]; then
  if npm test --prefix "$PROJECT_ROOT" >> "$LOG_FILE" 2>&1; then
    UNIT_TESTS="passed"
    log "Unit tests passed"
  else
    UNIT_TESTS="failed"
    log "Unit tests failed — see logs/setup.log"
  fi
fi

# 9. Run integration tests if Ollama is reachable
INTEGRATION_TESTS="skipped"
if [ "$OLLAMA_API" = "reachable" ] && command -v npm >/dev/null 2>&1; then
  if npm run test:integration --prefix "$PROJECT_ROOT" >> "$LOG_FILE" 2>&1; then
    INTEGRATION_TESTS="passed"
    log "Integration tests passed"
  else
    INTEGRATION_TESTS="failed"
    log "Integration tests failed — see logs/setup.log"
  fi
fi

# Determine overall status
STATUS="success"
if [ "$SERVICE" != "running" ] || [ "$CREDENTIALS" = "missing" ] || [ "$WHATSAPP_AUTH" = "not_found" ] || [ "$REGISTERED_GROUPS" -eq 0 ] 2>/dev/null; then
  STATUS="failed"
fi
if [ "$UNIT_TESTS" = "failed" ] || [ "$INTEGRATION_TESTS" = "failed" ]; then
  STATUS="failed"
fi

log "Verification complete: $STATUS"

cat <<EOF
=== SLYCLAW SETUP: VERIFY ===
SERVICE: $SERVICE
CONTAINER_RUNTIME: $CONTAINER_RUNTIME
CREDENTIALS: $CREDENTIALS
WHATSAPP_AUTH: $WHATSAPP_AUTH
REGISTERED_GROUPS: $REGISTERED_GROUPS
MOUNT_ALLOWLIST: $MOUNT_ALLOWLIST
OLLAMA_CONTAINER: $OLLAMA_CONTAINER
OLLAMA_API: $OLLAMA_API
OLLAMA_QWEN_MODELS: $OLLAMA_MODELS
UNIT_TESTS: $UNIT_TESTS
INTEGRATION_TESTS: $INTEGRATION_TESTS
STATUS: $STATUS
LOG: logs/setup.log
=== END ===
EOF

if [ "$STATUS" = "failed" ]; then
  exit 1
fi
