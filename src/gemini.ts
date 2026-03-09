import { GOOGLE_API_KEY, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { DelegateToClaudeError, OllamaToolContext, executeTool, OLLAMA_TOOLS } from './ollama-tools.js';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Gemini REST API types
// ---------------------------------------------------------------------------

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiCandidate {
  content: GeminiContent;
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  error?: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// Conversation history (same pattern as Ollama)
// ---------------------------------------------------------------------------

const MAX_HISTORY = 10;

function historyPath(groupFolder: string): string {
  return path.join(GROUPS_DIR, groupFolder, 'gemini_history.json');
}

function getHistory(groupFolder: string): GeminiContent[] {
  try {
    const p = historyPath(groupFolder);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')) as GeminiContent[];
  } catch { /* ignore */ }
  return [];
}

function appendHistory(groupFolder: string, userText: string, assistantText: string): void {
  const history = getHistory(groupFolder);
  history.push(
    { role: 'user', parts: [{ text: userText }] },
    { role: 'model', parts: [{ text: assistantText }] },
  );
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  try {
    fs.writeFileSync(historyPath(groupFolder), JSON.stringify(history, null, 2));
  } catch { /* ignore */ }
}

export function clearGeminiHistory(groupFolder: string): void {
  try {
    const p = historyPath(groupFolder);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Convert OLLAMA_TOOLS format → Gemini functionDeclarations format
// ---------------------------------------------------------------------------

function toGeminiFunctionDeclarations() {
  return OLLAMA_TOOLS.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));
}

// ---------------------------------------------------------------------------
// System prompt preamble (same rules as Ollama)
// ---------------------------------------------------------------------------

function buildSystemPrompt(model: string): string {
  return (
    `You are Nano, a helpful personal AI assistant (powered by Google Gemini / ${model}).\n` +
    `You have these tools available: web_search, fetch_url, get_current_time, get_weather, ` +
    `list_scheduled_tasks, create_scheduled_task, delete_scheduled_task, delegate_to_claude.\n\n` +
    `IMPORTANT RULES:\n` +
    `  - When asked about scheduled tasks or reminders, call list_scheduled_tasks.\n` +
    `  - When asked about the current date or time, call get_current_time.\n` +
    `  - When asked about weather, temperature, rain, wind, UV, or conditions outside: call get_weather immediately. NEVER ask for location — the station is at the user's home.\n` +
    `  - When asked to search or fetch web content, call web_search or fetch_url.\n` +
    `  - When asked to schedule or cancel tasks, use create_scheduled_task or delete_scheduled_task.\n` +
    `  - When asked about email, inbox, calendar, files, or anything requiring system access, call delegate_to_claude.\n` +
    `  - If you are unsure whether you can do something, call delegate_to_claude rather than guessing.\n` +
    `  - NEVER say you cannot do something — use delegate_to_claude instead.\n` +
    `  - Respond concisely. Use WhatsApp formatting: *bold*, _italic_, no markdown headings.\n`
  );
}

// ---------------------------------------------------------------------------
// Agentic loop
// ---------------------------------------------------------------------------

const MAX_TOOL_STEPS = 5;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function callGeminiApi(
  model: string,
  contents: GeminiContent[],
  systemInstruction: string,
  timeoutMs: number,
): Promise<GeminiResponse> {
  const url = `${GEMINI_BASE}/${model}:generateContent?key=${GOOGLE_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemInstruction }] },
      contents,
      tools: [{ function_declarations: toGeminiFunctionDeclarations() }],
      generation_config: { maxOutputTokens: 1024 },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await res.json()) as GeminiResponse;
}

export async function callGemini(
  model: string,
  groupFolder: string,
  chatJid: string,
  userMessage: string,
  timeoutMs = 60_000,
): Promise<string> {
  if (!GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY not configured');

  const history = getHistory(groupFolder);
  const ctx: OllamaToolContext = { groupFolder, chatJid };
  const systemPrompt = buildSystemPrompt(model);

  // Pre-call get_weather if weather intent detected (same as Ollama path)
  const WEATHER_INTENT_RE =
    /\b(weather|temperature|temp\b|raining|rain|wind|humidity|humid|uv index|uv\b|pressure|outside|outdoor|how (hot|cold|warm|cool)|is it (hot|cold|warm|cool|raining|sunny|cloudy))\b/i;

  const contents: GeminiContent[] = [...history];

  if (WEATHER_INTENT_RE.test(userMessage)) {
    try {
      const weatherResult = await executeTool('get_weather', {}, ctx);
      contents.push(
        { role: 'user', parts: [{ text: userMessage }] },
        { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { output: weatherResult } } }] },
      );
      logger.info('Gemini: pre-called get_weather based on weather intent');
    } catch {
      contents.push({ role: 'user', parts: [{ text: userMessage }] });
    }
  } else {
    contents.push({ role: 'user', parts: [{ text: userMessage }] });
  }

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const data = await callGeminiApi(model, contents, systemPrompt, timeoutMs);

    if (data.error) throw new Error(`Gemini API error ${data.error.code}: ${data.error.message}`);

    const candidate = data.candidates?.[0];
    if (!candidate) throw new Error('Gemini returned no candidates');

    const parts = candidate.content.parts;
    const textPart = parts.find((p) => p.text);
    const fnCall = parts.find((p) => p.functionCall);

    // No function call → final answer
    if (!fnCall) {
      const reply = textPart?.text?.trim() ?? '';
      appendHistory(groupFolder, userMessage, reply);
      return reply;
    }

    // Execute tool
    const { name, args } = fnCall.functionCall!;
    logger.info({ tool: name, args }, 'Executing Gemini tool');

    let toolResult: string;
    try {
      toolResult = await executeTool(name, args, ctx);
    } catch (err) {
      if (err instanceof DelegateToClaudeError) throw err;
      toolResult = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Append model turn + tool result
    contents.push(
      { role: 'model', parts: [{ functionCall: { name, args } }] },
      { role: 'user', parts: [{ functionResponse: { name, response: { output: toolResult } } }] },
    );
  }

  logger.warn({ model }, 'Gemini: exhausted max tool steps');
  return '';
}

// ---------------------------------------------------------------------------
// List available Gemini models
// ---------------------------------------------------------------------------

export async function getAvailableGeminiModels(): Promise<string[]> {
  if (!GOOGLE_API_KEY) return [];
  try {
    const res = await fetch(
      `${GEMINI_BASE}?key=${GOOGLE_API_KEY}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
    return (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace('models/', ''));
  } catch {
    return [];
  }
}
