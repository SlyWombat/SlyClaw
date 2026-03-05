# SlyClaw Requirements

Original requirements and design decisions from management.

---

## Why This Exists

This is a lightweight, secure alternative to OpenClaw (formerly ClawBot). That project became a monstrosity - 4-5 different processes running different gateways, endless configuration files, endless integrations. It's a security nightmare where agents don't run in isolated processes; there's all kinds of leaky workarounds trying to prevent them from accessing parts of the system they shouldn't. It's impossible for anyone to realistically understand the whole codebase. When you run it you're kind of just yoloing it.

SlyClaw gives you the core functionality without that mess.

---

## Philosophy

### Small Enough to Understand

The entire codebase should be something you can read and understand. One Node.js process. A handful of source files. No microservices, no message queues, no abstraction layers.

### Security Through True Isolation

Instead of application-level permission systems trying to prevent agents from accessing things, agents run in actual Linux containers. The isolation is at the OS level. Agents can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your computer.

### Built for One User

This isn't a framework or a platform. It's working software for my specific needs. I use WhatsApp and Email, so it supports WhatsApp and Email. I add the integrations I actually want, not every possible integration.

### Customization = Code Changes

No configuration sprawl. If you want different behavior, modify the code. The codebase is small enough that this is safe and practical. Very minimal things like the trigger word are in config. Everything else - just change the code to do what you want.

### AI-Native Development

I don't need an installation wizard - Claude Code guides the setup. I don't need a monitoring dashboard - I ask Claude Code what's happening. I don't need elaborate logging UIs - I ask Claude to read the logs. I don't need debugging tools - I describe the problem and Claude fixes it.

The codebase assumes you have an AI collaborator. It doesn't need to be excessively self-documenting or self-debugging because Claude is always there.

### Skills Over Features

When people contribute, they shouldn't add "Telegram support alongside WhatsApp." They should contribute a skill like `/add-telegram` that transforms the codebase. Users fork the repo, run skills to customize, and end up with clean code that does exactly what they need - not a bloated system trying to support everyone's use case simultaneously.

---

## RFS (Request for Skills)

Skills we'd love contributors to build:

### Communication Channels
Skills to add or switch to different messaging platforms:
- `/add-telegram` - Add Telegram as an input channel
- `/add-slack` - Add Slack as an input channel
- `/add-discord` - Add Discord as an input channel
- `/add-sms` - Add SMS via Twilio or similar
- `/convert-to-telegram` - Replace WhatsApp with Telegram entirely

### Platform Support
- `/setup-linux` - Make the full setup work on Linux (depends on Docker conversion)
- `/setup-windows` - Windows support via WSL2 + Docker

---

## Vision

A personal Claude assistant accessible via WhatsApp, with minimal custom code.

**Core components:**
- **Claude Agent SDK** as the core agent
- **Apple Container** for isolated agent execution (Linux VMs)
- **WhatsApp** as the primary I/O channel
- **Persistent memory** per conversation and globally
- **Scheduled tasks** that run Claude and can message back
- **Web access** for search and browsing
- **Browser automation** via agent-browser
- **Ollama + Qwen** for local LLM inference (offline/low-latency tasks)

**Implementation approach:**
- Use existing tools (WhatsApp connector, Claude Agent SDK, MCP servers)
- Minimal glue code
- File-based systems where possible (CLAUDE.md for memory, folders for groups)

---

## Architecture Decisions

### Message Routing
- A router listens to WhatsApp and routes messages based on configuration
- Only messages from registered groups are processed
- Trigger: `@Nano` prefix (case insensitive), configurable via `ASSISTANT_NAME` env var
- Unregistered groups are ignored completely

### Memory System
- **Per-group memory**: Each group has a folder with its own `CLAUDE.md`
- **Global memory**: Root `CLAUDE.md` is read by all groups, but only writable from "main" (self-chat)
- **Files**: Groups can create/read files in their folder and reference them
- Agent runs in the group's folder, automatically inherits both CLAUDE.md files

### Session Management
- Each group maintains a conversation session (via Claude Agent SDK)
- Sessions auto-compact when context gets too long, preserving critical information

### Container Isolation
- All agents run inside a Container (lightweight Linux VMs)
- Each agent invocation spawns a container with mounted directories
- Containers provide filesystem isolation - agents can only see mounted paths
- Bash access is safe because commands run inside the container, not on the host
- Browser automation via agent-browser with Chromium in the container

### Scheduled Tasks
- Users can ask Claude to schedule recurring or one-time tasks from any group
- Tasks run as full agents in the context of the group that created them
- Tasks have access to all tools including Bash (safe in container)
- Tasks can optionally send messages to their group via `send_message` tool, or complete silently
- Task runs are logged to the database with duration and result
- Schedule types: cron expressions, intervals (ms), or one-time (ISO timestamp)
- From main: can schedule tasks for any group, view/manage all tasks
- From other groups: can only manage that group's tasks

### Group Management
- New groups are added explicitly via the main channel
- Groups are registered in SQLite (via the main channel or IPC `register_group` command)
- Each group gets a dedicated folder under `groups/`
- Groups can have additional directories mounted via `containerConfig`

### Main Channel Privileges
- Main channel is the admin/control group (typically self-chat)
- Can write to global memory (`groups/CLAUDE.md`)
- Can schedule tasks for any group
- Can view and manage tasks from all groups
- Can configure additional directory mounts for any group

---

## Integration Points

### WhatsApp
- Using our own library for WhatsApp Web connection
- Messages stored in SQLite, polled by router
- QR code authentication during setup

### Scheduler
- Built-in scheduler runs on the host, spawns containers for task execution
- Custom `nanoclaw` MCP server (inside container) provides scheduling tools
- Tools: `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `send_message`
- Tasks stored in SQLite with run history
- Scheduler loop checks for due tasks every minute
- Tasks execute Claude Agent SDK in containerized group context

### Web Access
- Built-in WebSearch and WebFetch tools
- Standard Claude Agent SDK capabilities

### Browser Automation
- agent-browser CLI with Chromium in container
- Snapshot-based interaction with element references (@e1, @e2, etc.)
- Screenshots, PDFs, video recording
- Authentication state persistence

### Local LLM — Ollama + Qwen2.5

SlyClaw ships with first-class support for local inference via [Ollama](https://ollama.com). The `/setup` skill automatically installs Ollama in a Docker container and pulls Qwen2.5 models sized for the host hardware.

**Why Qwen2.5?**
- Best-in-class open-weight model at every size tier (0.5B–72B)
- Strong multilingual support
- Available through Ollama with efficient quantized formats (Q4_K_M default)

**Default model:** `qwen2.5:1.5b` — installed by `/setup` on all hardware. Fast on CPU (~30–40 tok/s), low memory (~1GB). Sufficient for Q&A, web search, and delegation to Claude.

Larger models can be pulled manually if needed:
```bash
docker exec slyclaw-ollama ollama pull qwen2.5:7b   # ~4.7GB, ~5-10 tok/s on CPU
docker exec slyclaw-ollama ollama pull qwen2.5:3b   # ~1.9GB, ~15-20 tok/s on CPU
```

**Reference hardware (this installation):**
- AMD Ryzen 7 6800U, ~27GB RAM, AMD Radeon 680M iGPU
- WSL2 environment — GPU compute not available, CPU inference only

**Ollama API:** `http://localhost:11434` — available on the host and inside Docker containers.

**Model storage:** `/root/.ollama/models/` inside the `slyclaw-ollama` Docker container.

### LLM Routing — Qwen as Smart Front-End

Qwen acts as a fast, always-on front-end. It handles simple requests locally and automatically delegates complex tasks to the Claude container agent. This routing is **per-group**, persisted in SQLite, and survives restarts.

**Qwen tools:**

| Tool | Description |
|------|-------------|
| `web_search` | DuckDuckGo HTML scraping — no API key required |
| `fetch_url` | HTTP fetch with Puppeteer fallback for JS-rendered pages |
| `delegate_to_claude` | Hand off to Claude when the task needs scheduling, files, bash, or MCP tools |

**Routing decision (made by Qwen automatically):**

| Request type | Path |
|---|---|
| Q&A, web lookups, URL summaries | Qwen handles directly |
| Schedule a reminder / recurring task | Qwen calls `delegate_to_claude` → Claude |
| Read/write files, run commands | Qwen calls `delegate_to_claude` → Claude |
| Register groups, manage database | Qwen calls `delegate_to_claude` → Claude |
| Ollama API error or timeout | Auto-fallback to Claude |

**Switching LLMs (WhatsApp commands, per group):**

| Command | Effect |
|---------|--------|
| `@Nano what llm` | Show current LLM for this group |
| `@Nano list models` | Show all available models |
| `@Nano use claude` | Switch to Claude container agent |
| `@Nano use qwen` / `use ollama` | Switch to `qwen2.5:1.5b` (mini, default) |
| `@Nano use qwen medium` | Switch to `qwen2.5:3b` |
| `@Nano use qwen2.5:7b` | Switch to a specific model tag |

**Default:** `DEFAULT_LLM=ollama:qwen2.5:1.5b` (set in `.env`). New groups start on Qwen mini automatically.

---

## Setup & Customization

### Philosophy
- Minimal configuration files
- Setup and customization done via Claude Code
- Users clone the repo and run Claude Code to configure
- Each user gets a custom setup matching their exact needs

### Skills
- `/setup` - Install dependencies, authenticate WhatsApp, configure scheduler, start services
- `/customize` - General-purpose skill for adding capabilities (new channels like Telegram, new integrations, behavior changes)

### Deployment
- Runs on WSL2 via systemd user service (`slyclaw.service`); restarts automatically on reboot
- Ollama runs as a Docker container (`slyclaw-ollama`)
- Single Node.js process handles everything

---

## Personal Configuration (Reference)

These are the creator's settings, stored here for reference:

- **Trigger**: `@Nano` (case insensitive)
- **Response prefix**: `Nano:`
- **Persona**: Default Claude (no custom personality)
- **Main channel**: Self-chat (messaging yourself in WhatsApp)

---

## Project Name

**SlyClaw** - A reference to Clawdbot (now OpenClaw).
