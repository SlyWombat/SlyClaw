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
# test-ollama.sh — Verify the Ollama Docker container and Qwen models
#
# Usage:
#   ./scripts/test-ollama.sh              # full health check
#   ./scripts/test-ollama.sh --model qwen2.5:7b  # test specific model
#   ./scripts/test-ollama.sh --list-only  # list installed models only
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CONTAINER_NAME="slyclaw-ollama"
SPECIFIC_MODEL=""
LIST_ONLY="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)     SPECIFIC_MODEL="$2"; shift 2 ;;
    --list-only) LIST_ONLY="true"; shift ;;
    *) shift ;;
  esac
done

# Colours
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $*"; }
fail() { echo -e "  ${RED}✗${NC} $*"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $*"; }
info() { echo -e "  ${BLUE}→${NC} $*"; }

PASS_COUNT=0
FAIL_COUNT=0

record_pass() { PASS_COUNT=$(( PASS_COUNT + 1 )); pass "$*"; }
record_fail() { FAIL_COUNT=$(( FAIL_COUNT + 1 )); fail "$*"; }

echo ""
echo "SlyClaw — Ollama Health Check"
echo "============================="

# ---------------------------------------------------------------------------
# 1. Docker availability
# ---------------------------------------------------------------------------
echo ""
echo "1. Docker"

if ! command -v docker >/dev/null 2>&1; then
  record_fail "Docker not installed"
  echo ""
  echo "Result: FAIL — Docker is required. Run /setup to install."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  record_fail "Docker daemon not running"
  echo ""
  echo "Result: FAIL — Start Docker and retry."
  exit 1
fi

record_pass "Docker installed and daemon running"

# ---------------------------------------------------------------------------
# 2. Container status
# ---------------------------------------------------------------------------
echo ""
echo "2. Ollama container"

if ! docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  record_fail "Container '$CONTAINER_NAME' does not exist (run /setup to create it)"
  echo ""
  echo "Result: FAIL (${FAIL_COUNT} failure)"
  exit 1
fi

CONTAINER_STATUS=$(docker inspect --format='{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo "unknown")
RESTART_POLICY=$(docker inspect --format='{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER_NAME" 2>/dev/null || echo "unknown")
MEMORY_LIMIT=$(docker inspect --format='{{.HostConfig.Memory}}' "$CONTAINER_NAME" 2>/dev/null || echo "0")
MEMORY_GB=$(echo "$MEMORY_LIMIT" | awk '{printf "%.0f", $1/1073741824}' 2>/dev/null || echo "?")
OLLAMA_IMAGE=$(docker inspect --format='{{.Config.Image}}' "$CONTAINER_NAME" 2>/dev/null || echo "unknown")

if [ "$CONTAINER_STATUS" = "running" ]; then
  record_pass "Container '$CONTAINER_NAME' running  (image: $OLLAMA_IMAGE)"
else
  warn "Container '$CONTAINER_NAME' is $CONTAINER_STATUS — attempting to start..."
  docker start "$CONTAINER_NAME" >/dev/null 2>&1 || true
  sleep 3
  CONTAINER_STATUS=$(docker inspect --format='{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo "unknown")
  if [ "$CONTAINER_STATUS" = "running" ]; then
    record_pass "Container started successfully"
  else
    record_fail "Container could not be started (status: $CONTAINER_STATUS)"
    echo ""
    echo "Result: FAIL (${FAIL_COUNT} failure)"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 3. Resource allocation
# ---------------------------------------------------------------------------
echo ""
echo "3. Resource allocation"

if [ "$MEMORY_LIMIT" -ge 17179869184 ] 2>/dev/null; then   # 16GB in bytes (18*1073741824 = 19327352832)
  record_pass "Memory limit: ${MEMORY_GB}GB  (>= 18GB)"
elif [ "$MEMORY_LIMIT" -gt 0 ] 2>/dev/null; then
  warn "Memory limit: ${MEMORY_GB}GB  (expected >= 18GB — recreate with /setup --restart)"
  PASS_COUNT=$(( PASS_COUNT + 1 ))
else
  warn "Memory limit: unconstrained (no --memory flag set)"
  PASS_COUNT=$(( PASS_COUNT + 1 ))
fi

if [ "$RESTART_POLICY" = "unless-stopped" ] || [ "$RESTART_POLICY" = "always" ]; then
  record_pass "Restart policy: $RESTART_POLICY  (survives Docker daemon restarts)"
else
  warn "Restart policy: $RESTART_POLICY  (container will not auto-restart — run /setup to fix)"
  FAIL_COUNT=$(( FAIL_COUNT + 1 ))
fi

# ---------------------------------------------------------------------------
# 4. GPU detection
# ---------------------------------------------------------------------------
echo ""
echo "4. GPU acceleration"

DEVICES=$(docker inspect --format='{{range .HostConfig.Devices}}{{.PathOnHost}} {{end}}' "$CONTAINER_NAME" 2>/dev/null | xargs || true)
GPU_FLAGS=$(docker inspect --format='{{.HostConfig.DeviceRequests}}' "$CONTAINER_NAME" 2>/dev/null || true)

if echo "$GPU_FLAGS" | grep -q "Count:-1\|count:-1" 2>/dev/null; then
  record_pass "NVIDIA GPU: --gpus all  (full GPU passthrough)"
elif echo "$DEVICES" | grep -q "/dev/kfd"; then
  record_pass "AMD GPU: /dev/kfd + /dev/dri  (ROCm passthrough)"
elif echo "$DEVICES" | grep -q "/dev/dri"; then
  warn "GPU: /dev/dri only  (WSL2 AMD iGPU — limited ROCm acceleration)"
  PASS_COUNT=$(( PASS_COUNT + 1 ))
else
  warn "GPU: none configured  (CPU inference only)"
  PASS_COUNT=$(( PASS_COUNT + 1 ))
fi

info "Image: $OLLAMA_IMAGE"

# ---------------------------------------------------------------------------
# 5. Claude API credentials in container
# ---------------------------------------------------------------------------
echo ""
echo "5. Claude API credentials"

if docker exec "$CONTAINER_NAME" env 2>/dev/null | grep -q "^ANTHROPIC_API_KEY=."; then
  record_pass "ANTHROPIC_API_KEY is set in container"
elif docker exec "$CONTAINER_NAME" env 2>/dev/null | grep -q "^CLAUDE_CODE_OAUTH_TOKEN=."; then
  record_pass "CLAUDE_CODE_OAUTH_TOKEN is set in container"
else
  # Check if key exists in .env at all
  if grep -qE "^ANTHROPIC_API_KEY=.+" "$PROJECT_ROOT/.env" 2>/dev/null || grep -qE "^CLAUDE_CODE_OAUTH_TOKEN=.+" "$PROJECT_ROOT/.env" 2>/dev/null; then
    warn "Claude API key found in .env but NOT in container — recreate container with /setup --restart"
    FAIL_COUNT=$(( FAIL_COUNT + 1 ))
  else
    info "No Claude API credentials in .env (container runs without Claude key)"
  fi
fi

# ---------------------------------------------------------------------------
# 6. Ollama API reachability
# ---------------------------------------------------------------------------
echo ""
echo "6. Ollama API"

if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
  record_pass "API reachable at http://localhost:11434"
else
  record_fail "API not reachable at http://localhost:11434"
  echo ""
  echo "Container logs:"
  docker logs --tail 20 "$CONTAINER_NAME" 2>&1 || true
  echo ""
  echo "Result: FAIL (${FAIL_COUNT} failures)"
  exit 1
fi

# ---------------------------------------------------------------------------
# 7. Installed Qwen models
# ---------------------------------------------------------------------------
echo ""
echo "7. Installed Qwen models"

if [ "$LIST_ONLY" = "true" ]; then
  INSTALLED_MODELS=$(curl -sf http://localhost:11434/api/tags 2>/dev/null | \
    grep -o '"name":"[^"]*"' | sed 's/"name":"//;s/"//' | grep -i "qwen" || true)
else
  INSTALLED_MODELS=$(curl -sf http://localhost:11434/api/tags 2>/dev/null | \
    grep -o '"name":"[^"]*"' | sed 's/"name":"//;s/"//' | grep -i "qwen" || true)
fi

QWEN_COUNT=0
if [ -z "$INSTALLED_MODELS" ]; then
  record_fail "No Qwen models installed  (run /setup to pull them)"
else
  while IFS= read -r model; do
    [ -z "$model" ] && continue
    SIZE_BYTES=$(curl -sf http://localhost:11434/api/tags 2>/dev/null | \
      grep -A3 "\"name\":\"$model\"" | grep '"size"' | grep -o '[0-9]*' | head -1 || echo "0")
    if [ -n "$SIZE_BYTES" ] && [ "$SIZE_BYTES" -gt 0 ] 2>/dev/null; then
      SIZE_GB=$(echo "$SIZE_BYTES" | awk '{printf "%.1f GB", $1/1073741824}')
      record_pass "$model  ($SIZE_GB)"
    else
      record_pass "$model"
    fi
    QWEN_COUNT=$(( QWEN_COUNT + 1 ))
  done <<< "$INSTALLED_MODELS"
fi

if [ "$QWEN_COUNT" -ge 3 ]; then
  record_pass "$QWEN_COUNT Qwen models installed  (>= 3 required)"
elif [ "$QWEN_COUNT" -gt 0 ]; then
  warn "Only $QWEN_COUNT Qwen model(s) installed  (3+ recommended — run /setup to pull more)"
  PASS_COUNT=$(( PASS_COUNT + 1 ))
fi

if [ "$LIST_ONLY" = "true" ]; then
  echo ""
  echo "Result: ${QWEN_COUNT} Qwen model(s) installed"
  exit 0
fi

# ---------------------------------------------------------------------------
# 8. Inference test
# ---------------------------------------------------------------------------
echo ""
echo "8. Inference test"

TEST_PROMPT="Reply with exactly: OK"
TIMEOUT_SECS=120

run_inference_test() {
  local model="$1"
  local start_time end_time elapsed
  start_time=$(date +%s%3N 2>/dev/null || date +%s)

  local response
  response=$(curl -sf \
    --max-time "$TIMEOUT_SECS" \
    -X POST http://localhost:11434/api/generate \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"prompt\":\"$TEST_PROMPT\",\"stream\":false}" 2>/dev/null | \
    grep -o '"response":"[^"]*"' | sed 's/"response":"//;s/"$//' || true)

  end_time=$(date +%s%3N 2>/dev/null || date +%s)
  elapsed=$(( end_time - start_time ))

  if [ -z "$response" ]; then
    record_fail "$model → no response  (timeout or error)"
    return
  fi

  if echo "$response" | grep -qi "ok"; then
    record_pass "$model → \"$response\"  (${elapsed}ms)"
  else
    warn "$model → \"$response\"  (${elapsed}ms) [model responded but unexpected output]"
    PASS_COUNT=$(( PASS_COUNT + 1 ))
  fi
}

if [ -n "$SPECIFIC_MODEL" ]; then
  if echo "$INSTALLED_MODELS" | grep -q "$SPECIFIC_MODEL"; then
    info "Testing $SPECIFIC_MODEL..."
    run_inference_test "$SPECIFIC_MODEL"
  else
    record_fail "Model '$SPECIFIC_MODEL' is not installed"
  fi
else
  if [ -z "$INSTALLED_MODELS" ]; then
    warn "No Qwen models to test"
  else
    while IFS= read -r model; do
      [ -z "$model" ] && continue
      info "Testing $model..."
      run_inference_test "$model"
    done <<< "$INSTALLED_MODELS"
  fi
fi

# ---------------------------------------------------------------------------
# 9. Hardware info
# ---------------------------------------------------------------------------
echo ""
echo "9. Hardware profile"

TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || echo "0")
TOTAL_RAM_GB=$(( TOTAL_RAM_KB / 1024 / 1024 ))
AVAIL_RAM_KB=$(grep MemAvailable /proc/meminfo 2>/dev/null | awk '{print $2}' || echo "0")
AVAIL_RAM_GB=$(( AVAIL_RAM_KB / 1024 / 1024 ))

info "System RAM: ${TOTAL_RAM_GB}GB total, ${AVAIL_RAM_GB}GB available"
info "Container memory limit: ${MEMORY_GB}GB"

if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
  GPU=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | head -1 || echo "unknown")
  info "GPU: $GPU  (NVIDIA CUDA)"
elif [ -e "/dev/kfd" ]; then
  info "GPU: AMD ROCm  (/dev/kfd present)"
elif [ -e "/dev/dri" ]; then
  info "GPU: AMD/Intel via /dev/dri  (WSL2 passthrough)"
else
  info "GPU: none detected  (CPU only)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "============================="
if [ "$FAIL_COUNT" -eq 0 ]; then
  echo -e "${GREEN}Result: PASS${NC}  (${PASS_COUNT} checks passed)"
  echo ""
  echo "Ollama is ready. Use models via:"
  echo "  curl http://localhost:11434/api/generate -d '{\"model\":\"qwen2.5:7b\",\"prompt\":\"Hello\",\"stream\":false}'"
  echo "  docker exec $CONTAINER_NAME ollama run qwen2.5:7b \"your prompt\""
  exit 0
else
  echo -e "${RED}Result: FAIL${NC}  (${PASS_COUNT} passed, ${FAIL_COUNT} failed)"
  echo ""
  echo "Run /setup to reinstall and reconfigure."
  exit 1
fi
