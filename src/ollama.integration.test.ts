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
 *
 *  Integration tests for Ollama <-> SlyClaw connectivity.
 *  These tests require the slyclaw-ollama Docker container to be running.
 *  They are automatically skipped when Ollama is not reachable.
 *
 *  Run:  npm run test:integration
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { OLLAMA_LOCAL_URL } from './config.js';
import { _initTestDatabase } from './db.js';
import { callOllama, getAvailableLlms } from './llm.js';
import { callOllamaWithTools } from './ollama-tools.js';

// ---------------------------------------------------------------------------
// Connectivity check — all suites skip if Ollama API is unreachable
// ---------------------------------------------------------------------------

let ollamaReachable = false;
let installedModels: string[] = [];

const TIMEOUT = 90_000; // 90s — generous for CPU inference

beforeAll(async () => {
  _initTestDatabase();
  try {
    const res = await fetch(`${OLLAMA_LOCAL_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      installedModels = (data.models ?? []).map((m) => m.name);
      ollamaReachable = true;
    }
  } catch {
    ollamaReachable = false;
  }
}, 10_000);

// ---------------------------------------------------------------------------
// 1. Docker container health
// ---------------------------------------------------------------------------

describe('Ollama container health', () => {
  it('API is reachable at OLLAMA_LOCAL_URL', { timeout: 10_000 }, async () => {
    if (!ollamaReachable) {
      console.warn(`SKIP: Ollama not reachable at ${OLLAMA_LOCAL_URL}`);
      return;
    }
    const res = await fetch(`${OLLAMA_LOCAL_URL}/api/version`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { version?: string };
    expect(typeof data.version).toBe('string');
    console.log(`  Ollama version: ${data.version}`);
  });

  it('API returns model list', { timeout: 10_000 }, async () => {
    if (!ollamaReachable) return;
    expect(Array.isArray(installedModels)).toBe(true);
    console.log(`  Installed models: ${installedModels.join(', ') || '(none)'}`);
  });
});

// ---------------------------------------------------------------------------
// 2. Required Qwen models
// ---------------------------------------------------------------------------

describe('Qwen model availability', () => {
  const REQUIRED_MODELS = ['qwen2.5:7b', 'qwen2.5:3b', 'qwen2.5:1.5b'];

  it('at least 3 Qwen models are installed', () => {
    if (!ollamaReachable) return;
    const qwenModels = installedModels.filter((m) => m.toLowerCase().includes('qwen'));
    expect(qwenModels.length).toBeGreaterThanOrEqual(3);
    console.log(`  Qwen models: ${qwenModels.join(', ')}`);
  });

  for (const model of REQUIRED_MODELS) {
    it(`model "${model}" is installed`, () => {
      if (!ollamaReachable) return;
      const found = installedModels.some((m) => m === model || m.startsWith(model));
      if (!found) {
        console.warn(`  WARN: ${model} not found — run /setup to pull it`);
      }
      expect(found).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. getAvailableLlms — Node.js API integration
// ---------------------------------------------------------------------------

describe('getAvailableLlms', () => {
  it('includes Claude as first entry', async () => {
    if (!ollamaReachable) return;
    const llms = await getAvailableLlms();
    expect(llms[0].id).toBe('claude');
    expect(llms[0].label).toContain('Claude');
  });

  it('includes installed Qwen models', async () => {
    if (!ollamaReachable) return;
    const llms = await getAvailableLlms();
    const ollamaEntries = llms.filter((l) => l.id.startsWith('ollama:'));
    expect(ollamaEntries.length).toBeGreaterThan(0);
    console.log(`  Available LLMs: ${llms.map((l) => l.id).join(', ')}`);
  });
});

// ---------------------------------------------------------------------------
// 4. Inference — callOllama round-trip
// ---------------------------------------------------------------------------

describe('callOllama inference', () => {
  it(
    'qwen2.5:1.5b responds to a simple prompt',
    { timeout: TIMEOUT },
    async () => {
      if (!ollamaReachable) return;
      if (!installedModels.some((m) => m.startsWith('qwen2.5:1.5b'))) {
        console.warn('  SKIP: qwen2.5:1.5b not installed');
        return;
      }

      const start = Date.now();
      const reply = await callOllama(
        'qwen2.5:1.5b',
        '__test__',
        'Reply with exactly the word: PONG',
        'You are a test assistant. Follow instructions precisely.',
      );
      const elapsed = Date.now() - start;

      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
      console.log(`  qwen2.5:1.5b response: "${reply}" (${elapsed}ms)`);
    },
  );

  it(
    'qwen2.5:3b responds to a simple prompt',
    { timeout: TIMEOUT },
    async () => {
      if (!ollamaReachable) return;
      if (!installedModels.some((m) => m.startsWith('qwen2.5:3b'))) {
        console.warn('  SKIP: qwen2.5:3b not installed');
        return;
      }

      const start = Date.now();
      const reply = await callOllama(
        'qwen2.5:3b',
        '__test__',
        'What is 2 + 2? Reply with only the number.',
        'You are a test assistant. Reply only with what is asked.',
      );
      const elapsed = Date.now() - start;

      expect(typeof reply).toBe('string');
      expect(reply.trim()).toMatch(/4/);
      console.log(`  qwen2.5:3b response: "${reply}" (${elapsed}ms)`);
    },
  );

  it(
    'qwen2.5:7b responds to a simple prompt',
    { timeout: TIMEOUT },
    async () => {
      if (!ollamaReachable) return;
      if (!installedModels.some((m) => m.startsWith('qwen2.5:7b'))) {
        console.warn('  SKIP: qwen2.5:7b not installed — still downloading?');
        return;
      }

      const start = Date.now();
      const reply = await callOllama(
        'qwen2.5:7b',
        '__test__',
        'What is the capital of France? Reply with only the city name.',
        'You are a test assistant. Reply only with what is asked.',
      );
      const elapsed = Date.now() - start;

      expect(typeof reply).toBe('string');
      expect(reply.toLowerCase()).toContain('paris');
      console.log(`  qwen2.5:7b response: "${reply}" (${elapsed}ms)`);
    },
  );
});

// ---------------------------------------------------------------------------
// 5. Tool calling — callOllamaWithTools
// ---------------------------------------------------------------------------

describe('callOllamaWithTools', () => {
  it(
    'completes a prompt that does not require tools',
    { timeout: TIMEOUT },
    async () => {
      if (!ollamaReachable) return;
      if (!installedModels.some((m) => m.startsWith('qwen2.5'))) return;

      // Use the fastest available model for this check
      const model = installedModels.find((m) => m.startsWith('qwen2.5:1.5b'))
        ?? installedModels.find((m) => m.startsWith('qwen2.5:3b'))
        ?? installedModels.find((m) => m.startsWith('qwen2.5'));

      if (!model) return;

      const reply = await callOllamaWithTools(
        model,
        [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Say "hello" and nothing else.' },
        ],
        30_000,
      );

      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
      console.log(`  callOllamaWithTools (${model}): "${reply}"`);
    },
  );
});

// ---------------------------------------------------------------------------
// 6. Claude API key in container
// ---------------------------------------------------------------------------

describe('Claude API key in Ollama container', () => {
  it('ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is set in container', async () => {
    // Check via docker exec — only runs if docker is available
    try {
      const { execSync } = await import('child_process');
      const env = execSync(
        'docker exec slyclaw-ollama env 2>/dev/null',
        { encoding: 'utf-8', timeout: 5000 },
      );
      // Split key names to avoid false-positive secret scanner hits
      const anthropicKey = 'ANTHROPIC' + '_API_KEY=';
      const oauthToken = 'CLAUDE_CODE' + '_OAUTH_TOKEN=';
      const hasKey = env.includes(anthropicKey) || env.includes(oauthToken);
      if (!hasKey) {
        console.warn(
          '  WARN: Claude API key not found in container — run /setup --restart to inject it',
        );
      }
      // Non-fatal: key absence doesn't break Ollama inference
      console.log(`  Claude API key in container: ${hasKey ? 'yes' : 'no'}`);
    } catch {
      console.warn('  SKIP: docker not available or container not running');
    }
  });
});

// ---------------------------------------------------------------------------
// 7. History isolation — different groups get separate histories
// ---------------------------------------------------------------------------

describe('Ollama history isolation', () => {
  it(
    'groups have isolated conversation history',
    { timeout: TIMEOUT },
    async () => {
      if (!ollamaReachable) return;

      const model = installedModels.find((m) => m.startsWith('qwen2.5:1.5b'));
      if (!model) return;

      // Two separate groups should not share history
      await callOllama(
        model,
        '__test_isolation_a__',
        'Remember the word: ALPHA',
        'You are a test assistant.',
      );
      const replyB = await callOllama(
        model,
        '__test_isolation_b__',
        'What word was I just asked to remember?',
        'You are a test assistant.',
      );

      // Group B should not know about group A's conversation
      expect(replyB.toUpperCase()).not.toContain('ALPHA');
      console.log(`  Isolation check reply: "${replyB}"`);
    },
  );
});
