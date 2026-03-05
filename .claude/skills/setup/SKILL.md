---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate WhatsApp, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run setup scripts automatically. Only pause when user action is required (WhatsApp authentication, configuration choices). Scripts live in `.claude/skills/setup/scripts/` and emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. scanning a QR code, pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## 1. Check Environment

Run `./.claude/skills/setup/scripts/01-check-environment.sh` and parse the status block.

- If HAS_AUTH=true → note that WhatsApp auth exists, offer to skip step 5
- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure
- Record PLATFORM, APPLE_CONTAINER, and DOCKER values for step 3

**If NODE_OK=false:**

Node.js is missing or too old. Ask the user if they'd like you to install it. Offer options based on platform:

- macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
- Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm

If brew/nvm aren't installed, install them first (`/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"` for brew, `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash` for nvm). After installing Node, re-run the environment check to confirm NODE_OK=true.

## 2. Install Dependencies

Run `./.claude/skills/setup/scripts/02-install-deps.sh` and parse the status block.

**If failed:** Read the tail of `logs/setup.log` to diagnose. Common fixes to try automatically:
1. Delete `node_modules` and `package-lock.json`, then re-run the script
2. If permission errors: suggest running with corrected permissions
3. If specific package fails to build (native modules like better-sqlite3): install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), then retry

Only ask the user for help if multiple retries fail with the same error.

## 2.5. Start Ollama Docker Container and Pull Models

Run `./.claude/skills/setup/scripts/10-setup-ollama.sh` and parse the status block.

The script runs Ollama in a Docker container with:
- **Memory**: `--memory=18g` (18GB allocated to container)
- **GPU**: auto-detected (NVIDIA → `--gpus all`; AMD ROCm → `/dev/kfd`+`/dev/dri`; AMD WSL2 → `/dev/dri`; CPU fallback)
- **Image**: `ollama/ollama:rocm` for AMD GPU, `ollama/ollama` for NVIDIA/CPU
- **Models**: `qwen2.5:7b` + `qwen2.5:3b` + `qwen2.5:1.5b` (3 Qwen variants, covering quality → speed)
- **Claude API**: `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` from `.env` are injected into the container environment
- **Restart policy**: `unless-stopped` — container auto-restarts with Docker daemon

**This hardware (AMD Ryzen 7 6800U, ~27GB RAM, WSL2):** The script will try `/dev/dri` passthrough with `ollama/ollama:rocm` for AMD iGPU acceleration. Falls back to CPU if the container fails to start.

**If DOCKER_AVAILABLE=false:**
- Docker not installed or daemon not running. Run the Docker setup skill or: `sudo systemctl start docker`
- On WSL2: Docker Desktop (Windows) must be running, or `sudo service docker start` in WSL.

**If OLLAMA_RUNNING=false:**
- Container failed to start and API is not reachable.
- Check container logs: `docker logs slyclaw-ollama`
- Try force-recreating: `./.claude/skills/setup/scripts/10-setup-ollama.sh --restart`
- If GPU caused the failure, the script auto-retries with CPU-only image.

**If MODELS_FAILED is non-empty:**
- A model pull failed (network issue or disk space). Retry with:
  ```bash
  ./.claude/skills/setup/scripts/10-setup-ollama.sh --models "qwen2.5:7b"
  ```
- Model files are stored in Docker volume `slyclaw-ollama-models`. Check disk: `df -h /`
- The 7B Q4 model is ~4.4GB; all three models together are ~8GB.

**To force-recreate the container** (e.g. after .env changes or to update GPU flags):
```bash
./.claude/skills/setup/scripts/10-setup-ollama.sh --restart
```

**To override models:**
```bash
./.claude/skills/setup/scripts/10-setup-ollama.sh --models "qwen2.5:7b qwen2.5:1.5b"
```

**To skip model pull (start container only):**
```bash
./.claude/skills/setup/scripts/10-setup-ollama.sh --skip-pull
```

**Verify with test script:**
```bash
./scripts/test-ollama.sh
```

## 2.6. Claude API in Container (Verification)

Run `./.claude/skills/setup/scripts/10-setup-ollama.sh --check-cloud` and parse the status block.

Check `ANTHROPIC_API_KEY_CONFIGURED` and `CLAUDE_OAUTH_CONFIGURED` to confirm credentials are present in `.env`.

- **If both are false:** The Ollama container runs without Claude credentials. This is fine for local Qwen inference only. Skip to step 2.7.
- **If credentials exist in `.env` but not in container** (`ANTHROPIC_API_KEY_IN_CONTAINER=false`): Recreate the container to inject them:
  ```bash
  ./.claude/skills/setup/scripts/10-setup-ollama.sh --restart
  ```

The Claude API key in the container allows any tool or script running inside the Ollama container to call the Anthropic API directly if needed.

Run `./scripts/test-ollama.sh` to confirm the key is present in the container.

## 2.7. Select Default LLM

Now that both Claude and Ollama are available, choose which should be the default for all new conversations.

Run `./.claude/skills/setup/scripts/10-setup-ollama.sh --check-cloud` to confirm Ollama is available. If `OLLAMA_RUNNING` is not reported (from step 2.5), skip to the end of this step and default to Claude.

AskUserQuestion: Which LLM should be the default for new conversations?

- **Claude (Anthropic)** — Full agent with tools, web search, file access, scheduled tasks. Requires API key / subscription. Recommended if you use advanced features.
- **Ollama / qwen2.5:7b** — Local model in Docker container (GPU-accelerated if AMD iGPU available). Good for offline or cost-free responses.
- **Ollama / qwen2.5:1.5b** — Local model, fastest response times, lighter quality. Best for quick low-latency replies.
- **Ollama / qwen2.5:3b** — Local model, ~2GB, balanced quality and speed.
- **Ollama / qwen2.5:1.5b** — Local model, ~1GB, fastest response times, lighter quality.

Write the choice to `.env`:

```bash
# Claude (default)
echo "DEFAULT_LLM=claude" >> .env

# OR Ollama
echo "DEFAULT_LLM=ollama:qwen2.5:7b" >> .env
```

**If the key already exists in `.env`:** use `sed -i` to replace the existing line rather than appending.

Verify the file contains the line:
```bash
grep "^DEFAULT_LLM=" .env
```

After setup, the user can switch per-chat at any time via WhatsApp:
- `@Nano what llm are you using` — current model
- `@Nano list models` — all available
- `@Nano use claude` / `@Nano use qwen2.5:7b` — switch (persists)

## 3. Container Runtime

Use the environment check results from step 1 to decide which runtime to use:

- PLATFORM=linux → Docker will be used. If the source code still references Apple Container (check for `container system status` in `src/index.ts`), run the `/convert-to-docker` skill first, then continue.
- PLATFORM=macos + APPLE_CONTAINER=installed → use apple-container
- PLATFORM=macos + DOCKER=running + APPLE_CONTAINER=not_found → use Docker. If the source code still references Apple Container, run the `/convert-to-docker` skill first.
- PLATFORM=macos + DOCKER=installed_not_running → start Docker for them: `open -a Docker`. Wait 15s, re-check with `docker info`. If still not running, tell the user Docker is starting up and poll a few more times. Then apply `/convert-to-docker` if source code needs it.
- Neither available → AskUserQuestion: Apple Container (recommended for macOS) vs Docker?
  - **If Docker chosen:** install it, then run the `/convert-to-docker` skill to update the source code.
  - Apple Container: tell user to download from https://github.com/apple/container/releases and install the .pkg. Wait for confirmation, then verify with `container --version`.
  - Docker on macOS: install via `brew install --cask docker`, then `open -a Docker` and wait for it to start. If brew not available, direct to Docker Desktop download.
  - Docker on Linux: install with `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`. Note: user may need to log out/in for group membership.

Run `./.claude/skills/setup/scripts/03-setup-container.sh --runtime <chosen>` and parse the status block.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- If it's a cache issue (stale layers): run `container builder stop && container builder rm && container builder start` (Apple Container) or `docker builder prune -f` (Docker), then retry.
- If Dockerfile syntax or missing files: diagnose from the log and fix.
- Retry the build script after fixing.

**If TEST_OK=false but BUILD_OK=true:** The image built but won't run. Check logs — common cause is runtime not fully started. Wait a moment and retry the test.

## 4. Claude Authentication (No Script)

If HAS_ENV=true from step 1, read `.env` and check if it already has `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. If so, confirm with user: "You already have Claude credentials configured. Want to keep them or reconfigure?" If keeping, skip to step 5.

AskUserQuestion: Claude subscription (Pro/Max) vs Anthropic API key?

**Subscription:** Tell the user:
1. Open another terminal and run: `claude setup-token`
2. Copy the token it outputs
3. Add it to the `.env` file in the project root: `CLAUDE_CODE_OAUTH_TOKEN=<token>`
4. Let me know when done

Do NOT ask the user to paste the token into the chat. Do NOT use AskUserQuestion to collect the token. Just tell them what to do, then wait for confirmation that they've added it to `.env`. Once confirmed, verify the `.env` file has the key.

**API key:** Tell the user to add `ANTHROPIC_API_KEY=<key>` to the `.env` file in the project root, then let you know when done. Once confirmed, verify the `.env` file has the key.

## 5. WhatsApp Authentication

If HAS_AUTH=true from step 1, confirm with user: "WhatsApp credentials already exist. Want to keep them or re-authenticate?" If keeping, skip to step 6.

AskUserQuestion: QR code in browser (recommended) vs pairing code vs QR code in terminal?

- **QR browser:** Run `./.claude/skills/setup/scripts/04-auth-whatsapp.sh --method qr-browser` (Bash timeout: 150000ms)
- **Pairing code:** Ask for phone number first (country code, no + or spaces, e.g. 14155551234). Run `./.claude/skills/setup/scripts/04-auth-whatsapp.sh --method pairing-code --phone NUMBER` (Bash timeout: 150000ms). Display the PAIRING_CODE from the status block with instructions.
- **QR terminal:** Run `./.claude/skills/setup/scripts/04-auth-whatsapp.sh --method qr-terminal`. Tell user to run `cd PROJECT_PATH && npm run auth` in another terminal. Wait for confirmation.

If AUTH_STATUS=already_authenticated → skip ahead.

**If failed:**
- qr_timeout → QR expired. Automatically re-run the auth script to generate a fresh QR. Tell user a new QR is ready.
- logged_out → Delete `store/auth/` and re-run auth automatically.
- 515 → Stream error during pairing. The auth script handles reconnection, but if it persists, re-run the auth script.
- timeout → Auth took too long. Ask user if they scanned/entered the code, offer to retry.

## 6. Configure Trigger and Channel Type

First, determine the phone number situation. Get the bot's WhatsApp number from `store/auth/creds.json`:
`node -e "const c=require('./store/auth/creds.json');console.log(c.me.id.split(':')[0].split('@')[0])"`

AskUserQuestion: Does the bot share your personal WhatsApp number, or does it have its own dedicated phone number?

AskUserQuestion: What trigger word? (default: Nano). In group chats, messages starting with @TriggerWord go to Claude. In the main channel, no prefix needed.

AskUserQuestion: Main channel type? (options depend on phone number setup)

**If bot shares user's number (same phone):**
1. Self-chat (chat with yourself) — Recommended. You message yourself and the bot responds.
2. Solo group (just you) — A group where you're the only member. Good if you want message history separate from self-chat.

**If bot has its own dedicated phone number:**
1. DM with the bot — Recommended. You message the bot's number directly.
2. Solo group with the bot — A group with just you and the bot, no one else.

Do NOT show options that don't apply to the user's setup. For example, don't offer "DM with the bot" if the bot shares the user's number (you can't DM yourself on WhatsApp).

## 7. Sync and Select Group (If Group Channel)

**For personal chat:** The JID is the bot's own phone number from step 6. Construct as `NUMBER@s.whatsapp.net`.

**For DM with bot's dedicated number:** Ask for the bot's phone number, construct JID as `NUMBER@s.whatsapp.net`.

**For group (solo or with bot):**
1. Run `./.claude/skills/setup/scripts/05-sync-groups.sh` (Bash timeout: 60000ms)
2. **If BUILD=failed:** Read `logs/setup.log`, fix the TypeScript error, re-run.
3. **If GROUPS_IN_DB=0:** Check `logs/setup.log` for the sync output. Common causes: WhatsApp auth expired (re-run step 5), connection timeout (re-run sync script with longer timeout).
4. Run `./.claude/skills/setup/scripts/05b-list-groups.sh` to get groups (pipe-separated JID|name lines). Do NOT display the output to the user.
5. Pick the most likely candidates (e.g. groups with the trigger word or "NanoClaw" in the name, small/solo groups) and present them as AskUserQuestion options — show names only, not JIDs. Include an "Other" option if their group isn't listed. If they pick Other, search by name in the DB or re-run with a higher limit.

## 8. Register Channel

Run `./.claude/skills/setup/scripts/06-register-channel.sh` with args:
- `--jid "JID"` — from step 7
- `--name "main"` — always "main" for the first channel
- `--trigger "@TriggerWord"` — from step 6
- `--folder "main"` — always "main" for the first channel
- `--no-trigger-required` — if personal chat, DM, or solo group
- `--assistant-name "Name"` — if trigger word differs from "Nano"

## 9. Mount Allowlist

AskUserQuestion: Want the agent to access directories outside the NanoClaw project? (Git repos, project folders, documents, etc.)

**If no:** Run `./.claude/skills/setup/scripts/07-configure-mounts.sh --empty`

**If yes:** Collect directory paths and permissions (read-write vs read-only). Ask about non-main group read-only restriction (recommended: yes). Build the JSON and pipe it to the script:

`echo '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}' | ./.claude/skills/setup/scripts/07-configure-mounts.sh`

Tell user how to grant a group access: add `containerConfig.additionalMounts` to their entry in `data/registered_groups.json`.

## 10. Start Service

If the service is already running (check `launchctl list | grep nanoclaw` on macOS), unload it first: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist` — then proceed with a clean install.

Run `./.claude/skills/setup/scripts/08-setup-service.sh` and parse the status block.

**If SERVICE_LOADED=false:**
- Read `logs/setup.log` for the error.
- Common fix: plist already loaded with different path. Unload the old one first, then re-run.
- On macOS: check `launchctl list | grep nanoclaw` to see if it's loaded with an error status. If the PID column is `-` and the status column is non-zero, the service is crashing. Read `logs/nanoclaw.error.log` for the crash reason and fix it (common: wrong Node path, missing .env, missing auth).
- On Linux: check `systemctl --user status nanoclaw` for the error and fix accordingly.
- Re-run the setup-service script after fixing.

## 11. Verify

Run `./.claude/skills/setup/scripts/09-verify.sh` and parse the status block.

The script runs automatically:
- **Unit tests** (`npm test`) — pure logic, no external dependencies. Always run.
- **Integration tests** (`npm run test:integration`) — live Ollama API required. Skipped if container not running.

**If STATUS=failed, fix each failing component:**
- SERVICE=stopped → run `npm run build` first, then restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux). Re-check.
- SERVICE=not_found → re-run step 10.
- CREDENTIALS=missing → re-run step 4.
- WHATSAPP_AUTH=not_found → re-run step 5.
- REGISTERED_GROUPS=0 → re-run steps 7-8.
- MOUNT_ALLOWLIST=missing → run `./.claude/skills/setup/scripts/07-configure-mounts.sh --empty` to create a default.
- OLLAMA_CONTAINER=not_found → re-run step 2.5.
- OLLAMA_API=unreachable → `docker start slyclaw-ollama`, wait 10s, re-run verify.
- OLLAMA_QWEN_MODELS=0 → run `./.claude/skills/setup/scripts/10-setup-ollama.sh --skip-pull` to start container, then re-pull models.
- UNIT_TESTS=failed → read `logs/setup.log` for the test failure details. Fix the broken test or the underlying code.
- INTEGRATION_TESTS=failed → run `npm run test:integration` manually to see verbose output. Common causes: model not installed (check `docker exec slyclaw-ollama ollama list`), container not running, inference timeout.

After fixing, re-run `09-verify.sh` to confirm everything passes.

Tell user to test: send a message in their registered chat (with or without trigger depending on channel type).

Show the log tail command: `tail -f logs/nanoclaw.log`

## Troubleshooting

**Ollama container not starting after reboot:** Docker's `--restart unless-stopped` policy auto-restarts the container when Docker daemon starts. On WSL2, Docker daemon starts with Windows. Check: `docker inspect slyclaw-ollama --format='{{.State.Status}}'`. If stopped: `docker start slyclaw-ollama`.

**Ollama container GPU not working:** Check container devices: `docker inspect slyclaw-ollama --format='{{.HostConfig.Devices}}'`. If `/dev/dri` is missing, the host WSL2 environment may not expose it. Fall back to CPU: `docker stop slyclaw-ollama && docker rm slyclaw-ollama` then re-run setup with `--models "qwen2.5:1.5b"` for faster CPU inference.

**Claude API key not in container:** If `.env` was updated after the container was created, the container won't pick up the new key. Force-recreate: `./.claude/skills/setup/scripts/10-setup-ollama.sh --restart`

**Ollama model pull fails:** Check disk space (`df -h /`) — models live in Docker volume `slyclaw-ollama-models`. The 7B Q4 model is ~4.4GB; all 3 models are ~8GB total. If a pull is interrupted, re-run: `docker exec slyclaw-ollama ollama pull qwen2.5:7b`

**Slow inference on CPU:** Expected when GPU isn't working. On AMD Ryzen 7 6800U without GPU acceleration, 7B models run at ~5–10 tok/s. Use `qwen2.5:1.5b` for faster responses. Check `./scripts/test-ollama.sh` for measured latency.

**View Ollama container logs:** `docker logs slyclaw-ollama --tail 50 -f`

**Service not starting:** Check `logs/nanoclaw.error.log`. Common causes: wrong Node path in plist (re-run step 10), missing `.env` (re-run step 4), missing WhatsApp auth (re-run step 5).

**Container agent fails ("Claude Code process exited with code 1"):** Ensure the container runtime is running — start it: `container system start` (Apple Container) or `open -a Docker` (macOS Docker). Check container logs in `groups/main/logs/container-*.log`.

**No response to messages:** Verify the trigger pattern matches. Main channel and personal/solo chats don't need a prefix. Check the registered JID in the database: `sqlite3 store/messages.db "SELECT * FROM registered_groups"`. Check `logs/nanoclaw.log`.

**Messages sent but not received (DMs):** WhatsApp may use LID (Linked Identity) JIDs. Check logs for LID translation. Verify the registered JID has no device suffix (should be `number@s.whatsapp.net`, not `number:0@s.whatsapp.net`).

**WhatsApp disconnected:** Run `npm run auth` to re-authenticate, then `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`.

**Unload service:** `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`
