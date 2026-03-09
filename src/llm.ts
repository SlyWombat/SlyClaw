/*
 *   ____  _            ____ _
 *  / ___|| |_   _     / ___| | __ ___      __
 *  \___ \| | | | |   | |   | |/ _` \ \ /\ / /
 *   ___) | | |_| |   | |___| | (_| |\ V  V /
 *  |____/|_|\__, |    \____|_|\__,_| \_/\_/
 *           |___/
 *  Cunning. Sturdy. Open.
 *
 *  Based on the NanoClaw project. Modified by Sly Wombat.
 */
import fs from 'fs';
import path from 'path';

import { DEFAULT_LLM, GROUPS_DIR, OLLAMA_LOCAL_URL } from './config.js';
import { getRouterState, setRouterState } from './db.js';
import { logger } from './logger.js';
import { OllamaApiMessage, OllamaToolContext, callOllamaWithTools } from './ollama-tools.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LlmChoice = { type: 'claude' } | { type: 'ollama'; model: string };

export type LlmCommand =
  | { action: 'status' }
  | { action: 'list' }
  | { action: 'switch'; choice: LlmChoice };

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ---------------------------------------------------------------------------
// Per-group LLM selection (persisted via router_state table)
// ---------------------------------------------------------------------------

export function getGroupLlm(groupFolder: string): LlmChoice {
  const stored = getRouterState(`llm:${groupFolder}`);
  return stored ? parseLlmString(stored) : defaultLlm();
}

export function setGroupLlm(groupFolder: string, choice: LlmChoice): void {
  setRouterState(`llm:${groupFolder}`, serializeLlm(choice));
  logger.info({ groupFolder, llm: serializeLlm(choice) }, 'LLM selection updated');
}

export function formatLlmName(choice: LlmChoice): string {
  return choice.type === 'claude' ? 'Claude (Anthropic)' : `Ollama / ${choice.model}`;
}

function parseLlmString(s: string): LlmChoice {
  if (s === 'claude') return { type: 'claude' };
  if (s.startsWith('ollama:')) return { type: 'ollama', model: s.slice(7) };
  return { type: 'claude' };
}

function serializeLlm(choice: LlmChoice): string {
  return choice.type === 'claude' ? 'claude' : `ollama:${choice.model}`;
}

function defaultLlm(): LlmChoice {
  if (!DEFAULT_LLM || DEFAULT_LLM === 'claude') return { type: 'claude' };
  if (DEFAULT_LLM.startsWith('ollama:')) {
    return { type: 'ollama', model: DEFAULT_LLM.slice(7) };
  }
  return { type: 'claude' };
}

// ---------------------------------------------------------------------------
// LLM command detection
// Checks the text AFTER the trigger word has been stripped.
// ---------------------------------------------------------------------------

export function detectLlmCommand(text: string): LlmCommand | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[?!.]+$/, '')
    .trim();

  // Status: "what llm", "which model", "llm status", "what model are you using"
  if (
    /^(what|which|current|show me the?)?\s*(llm|model|language model|ai)(\s+(are you using|status|is set|is active|is selected|are you running|info))?$/.test(t) ||
    /^(llm|model)\s+(status|info|current)$/.test(t) ||
    /^what\s+(llm|model|ai)\s+(are you|is|am i)\s+(using|on|set to|running)$/.test(t)
  ) {
    return { action: 'status' };
  }

  // List: "list llms", "what models are available", "available models"
  if (
    /^(list|show|available)\s+(llms?|models?|ais?)$/.test(t) ||
    /^(llms?|models?|ais?)\s+(list|available|options?)$/.test(t) ||
    /^what\s+(llms?|models?)\s+(are\s+)?(available|do you (have|support))$/.test(t) ||
    /^show\s+(available\s+)?(llms?|models?)$/.test(t)
  ) {
    return { action: 'list' };
  }

  // Switch: "use claude", "switch to ollama", "use qwen2.5:7b", "set model to X"
  const switchMatch = t.match(
    /^(?:use|switch(?:\s+to)?|set\s+(?:model|llm|ai)\s+to?|change\s+(?:to|model\s+to)?)\s+(.+)$/,
  );
  if (switchMatch) {
    const choice = parseLlmTarget(switchMatch[1].trim());
    if (choice) return { action: 'switch', choice };
  }

  return null;
}

function parseLlmTarget(target: string): LlmChoice | null {
  const t = target.toLowerCase().trim();

  if (t === 'claude' || t === 'anthropic' || t === 'claude ai') {
    return { type: 'claude' };
  }

  // "ollama" or "qwen" alone → default mid-size model
  if (t === 'ollama' || t === 'qwen') return { type: 'ollama', model: 'qwen2.5:3b' };
  // "qwen mini" / "qwen small" / "qwen fast" → lighter 1.5b model
  if (t === 'qwen mini' || t === 'qwen small' || t === 'qwen fast' || t === 'qwen light') return { type: 'ollama', model: 'qwen2.5:1.5b' };
  // "qwen medium" / "qwen 3b" explicit aliases
  if (t === 'qwen medium' || t === 'qwen 3b') return { type: 'ollama', model: 'qwen2.5:3b' };

  if (t.startsWith('ollama:') || t.startsWith('ollama/')) {
    return { type: 'ollama', model: target.slice(7) };
  }

  // Raw model names (qwen2.5:7b, llama3.2, etc.)
  // Require a '.' or ':' so plain words like "llm", "local", "nano" don't match.
  if (/^[a-z0-9][a-z0-9._-]*(?::[a-z0-9._-]+)?$/.test(t) && (t.includes('.') || t.includes(':'))) {
    return { type: 'ollama', model: t };
  }

  // Fuzzy: extract first token and retry (handles "use qwen for the best results...")
  const firstToken = t.split(/\s+/)[0];
  if (firstToken && firstToken !== t) return parseLlmTarget(firstToken);

  return null;
}

// ---------------------------------------------------------------------------
// Available LLMs listing
// ---------------------------------------------------------------------------

export async function getAvailableLlms(): Promise<Array<{ label: string; id: string }>> {
  const result: Array<{ label: string; id: string }> = [
    {
      label: 'Claude (Anthropic) — full agent with tools, web search, file access',
      id: 'claude',
    },
  ];

  try {
    const res = await fetch(`${OLLAMA_LOCAL_URL}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = (await res.json()) as { models?: Array<{ name: string; size: number }> };
      for (const m of data.models ?? []) {
        const sizeMb = Math.round(m.size / 1024 / 1024);
        const sizeStr = sizeMb > 1000 ? `${(sizeMb / 1024).toFixed(1)} GB` : `${sizeMb} MB`;
        result.push({
          label: `Ollama / ${m.name} (${sizeStr}) — local, chat-only`,
          id: `ollama:${m.name}`,
        });
      }
    }
  } catch {
    result.push({ label: 'Ollama (not reachable)', id: '__ollama_offline__' });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Ollama conversation history (persisted to groups/{folder}/ollama_history.json)
// ---------------------------------------------------------------------------

const MAX_HISTORY = 10; // messages (user + assistant pairs = 5 turns)

function historyPath(groupFolder: string): string {
  return path.join(GROUPS_DIR, groupFolder, 'ollama_history.json');
}

export function getOllamaHistory(groupFolder: string): OllamaMessage[] {
  try {
    const p = historyPath(groupFolder);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8')) as OllamaMessage[];
    }
  } catch (e) {
    logger.warn({ err: e, groupFolder }, 'Failed to read Ollama history');
  }
  return [];
}

export function appendOllamaHistory(
  groupFolder: string,
  userContent: string,
  assistantContent: string,
): void {
  const history = getOllamaHistory(groupFolder);
  history.push(
    { role: 'user', content: userContent },
    { role: 'assistant', content: assistantContent },
  );
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
  try {
    fs.writeFileSync(historyPath(groupFolder), JSON.stringify(history, null, 2));
  } catch (e) {
    logger.warn({ err: e, groupFolder }, 'Failed to save Ollama history');
  }
}

export function clearOllamaHistory(groupFolder: string): void {
  try {
    const p = historyPath(groupFolder);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Group system prompt for Ollama (reads CLAUDE.md files)
// ---------------------------------------------------------------------------

export function readGroupSystemPrompt(groupFolder: string): string {
  const parts: string[] = [];

  try {
    const globalMd = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
    if (fs.existsSync(globalMd)) parts.push(fs.readFileSync(globalMd, 'utf-8'));
  } catch {
    /* ignore */
  }

  try {
    const groupMd = path.join(GROUPS_DIR, groupFolder, 'CLAUDE.md');
    if (fs.existsSync(groupMd)) parts.push(fs.readFileSync(groupMd, 'utf-8'));
  } catch {
    /* ignore */
  }

  if (parts.length === 0) {
    return 'You are a helpful AI assistant. Keep answers concise and direct.';
  }

  return parts.join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Ollama HTTP API call
// ---------------------------------------------------------------------------

export async function callOllama(
  model: string,
  groupFolder: string,
  chatJid: string,
  userMessage: string,
  systemPrompt: string,
  timeoutMs = 120_000,
): Promise<string> {
  const history = getOllamaHistory(groupFolder);

  // Prepend a clear identity preamble so the model knows it is Ollama/Qwen,
  // not Claude. The CLAUDE.md system prompt is written for the container agent
  // and would otherwise confuse local models into thinking they are Claude.
  const ollamaPreamble =
    `You are Nano, a helpful AI assistant running locally via Ollama (model: ${model}).\n` +
    `You have these tools available:\n` +
    `  - web_search: search the web for current info\n` +
    `  - fetch_url: read a web page\n` +
    `  - get_current_time: get the current date and time\n` +
    `  - get_weather: get real-time conditions from the home weather station (temperature, humidity, wind, rain, UV, pressure)\n` +
    `  - list_scheduled_tasks: list all recurring tasks/reminders set up for this group\n` +
    `  - create_scheduled_task: create a new scheduled task (requires prompt + cron expression)\n` +
    `  - delete_scheduled_task: cancel a scheduled task by ID\n` +
    `  - delegate_to_claude: hand off to the Claude agent, which has full capabilities\n` +
    `\n` +
    `The Claude agent (via delegate_to_claude) can do everything you cannot:\n` +
    `  email (read inbox, send, search), calendar, files, bash commands, database queries,\n` +
    `  browser automation, group management, and any other skill or integration.\n` +
    `\n` +
    `IMPORTANT RULES:\n` +
    `  - When asked about scheduled tasks or reminders, call list_scheduled_tasks.\n` +
    `  - When asked about the current date or time, call get_current_time.\n` +
    `  - When asked to search or fetch web content, call web_search or fetch_url.\n` +
    `  - When asked to schedule or cancel tasks, use create_scheduled_task or delete_scheduled_task.\n` +
    `  - When asked about email, inbox, calendar, files, or anything requiring system access, call delegate_to_claude.\n` +
    `  - If you are unsure whether you can do something, call delegate_to_claude rather than guessing.\n` +
    `  - NEVER say you cannot do something — use delegate_to_claude instead.\n` +
    `  - Respond concisely. Use WhatsApp formatting: *bold*, _italic_, no markdown headings.\n` +
    `---\n`;
  // Inject current weather into context if available — eliminates need for a tool call
  let weatherContext = '';
  try {
    const { getCachedWeather } = await import('./weather-station.js');
    const wx = getCachedWeather();
    if (wx) weatherContext = `\nCurrent home weather station readings:\n${wx}\n`;
  } catch { /* weather module not available */ }

  const fullSystemPrompt = ollamaPreamble + (weatherContext ? weatherContext + '---\n' : '') + systemPrompt;

  const ctx: OllamaToolContext = { groupFolder, chatJid };

  // Cast history to OllamaApiMessage[] — safe because history only contains
  // role:'system'|'user'|'assistant' entries, which are valid OllamaApiMessage subtypes.
  const messages: OllamaApiMessage[] = [
    { role: 'system', content: fullSystemPrompt },
    ...(history as OllamaApiMessage[]),
    { role: 'user', content: userMessage },
  ];

  let reply: string;
  try {
    reply = await callOllamaWithTools(model, messages, timeoutMs, ctx);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Some models don't support tool calling — fall back to plain chat
    if (/tool|function.?call/i.test(errMsg)) {
      logger.warn({ model, errMsg }, 'Model does not support tools; falling back to plain chat');
      reply = await callOllamaPlain(model, messages, timeoutMs);
    } else {
      throw err;
    }
  }

  // Only persist the original user message + final assistant reply, not intermediate tool turns
  appendOllamaHistory(groupFolder, userMessage, reply);
  return reply;
}

async function callOllamaPlain(
  model: string,
  messages: OllamaApiMessage[],
  timeoutMs: number,
): Promise<string> {
  const res = await fetch(`${OLLAMA_LOCAL_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama API ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { message?: { content?: string }; error?: string };
  if (data.error) throw new Error(data.error);
  return data.message?.content?.trim() ?? '';
}

// ---------------------------------------------------------------------------
// Helpers exported for use in index.ts
// ---------------------------------------------------------------------------

export { serializeLlm };
