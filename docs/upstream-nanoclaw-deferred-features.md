# Upstream nanoclaw — deferred features

Survey done 2026-05-23 of `qwibitai/nanoclaw` (v2.0.69 + `channels` branch).
Items 1, 2, 3, 4, 7 were implemented. The following five were deferred —
captured here so we don't lose the thread.

---

## 5. Platform-confirmed `isMention` field on inbound

**Source:** `qwibitai/nanoclaw#channels` — `src/channels/adapter.ts:70-87`.

Upstream's `InboundMessage` carries an `isMention?: boolean` field set by
the adapter from real platform mention semantics — not text-regex matching.

Today our trigger logic is a regex against `TRIGGER_PATTERN` (`/@Nano/i`)
applied to message text. This is fragile in three ways:

- Telegram inserts the bot's *platform username* (`@nanoclaw_v2_bot`)
  via autocomplete, not the agent's display name (`@Nano`). The regex
  misses these.
- Discord/Slack use platform-native `<@userid>` mention syntax that
  doesn't contain the agent's name at all.
- Users typing `Nano` in regular conversation (e.g. "the nano-second
  metric") could trip false matches with a looser regex.

**Fix:** every channel adapter sets `isMention=true` from its platform's
own mention API (Baileys: `mentionedJid` contains bot JID; Discord:
`message.mentions.has(bot)`; Slack: `channel.is_mpim` + bot in member
list, etc.). The router checks `isMention || TRIGGER_PATTERN.test(...)`.

**Effort:** ~20 lines spread across `types.ts` (add field), each channel
adapter (set field), and `index.ts:processGroupMessages` (consume field).
**Win:** clean per-channel trigger logic. Required before adding any
channel where regex-on-text doesn't reliably catch bot mentions.

---

## 6. `whatsapp-cloud.ts` — official Meta WhatsApp Business Cloud API fallback

**Source:** `qwibitai/nanoclaw#channels` — `src/channels/whatsapp-cloud.ts` (1KB).

Wraps `@chat-adapter/whatsapp` (a separate npm package that talks to
Meta's official WhatsApp Business Cloud API) via upstream's `chat-sdk-bridge`.

We chose Baileys for the migration because Cloud API doesn't support
**groups** for personal use (Meta's groups API is invite-only enterprise),
and slyclaw's value is squarely in group chats. Cloud API also requires a
**separate phone number** that cannot be in use on the regular WhatsApp app.

**When to revisit:** if Baileys breaks for an extended period, or WhatsApp
ghost-bans the personal number from anti-abuse heuristics. Cloud API is
literally Meta-sanctioned — can't be kicked off it.

**Effort:** ~50 lines for the adapter itself, plus pulling in
`chat-sdk-bridge.ts` (24KB) and the `chat` npm dep (~4.x). Architectural
prerequisite: adopt upstream's Chat SDK bridge pattern (see #9/#10).
**Win:** insurance — but only useful once we have the bridge layer.

---

## 8. Provider abstraction — LLMs as pluggable providers

**Source:** upstream's `providers` branch (referenced in README; not in
main code we've inspected).

Currently `src/llm.ts` has hardcoded paths for Claude (container) / Ollama
(local LLM) / Gemini (cloud REST), with routing via `getGroupLlm()` and
`detectLlmCommand()`. Each LLM has its own per-group history file format,
its own tool-call loop, its own delegation rules.

Upstream's pattern: define a `Provider` interface (similar to `Channel`),
register concrete providers (`claude-container`, `ollama-local`,
`gemini-cloud`, `opencode`, `grok-cloud`, etc.) via a `provider-registry`,
let users `/add-<provider>` skills to install new ones into their fork.

**Effort:** ~200 lines refactor of `llm.ts` + each existing provider
into the abstract shape. Plus rewriting per-provider history handling
to a common interface.
**Win:** future LLM additions in ~30 minutes instead of ~4 hours;
isolates per-provider quirks (e.g., Gemini's `thought_signature`
preservation) inside each provider.

---

## 9. Two-DB per-session SQLite IPC (inbound.db + outbound.db)

**Source:** upstream README architecture section + their `chat-sdk-bridge.ts`.

Replaces our file-based `data/ipc/<group>/{messages,tasks,input}/*.json`
polling-and-unlink pattern. Each container session gets two SQLite files:

- `inbound.db` — host writes user messages here; container polls and
  consumes.
- `outbound.db` — container writes agent responses here; host polls and
  delivers.

Per upstream README: *"Two SQLite files per session, each with exactly
one writer — no cross-mount contention, no IPC, no stdin piping."*

Today's "queued send_file stuck in `data/ipc/main/messages/` for 4 hours
because the orphan container wrote after the orchestrator restarted"
incident would have been impossible with proper transactional storage.

**Effort:** **Big.** Multi-day refactor — rewrites `ipc.ts`,
`container/agent-runner/src/ipc-mcp-stdio.ts`, `container-runner.ts`
mount setup, the `processGroupMessages` queue, and the IPC drain logic.
**Win:** durability + simplicity in the long run; survives orphan-container
races; cleaner failure modes. Consider only if file-IPC pain recurs.

---

## 10. Telegram channel as a second messaging surface

**Source:** `qwibitai/nanoclaw#channels` — `src/channels/telegram.ts`.

Telegram is the easiest "second channel" to add — clean API, free bot API
with no rate-limit drama, no QR/protocol-drift fragility. Together with
the channel registry pattern (#3, which we DID implement), adding
Telegram becomes "drop one adapter file and a `.env` entry."

**Why it matters for slyclaw:** redundancy. Today's WhatsApp outage chain
(wweb-js protocol drift → Baileys cooldown → re-pair churn) would have
been a non-event with Telegram still reachable. Slyclaw would have stayed
operational from the operator's side via Telegram even while the WA
channel was being recovered.

**Effort:** ~300 lines (port upstream Telegram adapter) + small `index.ts`
hook. Needs a Telegram bot token (free from `@BotFather`) and a chosen
chat to register as `MAIN_GROUP_FOLDER`'s Telegram counterpart.
**Win:** operational redundancy — slyclaw reachable even when one
messaging surface is broken.

---

## Recommendation if/when picking next batch

In rough order of value-to-effort:

1. **#5 (isMention)** — small, blocks the upgrade path for #10 anyway.
2. **#10 (Telegram channel)** — biggest resilience win.
3. **#8 (provider abstraction)** — pays off once you want to try a
   new LLM (high probability given how fast that space moves).
4. **#9 (two-DB IPC)** — only worth doing if file-IPC pain returns.
5. **#6 (Cloud API)** — only worth doing if Baileys breaks for real.
