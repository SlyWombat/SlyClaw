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

# 10-setup-ollama.sh — Run Ollama in a Docker container with GPU support
#
# GPU priority: NVIDIA (--gpus all) > AMD ROCm (/dev/kfd+/dev/dri) > AMD DRI only > CPU
# Memory:       --memory=18g  (at least 18GB allocated to container)
# Models:       qwen2.5:1.5b (mini, default — fast on CPU; override with --models)
# Claude API:   ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN passed from .env into container
#
# Usage:
#   ./10-setup-ollama.sh                          # full setup (pull image + start + pull models)
#   ./10-setup-ollama.sh --models "m1 m2"         # override models to pull
#   ./10-setup-ollama.sh --skip-pull              # start container only, skip model pull
#   ./10-setup-ollama.sh --restart                # stop+remove existing container, recreate
#   ./10-setup-ollama.sh --configure-service      # idempotent: ensure container is running
#   ./10-setup-ollama.sh --check-cloud            # report cloud credential state in .env

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [setup-ollama] $*" >> "$LOG_FILE"; }
info() { echo "  $*"; log "$*"; }

# ---------------------------------------------------------------------------
# Parse flags
# ---------------------------------------------------------------------------
SKIP_PULL="false"
OVERRIDE_MODELS=""
CONFIGURE_SERVICE_ONLY="false"
CHECK_CLOUD="false"
FORCE_RESTART="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-pull)         SKIP_PULL="true"; shift ;;
    --models)            OVERRIDE_MODELS="$2"; shift 2 ;;
    --configure-service) CONFIGURE_SERVICE_ONLY="true"; shift ;;
    --check-cloud)       CHECK_CLOUD="true"; shift ;;
    --restart)           FORCE_RESTART="true"; shift ;;
    *) shift ;;
  esac
done

log "Starting Ollama Docker setup (skip_pull=$SKIP_PULL force_restart=$FORCE_RESTART configure_service=$CONFIGURE_SERVICE_ONLY check_cloud=$CHECK_CLOUD)"

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
CONTAINER_NAME="slyclaw-ollama"
VOLUME_NAME="slyclaw-ollama-models"
CONTAINER_MEMORY="18g"
OLLAMA_PORT="127.0.0.1:11434:11434"

# Default model — qwen2.5:1.5b (mini) is fast on CPU and sufficient for most tasks.
# Larger models can be pulled later with: docker exec slyclaw-ollama ollama pull qwen2.5:7b
DEFAULT_MODELS="qwen2.5:1.5b"

# ---------------------------------------------------------------------------
# 1. Check Docker
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "Docker not found"
  cat <<EOF
=== SLYCLAW SETUP: SETUP_OLLAMA ===
DOCKER_AVAILABLE: false
STATUS: failed
ERROR: docker_not_found
LOG: logs/setup.log
=== END ===
EOF
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  log "Docker daemon not running"
  cat <<EOF
=== SLYCLAW SETUP: SETUP_OLLAMA ===
DOCKER_AVAILABLE: false
STATUS: failed
ERROR: docker_daemon_not_running
LOG: logs/setup.log
=== END ===
EOF
  exit 1
fi

log "Docker is available and running"

# ---------------------------------------------------------------------------
# 2. Detect GPU
# ---------------------------------------------------------------------------
GPU_TYPE="cpu"
GPU_FLAGS=()
OLLAMA_IMAGE="ollama/ollama"

# NVIDIA GPU
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
  GPU_TYPE="nvidia"
  GPU_FLAGS=(--gpus all)
  OLLAMA_IMAGE="ollama/ollama"
  log "NVIDIA GPU detected — using --gpus all"
# AMD GPU with full ROCm support (/dev/kfd + /dev/dri)
elif [ -e "/dev/kfd" ] && [ -e "/dev/dri" ]; then
  GPU_TYPE="amd_rocm"
  GPU_FLAGS=(--device /dev/kfd --device /dev/dri)
  OLLAMA_IMAGE="ollama/ollama:rocm"
  log "AMD GPU (ROCm) detected — /dev/kfd + /dev/dri available"
# AMD/Intel GPU via DRI only (WSL2 passthrough — limited ROCm)
elif [ -e "/dev/dri" ]; then
  GPU_TYPE="amd_dri"
  GPU_FLAGS=(--device /dev/dri)
  OLLAMA_IMAGE="ollama/ollama:rocm"
  log "GPU via /dev/dri only (WSL2 AMD iGPU) — trying ROCm image"
else
  GPU_TYPE="cpu"
  GPU_FLAGS=()
  OLLAMA_IMAGE="ollama/ollama"
  log "No GPU detected — CPU inference only"
fi

log "GPU type: $GPU_TYPE, image: $OLLAMA_IMAGE"

# ---------------------------------------------------------------------------
# 3. Read Claude API credentials from .env (pass into container)
# ---------------------------------------------------------------------------
ANTHROPIC_API_KEY_VAL=""
CLAUDE_OAUTH_VAL=""
OLLAMA_HOST_CONFIGURED="false"
OLLAMA_API_KEY_CONFIGURED="false"

if [ -f "$PROJECT_ROOT/.env" ]; then
  ANTHROPIC_API_KEY_VAL=$(grep -E "^ANTHROPIC_API_KEY=" "$PROJECT_ROOT/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  CLAUDE_OAUTH_VAL=$(grep -E "^CLAUDE_CODE_OAUTH_TOKEN=" "$PROJECT_ROOT/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  if grep -qE "^OLLAMA_HOST=https?://" "$PROJECT_ROOT/.env" 2>/dev/null; then
    OLLAMA_HOST_CONFIGURED="true"
  fi
  if grep -qE "^OLLAMA_API_KEY=.+" "$PROJECT_ROOT/.env" 2>/dev/null; then
    OLLAMA_API_KEY_CONFIGURED="true"
  fi
fi

log "Claude API key present: $([ -n "$ANTHROPIC_API_KEY_VAL" ] && echo yes || echo no)"
log "Claude OAuth token present: $([ -n "$CLAUDE_OAUTH_VAL" ] && echo yes || echo no)"

# ---------------------------------------------------------------------------
# --check-cloud: just report credential state
# ---------------------------------------------------------------------------
if [ "$CHECK_CLOUD" = "true" ]; then
  cat <<EOF
=== SLYCLAW SETUP: SETUP_OLLAMA_CLOUD_CHECK ===
OLLAMA_HOST_CONFIGURED: $OLLAMA_HOST_CONFIGURED
OLLAMA_API_KEY_CONFIGURED: $OLLAMA_API_KEY_CONFIGURED
ANTHROPIC_API_KEY_CONFIGURED: $([ -n "$ANTHROPIC_API_KEY_VAL" ] && echo true || echo false)
CLAUDE_OAUTH_CONFIGURED: $([ -n "$CLAUDE_OAUTH_VAL" ] && echo true || echo false)
STATUS: success
LOG: logs/setup.log
=== END ===
EOF
  exit 0
fi

# ---------------------------------------------------------------------------
# 4. Clean up previous native Ollama install (if any)
# ---------------------------------------------------------------------------

# Stop and disable old systemd user service (native binary)
if systemctl --user is-active ollama >/dev/null 2>&1; then
  info "Stopping legacy native Ollama systemd service..."
  systemctl --user stop ollama >/dev/null 2>&1 || true
  systemctl --user disable ollama >/dev/null 2>&1 || true
  log "Stopped legacy ollama systemd service"
fi

# Remove legacy .bashrc autostart entry
if grep -q "slyclaw-ollama-autostart" "$HOME/.bashrc" 2>/dev/null; then
  info "Removing legacy Ollama .bashrc autostart..."
  sed -i '/# slyclaw-ollama-autostart/,+4d' "$HOME/.bashrc" 2>/dev/null || true
  log "Removed legacy ollama .bashrc autostart"
fi

# Remove legacy service wrapper if present
if [ -f "$HOME/.local/bin/ollama-serve.sh" ]; then
  rm -f "$HOME/.local/bin/ollama-serve.sh"
  log "Removed legacy ollama-serve.sh"
fi

# Remove legacy systemd unit file if present
LEGACY_UNIT="$HOME/.config/systemd/user/ollama.service"
if [ -f "$LEGACY_UNIT" ]; then
  rm -f "$LEGACY_UNIT"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  log "Removed legacy ollama.service unit"
fi

# ---------------------------------------------------------------------------
# 5. Pull Docker image
# ---------------------------------------------------------------------------
info "Pulling Ollama Docker image ($OLLAMA_IMAGE)..."
if ! docker pull "$OLLAMA_IMAGE" >> "$LOG_FILE" 2>&1; then
  log "Failed to pull $OLLAMA_IMAGE, trying CPU-only fallback"
  OLLAMA_IMAGE="ollama/ollama"
  GPU_FLAGS=()
  GPU_TYPE="cpu"
  if ! docker pull "$OLLAMA_IMAGE" >> "$LOG_FILE" 2>&1; then
    log "Failed to pull ollama/ollama"
    cat <<EOF
=== SLYCLAW SETUP: SETUP_OLLAMA ===
DOCKER_AVAILABLE: true
STATUS: failed
ERROR: image_pull_failed
LOG: logs/setup.log
=== END ===
EOF
    exit 1
  fi
fi

log "Pulled image: $OLLAMA_IMAGE"

# ---------------------------------------------------------------------------
# 6. Build docker run arguments
# ---------------------------------------------------------------------------
ENV_FLAGS=()
if [ -n "$ANTHROPIC_API_KEY_VAL" ]; then
  ENV_FLAGS+=(-e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY_VAL")
fi
if [ -n "$CLAUDE_OAUTH_VAL" ]; then
  ENV_FLAGS+=(-e "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_OAUTH_VAL")
fi

# ---------------------------------------------------------------------------
# 7. Start/restart container
# ---------------------------------------------------------------------------
CONTAINER_CREATED="false"

start_container() {
  log "Starting Docker container $CONTAINER_NAME"
  docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    --memory="$CONTAINER_MEMORY" \
    "${GPU_FLAGS[@]+"${GPU_FLAGS[@]}"}" \
    "${ENV_FLAGS[@]+"${ENV_FLAGS[@]}"}" \
    -v "$VOLUME_NAME:/root/.ollama" \
    -p "$OLLAMA_PORT" \
    "$OLLAMA_IMAGE" >> "$LOG_FILE" 2>&1
  CONTAINER_CREATED="true"
  log "Container started: $CONTAINER_NAME"
}

remove_container() {
  docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker rm "$CONTAINER_NAME" >/dev/null 2>&1 || true
  log "Removed container: $CONTAINER_NAME"
}

CONTAINER_RUNNING="false"

if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  EXISTING_STATUS=$(docker inspect --format='{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo "unknown")

  if [ "$FORCE_RESTART" = "true" ]; then
    info "Recreating Ollama container (--restart)..."
    remove_container
    start_container
  elif [ "$EXISTING_STATUS" = "running" ]; then
    CONTAINER_RUNNING="true"
    log "Container $CONTAINER_NAME already running"
    info "Ollama container already running"
  else
    info "Starting existing Ollama container..."
    docker start "$CONTAINER_NAME" >> "$LOG_FILE" 2>&1 || true
  fi
else
  info "Creating Ollama Docker container..."
  start_container
fi

# ---------------------------------------------------------------------------
# 8. Wait for API to become reachable
# ---------------------------------------------------------------------------
OLLAMA_API_READY="false"

for i in $(seq 1 20); do
  if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
    OLLAMA_API_READY="true"
    log "Ollama API ready after ${i}s"
    break
  fi
  sleep 1
done

if [ "$OLLAMA_API_READY" = "false" ]; then
  DOCKER_LOGS=$(docker logs "$CONTAINER_NAME" 2>&1 | tail -20 || echo "(no logs)")
  log "Ollama API not ready after 20s. Container logs: $DOCKER_LOGS"

  # If GPU start failed, retry with CPU-only image
  if [ "$GPU_TYPE" != "cpu" ]; then
    info "GPU container failed to start API — retrying with CPU-only image..."
    remove_container
    GPU_FLAGS=()
    GPU_TYPE="cpu"
    OLLAMA_IMAGE="ollama/ollama"
    start_container

    for i in $(seq 1 20); do
      if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
        OLLAMA_API_READY="true"
        log "Ollama API ready (CPU fallback) after ${i}s"
        break
      fi
      sleep 1
    done
  fi
fi

if [ "$OLLAMA_API_READY" = "false" ]; then
  cat <<EOF
=== SLYCLAW SETUP: SETUP_OLLAMA ===
DOCKER_AVAILABLE: true
GPU_TYPE: $GPU_TYPE
OLLAMA_IMAGE: $OLLAMA_IMAGE
CONTAINER_NAME: $CONTAINER_NAME
OLLAMA_RUNNING: false
STATUS: failed
ERROR: api_not_reachable
LOG: logs/setup.log
=== END ===
EOF
  exit 1
fi

info "Ollama API reachable at http://localhost:11434"

# ---------------------------------------------------------------------------
# --configure-service: idempotent start (stop here)
# ---------------------------------------------------------------------------
if [ "$CONFIGURE_SERVICE_ONLY" = "true" ]; then
  cat <<EOF
=== SLYCLAW SETUP: SETUP_OLLAMA ===
DOCKER_AVAILABLE: true
GPU_TYPE: $GPU_TYPE
OLLAMA_IMAGE: $OLLAMA_IMAGE
CONTAINER_NAME: $CONTAINER_NAME
OLLAMA_RUNNING: true
STATUS: success
LOG: logs/setup.log
=== END ===
EOF
  exit 0
fi

# ---------------------------------------------------------------------------
# 9. Pull Qwen models
# ---------------------------------------------------------------------------
if [ -n "$OVERRIDE_MODELS" ]; then
  MODELS="$OVERRIDE_MODELS"
  log "Using override models: $MODELS"
else
  MODELS="$DEFAULT_MODELS"
  log "Using default models: $MODELS"
fi

MODELS_PULLED=""
MODELS_FAILED=""

if [ "$SKIP_PULL" = "true" ]; then
  log "Skipping model pull (--skip-pull)"
  MODELS_PULLED="skipped"
else
  info "Pulling Qwen models (this may take a while on first run)..."

  for model in $MODELS; do
    info "  Pulling $model..."
    if docker exec "$CONTAINER_NAME" ollama pull "$model" >> "$LOG_FILE" 2>&1; then
      log "Pulled: $model"
      MODELS_PULLED="$MODELS_PULLED $model"
    else
      log "Failed to pull: $model"
      MODELS_FAILED="$MODELS_FAILED $model"
    fi
  done

  MODELS_PULLED="${MODELS_PULLED# }"
  MODELS_FAILED="${MODELS_FAILED# }"
fi

# ---------------------------------------------------------------------------
# 10. Output status
# ---------------------------------------------------------------------------
OVERALL_STATUS="success"
if [ -n "$MODELS_FAILED" ]; then
  OVERALL_STATUS="partial"
fi

log "Ollama Docker setup complete: status=$OVERALL_STATUS gpu=$GPU_TYPE image=$OLLAMA_IMAGE pulled=[$MODELS_PULLED] failed=[$MODELS_FAILED]"

CONTAINER_STATUS=$(docker inspect --format='{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo "unknown")
RESTART_POLICY=$(docker inspect --format='{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER_NAME" 2>/dev/null || echo "unknown")
MEMORY_LIMIT=$(docker inspect --format='{{.HostConfig.Memory}}' "$CONTAINER_NAME" 2>/dev/null || echo "0")
MEMORY_GB=$(echo "$MEMORY_LIMIT" | awk '{printf "%.0f", $1/1073741824}' 2>/dev/null || echo "?")

cat <<EOF
=== SLYCLAW SETUP: SETUP_OLLAMA ===
DOCKER_AVAILABLE: true
GPU_TYPE: $GPU_TYPE
OLLAMA_IMAGE: $OLLAMA_IMAGE
CONTAINER_NAME: $CONTAINER_NAME
CONTAINER_STATUS: $CONTAINER_STATUS
RESTART_POLICY: $RESTART_POLICY
MEMORY_GB: ${MEMORY_GB}GB
VOLUME: $VOLUME_NAME
OLLAMA_RUNNING: true
SELECTED_MODELS: $MODELS
MODELS_PULLED: $MODELS_PULLED
MODELS_FAILED: $MODELS_FAILED
ANTHROPIC_API_KEY_IN_CONTAINER: $([ -n "$ANTHROPIC_API_KEY_VAL" ] && echo true || echo false)
CLAUDE_OAUTH_IN_CONTAINER: $([ -n "$CLAUDE_OAUTH_VAL" ] && echo true || echo false)
STATUS: $OVERALL_STATUS
LOG: logs/setup.log
=== END ===
EOF

if [ -n "$MODELS_FAILED" ]; then
  exit 1
fi
