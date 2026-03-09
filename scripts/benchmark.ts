#!/usr/bin/env npx tsx
/**
 * LLM Benchmark — compares Claude, Gemini, and Ollama models.
 * Run: npx tsx scripts/benchmark.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '../.env');

// Load .env
const env: Record<string, string> = {};
for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY ?? '';
const GOOGLE_API_KEY = env.GOOGLE_API_KEY ?? '';
const OLLAMA_URL = env.OLLAMA_LOCAL_URL ?? 'http://localhost:11434';

const PROMPTS = [
  { label: 'simple fact', text: 'What is the capital of France? Reply in one sentence.' },
  { label: 'weather format', text: 'Format this weather data as a WhatsApp message using *bold* for labels: temp 24°C, humidity 65%, wind 12 km/h NW, UV 3.' },
  { label: 'reasoning', text: 'A bat and a ball cost $1.10 total. The bat costs $1 more than the ball. How much does the ball cost? Show your reasoning.' },
];

interface Result {
  model: string;
  prompt: string;
  ms: number;
  tokens: number;
  tps: number;
  reply: string;
  error?: string;
}

const results: Result[] = [];

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------
async function benchClaude(modelId: string, promptLabel: string, promptText: string): Promise<Result> {
  const t0 = Date.now();
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 256,
        messages: [{ role: 'user', content: promptText }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const ms = Date.now() - t0;
    const data = await res.json() as { content?: Array<{ text: string }>; usage?: { output_tokens: number }; error?: { message: string } };
    if (!res.ok || data.error) {
      return { model: modelId, prompt: promptLabel, ms, tokens: 0, tps: 0, reply: '', error: data.error?.message ?? `HTTP ${res.status}` };
    }
    const reply = data.content?.[0]?.text?.trim() ?? '';
    const tokens = data.usage?.output_tokens ?? 0;
    const tps = tokens / (ms / 1000);
    return { model: modelId, prompt: promptLabel, ms, tokens, tps, reply };
  } catch (err) {
    return { model: modelId, prompt: promptLabel, ms: Date.now() - t0, tokens: 0, tps: 0, reply: '', error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------
async function benchGemini(modelId: string, promptLabel: string, promptText: string): Promise<Result> {
  const t0 = Date.now();
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${GOOGLE_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: promptText }] }],
        generationConfig: { maxOutputTokens: 256 },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const ms = Date.now() - t0;
    const data = await res.json() as {
      candidates?: Array<{ content: { parts: Array<{ text?: string }> } }>;
      usageMetadata?: { candidatesTokenCount?: number };
      error?: { message: string };
    };
    if (!res.ok || data.error) {
      return { model: modelId, prompt: promptLabel, ms, tokens: 0, tps: 0, reply: '', error: data.error?.message ?? `HTTP ${res.status}` };
    }
    const reply = data.candidates?.[0]?.content?.parts?.find(p => p.text)?.text?.trim() ?? '';
    const tokens = data.usageMetadata?.candidatesTokenCount ?? 0;
    const tps = tokens / (ms / 1000);
    return { model: modelId, prompt: promptLabel, ms, tokens, tps, reply };
  } catch (err) {
    return { model: modelId, prompt: promptLabel, ms: Date.now() - t0, tokens: 0, tps: 0, reply: '', error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------
async function warmOllama(model: string): Promise<void> {
  try {
    await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: 'hi', stream: false, keep_alive: -1 }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch { /* ignore */ }
}

async function benchOllama(model: string, promptLabel: string, promptText: string): Promise<Result> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: promptText }],
        stream: false,
        keep_alive: -1,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const ms = Date.now() - t0;
    const data = await res.json() as { message?: { content?: string }; eval_count?: number; error?: string };
    if (!res.ok || data.error) {
      return { model, prompt: promptLabel, ms, tokens: 0, tps: 0, reply: '', error: data.error ?? `HTTP ${res.status}` };
    }
    const reply = data.message?.content?.trim() ?? '';
    const tokens = data.eval_count ?? 0;
    const tps = tokens / (ms / 1000);
    return { model, prompt: promptLabel, ms, tokens, tps, reply };
  } catch (err) {
    return { model, prompt: promptLabel, ms: Date.now() - t0, tokens: 0, tps: 0, reply: '', error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const claudeModels = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
];

const geminiModels = [
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite-preview-06-17',
  'gemini-2.5-pro',
];

const ollamaModels = [
  'qwen2.5:1.5b',
  'qwen2.5:3b',
  'llama3.2',
];

function fmt(n: number, dec = 1): string {
  return n.toFixed(dec);
}

function printRow(r: Result): void {
  const modelShort = r.model.replace('claude-', '').replace('gemini-', '').replace('20251001', '').replace('-preview-06-17', '');
  if (r.error) {
    console.log(`  ${modelShort.padEnd(28)} | ${r.prompt.padEnd(16)} | ERROR: ${r.error.slice(0, 60)}`);
  } else {
    console.log(
      `  ${modelShort.padEnd(28)} | ${r.prompt.padEnd(16)} | ${String(r.ms).padStart(5)}ms | ${String(r.tokens).padStart(4)} tok | ${fmt(r.tps).padStart(6)} tok/s`,
    );
  }
}

async function main(): Promise<void> {
  console.log('\n=== LLM Benchmark ===\n');

  // Warm Ollama models
  console.log('Warming Ollama models...');
  for (const m of ollamaModels) {
    process.stdout.write(`  Loading ${m}... `);
    await warmOllama(m);
    console.log('done');
  }
  console.log();

  // Claude
  if (ANTHROPIC_API_KEY) {
    console.log('--- Claude ---');
    for (const model of claudeModels) {
      for (const { label, text } of PROMPTS) {
        const r = await benchClaude(model, label, text);
        results.push(r);
        printRow(r);
      }
    }
    console.log();
  } else {
    console.log('Skipping Claude (no ANTHROPIC_API_KEY)\n');
  }

  // Gemini
  if (GOOGLE_API_KEY) {
    console.log('--- Gemini ---');
    for (const model of geminiModels) {
      for (const { label, text } of PROMPTS) {
        const r = await benchGemini(model, label, text);
        results.push(r);
        printRow(r);
      }
    }
    console.log();
  } else {
    console.log('Skipping Gemini (no GOOGLE_API_KEY)\n');
  }

  // Ollama
  console.log('--- Ollama ---');
  for (const model of ollamaModels) {
    for (const { label, text } of PROMPTS) {
      const r = await benchOllama(model, label, text);
      results.push(r);
      printRow(r);
    }
  }
  console.log();

  // Summary — average tok/s per model
  console.log('--- Summary (avg tok/s across prompts) ---');
  const byModel = new Map<string, Result[]>();
  for (const r of results) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model)!.push(r);
  }
  for (const [model, rows] of byModel) {
    const ok = rows.filter(r => !r.error);
    if (ok.length === 0) {
      console.log(`  ${model.padEnd(40)} | ALL FAILED`);
      continue;
    }
    const avgTps = ok.reduce((s, r) => s + r.tps, 0) / ok.length;
    const avgMs = ok.reduce((s, r) => s + r.ms, 0) / ok.length;
    const avgTok = ok.reduce((s, r) => s + r.tokens, 0) / ok.length;
    console.log(`  ${model.padEnd(40)} | avg ${fmt(avgMs, 0).padStart(5)}ms | ${fmt(avgTok, 0).padStart(4)} tok | ${fmt(avgTps).padStart(6)} tok/s`);
  }

  console.log('\nDone.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
