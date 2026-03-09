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
import { CronExpressionParser } from 'cron-parser';

import { OLLAMA_LOCAL_URL, TIMEZONE } from './config.js';
import { createTask, deleteTask, getTasksForGroup } from './db.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Thrown when the local model explicitly requests delegation to the Claude
 * container agent (e.g. the model called the `delegate_to_claude` tool).
 */
export class DelegateToClaudeError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'DelegateToClaudeError';
  }
}

export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

// Discriminated union for the full Ollama wire format.
// OllamaMessage (in llm.ts) only covers role:'system'|'user'|'assistant' — the
// persisted history format. This type covers the full API, including tool turns.
export type OllamaApiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: OllamaToolCall[] }
  | { role: 'tool'; content: string };

interface OllamaChatResponse {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  error?: string;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const OLLAMA_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'web_search',
      description:
        'Search the web for current information. Use this for questions about recent events, news, facts you are unsure about, prices, people, or anything requiring up-to-date information.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query. Be specific and concise.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'fetch_url',
      description:
        'Fetch and read the text content of a specific web page. Use this to read articles, documentation, or pages found via web_search.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full URL to fetch (must start with http:// or https://).',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_current_time',
      description:
        'Get the current date and time. Use this whenever the user asks about the current time, date, day of week, or when you need to know the current date to answer accurately. Never guess the date — always call this tool.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_scheduled_tasks',
      description:
        'List all scheduled tasks and reminders set up for this group. Use this whenever the user asks about scheduled services, reminders, recurring tasks, or what automation is set up. Never guess or say there are no tasks — always call this tool to check.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_scheduled_task',
      description:
        'Create a new scheduled task or reminder for this group. Use this when the user asks to set up a recurring task, reminder, or scheduled automation. Requires a cron expression for the schedule.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The full instruction the agent will execute on each run (e.g. "Search the web for today\'s weather in Toronto and send a summary").',
          },
          cron_expression: {
            type: 'string',
            description: 'Standard cron expression for the schedule (e.g. "0 8 * * *" for 8am daily, "0 9 * * 1-5" for 9am weekdays). Use 5-field cron format.',
          },
        },
        required: ['prompt', 'cron_expression'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_scheduled_task',
      description:
        'Delete (cancel) a scheduled task by its ID. Use list_scheduled_tasks first to get the task ID, then call this to remove it.',
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'The task ID to delete (from list_scheduled_tasks output).',
          },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_weather',
      description:
        'Get current weather conditions from the home weather station. NO location parameter needed — this station is always at the user\'s home. Call this immediately whenever the user asks about weather, temperature, rain, wind, UV, pressure, or conditions outside. NEVER ask the user for their location — just call this tool.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delegate_to_claude',
      description:
        'Hand off this task to the Claude agent. Use this when the request requires: scheduling or cancelling tasks/reminders, reading or writing files, running commands, managing groups, accessing the database, or any capability beyond web search and URL fetching. Also use this if you are unsure or cannot answer accurately with your available tools.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Brief reason why Claude is needed (e.g. "user wants to schedule a reminder").',
          },
        },
        required: ['reason'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Web search via DuckDuckGo HTML endpoint (no API key required)
// ---------------------------------------------------------------------------

async function webSearch(query: string): Promise<string> {
  try {
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      body: `q=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return `Web search failed: HTTP ${res.status}`;

    const html = await res.text();

    // Parse result__a links (title + DDG redirect URL) and result__snippet text.
    // DDG redirect URLs look like //duckduckgo.com/l/?uddg=<encoded-url>&...
    const linkRe = /class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    const links: Array<{ url: string; title: string }> = [];
    const snippets: string[] = [];
    let m: RegExpExecArray | null;

    while ((m = linkRe.exec(html)) !== null && links.length < 6) {
      const rawHref = m[1];
      const title = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, '')).trim();

      let url = rawHref;
      const uddg = rawHref.match(/[?&]uddg=([^&]+)/);
      if (uddg) {
        url = decodeURIComponent(uddg[1]);
      } else if (rawHref.startsWith('//')) {
        url = 'https:' + rawHref;
      }

      if (title && url.startsWith('http')) links.push({ url, title });
    }

    while ((m = snippetRe.exec(html)) !== null && snippets.length < 6) {
      const text = decodeHtmlEntities(m[1].replace(/<[^>]+>/g, '')).trim();
      if (text) snippets.push(text);
    }

    if (links.length === 0) return `No results found for: ${query}`;

    return links
      .slice(0, 5)
      .map((l, i) => `${i + 1}. **${l.title}**\n   ${l.url}\n   ${snippets[i] ?? ''}`)
      .join('\n\n');
  } catch (err) {
    logger.warn({ err, query }, 'webSearch failed');
    return `Web search error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// URL fetching with HTML stripping
// ---------------------------------------------------------------------------

const FETCH_MAX_CHARS = 2500;

async function fetchUrl(url: string): Promise<string> {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return 'Error: URL must start with http:// or https://';
  }

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,text/plain',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) return `Fetch failed: HTTP ${res.status} for ${url}`;

    const contentType = res.headers.get('content-type') ?? '';
    const raw = await res.text();

    if (!contentType.includes('html')) {
      return raw.slice(0, FETCH_MAX_CHARS);
    }

    const stripped = stripHtml(raw);

    // If content is suspiciously short the page is likely JS-gated — try Puppeteer
    if (stripped.length < 200) {
      return await fetchUrlWithPuppeteer(url);
    }

    return stripped.slice(0, FETCH_MAX_CHARS);
  } catch (err) {
    logger.warn({ err, url }, 'fetchUrl failed');
    return `Fetch error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchUrlWithPuppeteer(url: string): Promise<string> {
  // Lazy import — only pays startup cost when the plain fetch returns near-empty content
  let browser: { newPage(): Promise<unknown>; close(): Promise<void> } | null = null;
  try {
    const puppeteer = (await import('puppeteer')) as {
      default: { launch(opts: object): Promise<typeof browser> };
    };
    browser = await puppeteer.default.launch({ headless: true, args: ['--no-sandbox'] });
    const page = (await (browser as { newPage(): Promise<unknown> }).newPage()) as {
      goto(url: string, opts: object): Promise<void>;
      evaluate(fn: () => string): Promise<string>;
    };
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = await page.evaluate(() => (globalThis as any).document?.body?.innerText ?? '');
    return text.slice(0, FETCH_MAX_CHARS);
  } catch (err) {
    logger.warn({ err, url }, 'fetchUrlWithPuppeteer failed');
    return `Could not fetch page: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    if (browser) await (browser as { close(): Promise<void> }).close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// HTML entity decoder (minimal — covers the common cases in DDG results)
// ---------------------------------------------------------------------------

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// ---------------------------------------------------------------------------
// Lightweight tools (no external calls)
// ---------------------------------------------------------------------------

function getCurrentTime(): string {
  const now = new Date();
  return now.toLocaleString('en-CA', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

function createScheduledTask(
  prompt: string,
  cronExpression: string,
  groupFolder: string,
  chatJid: string,
): string {
  try {
    const interval = CronExpressionParser.parse(cronExpression, { tz: TIMEZONE });
    const nextRun = interval.next().toISOString();
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    createTask({
      id,
      group_folder: groupFolder,
      chat_jid: chatJid,
      prompt,
      schedule_type: 'cron',
      schedule_value: cronExpression,
      context_mode: 'isolated',
      next_run: nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    const nextRunFormatted = nextRun ? new Date(nextRun).toLocaleString() : 'unknown';
    return `Task created successfully.\nID: ${id}\nSchedule: ${cronExpression}\nFirst run: ${nextRunFormatted}`;
  } catch (err) {
    return `Failed to create task: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function deleteScheduledTask(taskId: string, groupFolder: string): string {
  try {
    const tasks = getTasksForGroup(groupFolder);
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return `Task not found: ${taskId}. Use list_scheduled_tasks to see valid IDs.`;
    deleteTask(taskId);
    return `Task deleted: ${taskId}`;
  } catch (err) {
    return `Failed to delete task: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function listScheduledTasks(groupFolder: string): string {
  try {
    const tasks = getTasksForGroup(groupFolder).filter((t) => t.status === 'active');
    if (tasks.length === 0) return 'No active scheduled tasks for this group.';

    return tasks
      .map((t, i) => {
        const schedule =
          t.schedule_type === 'cron'
            ? `cron: ${t.schedule_value}`
            : `${t.schedule_type}: ${t.schedule_value}`;
        const nextRun = t.next_run ? new Date(t.next_run as string).toLocaleString() : 'unknown';
        const lastRun = t.last_run ? new Date(t.last_run as string).toLocaleString() : 'never';
        // Truncate long prompts for readability
        const summary =
          t.prompt.length > 120 ? t.prompt.slice(0, 117) + '...' : t.prompt;
        return `${i + 1}. *${summary}*\n   Schedule: ${schedule}\n   Next run: ${nextRun}\n   Last run: ${lastRun}`;
      })
      .join('\n\n');
  } catch (err) {
    logger.warn({ err, groupFolder }, 'listScheduledTasks failed');
    return 'Could not retrieve scheduled tasks.';
  }
}

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

export interface OllamaToolContext {
  groupFolder: string;
  chatJid: string;
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: OllamaToolContext,
): Promise<string> {
  logger.info({ tool: name, args }, 'Executing Ollama tool');
  try {
    if (name === 'web_search') {
      const query = typeof args.query === 'string' ? args.query : String(args.query ?? '');
      if (!query) return 'Error: query parameter is required';
      return await webSearch(query);
    }
    if (name === 'fetch_url') {
      const url = typeof args.url === 'string' ? args.url : String(args.url ?? '');
      if (!url) return 'Error: url parameter is required';
      return await fetchUrl(url);
    }
    if (name === 'get_current_time') {
      return getCurrentTime();
    }
    if (name === 'list_scheduled_tasks') {
      return listScheduledTasks(ctx.groupFolder);
    }
    if (name === 'create_scheduled_task') {
      const prompt = typeof args.prompt === 'string' ? args.prompt : String(args.prompt ?? '');
      const cron = typeof args.cron_expression === 'string' ? args.cron_expression : String(args.cron_expression ?? '');
      if (!prompt) return 'Error: prompt parameter is required';
      if (!cron) return 'Error: cron_expression parameter is required';
      return createScheduledTask(prompt, cron, ctx.groupFolder, ctx.chatJid);
    }
    if (name === 'delete_scheduled_task') {
      const taskId = typeof args.task_id === 'string' ? args.task_id : String(args.task_id ?? '');
      if (!taskId) return 'Error: task_id parameter is required';
      return deleteScheduledTask(taskId, ctx.groupFolder);
    }
    if (name === 'get_weather') {
      const { getWeatherConditions } = await import('./weather-station.js');
      return await getWeatherConditions();
    }
    if (name === 'delegate_to_claude') {
      const reason = typeof args.reason === 'string' ? args.reason : 'complex task';
      throw new DelegateToClaudeError(reason);
    }
    return `Unknown tool: ${name}`;
  } catch (err) {
    if (err instanceof DelegateToClaudeError) throw err;
    logger.error({ err, tool: name }, 'Tool execution error');
    return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Agentic loop
// ---------------------------------------------------------------------------

const MAX_TOOL_STEPS = 5;

// Weather keywords that trigger a proactive get_weather pre-call.
// If the user's message matches, we execute get_weather before the first
// LLM inference and inject the result as an already-completed tool turn.
// This avoids relying on qwen to decide to call the tool itself.
const WEATHER_INTENT_RE =
  /\b(weather|temperature|temp\b|raining|rain|wind|humidity|humid|uv index|uv\b|pressure|outside|outdoor|how (hot|cold|warm|cool)|is it (hot|cold|warm|cool|raining|sunny|cloudy))\b/i;

export async function callOllamaWithTools(
  model: string,
  messages: OllamaApiMessage[],
  timeoutMs: number,
  ctx: OllamaToolContext,
  maxSteps = MAX_TOOL_STEPS,
): Promise<string> {
  const working: OllamaApiMessage[] = [...messages];

  // If the last user message is clearly about weather, pre-call get_weather
  // so Qwen has the data and only needs to write the response (no tool-call decision).
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (lastUser && WEATHER_INTENT_RE.test(lastUser.content)) {
    try {
      const weatherResult = await executeTool('get_weather', {}, ctx);
      // Inject as a completed tool turn — Qwen sees the result, skips the call step
      working.push({
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'get_weather', arguments: {} } }],
      });
      working.push({ role: 'tool', content: weatherResult });
      logger.info('Pre-called get_weather based on weather intent in message');
    } catch {
      // Non-fatal — let Qwen handle it normally
    }
  }

  for (let step = 0; step < maxSteps; step++) {
    const res = await fetch(`${OLLAMA_LOCAL_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: working,
        tools: OLLAMA_TOOLS,
        stream: false,
        keep_alive: -1,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama API ${res.status}: ${body}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    if (data.error) throw new Error(data.error);

    const msg = data.message;
    if (!msg) throw new Error('Ollama returned empty message');

    const toolCalls = msg.tool_calls;

    // No tool calls → this is the final answer
    if (!toolCalls || toolCalls.length === 0) {
      return msg.content?.trim() ?? '';
    }

    // Append assistant message (with tool_calls) to context
    working.push({
      role: 'assistant',
      content: msg.content ?? '',
      tool_calls: toolCalls,
    });

    // Execute each tool and append results
    for (const tc of toolCalls) {
      const result = await executeTool(tc.function.name, tc.function.arguments, ctx);
      working.push({ role: 'tool', content: result });
    }
  }

  // Exhausted max steps — return whatever content the last assistant message had
  logger.warn({ model, maxSteps }, 'callOllamaWithTools: exhausted max tool steps');
  for (let i = working.length - 1; i >= 0; i--) {
    const m = working[i];
    if (m.role === 'assistant' && m.content) return m.content.trim();
  }
  return '';
}
