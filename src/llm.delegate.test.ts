import { describe, expect, it, vi } from 'vitest';

// Keep the real module (DelegateToClaudeError, history helpers, etc.) but stub the
// network-facing tool loop so we can drive callOllama's catch block deterministically.
vi.mock('./ollama-tools.js', async (importActual) => {
  const actual = await importActual<typeof import('./ollama-tools.js')>();
  return { ...actual, callOllamaWithTools: vi.fn() };
});

import { callOllama } from './llm.js';
import { DelegateToClaudeError, callOllamaWithTools } from './ollama-tools.js';

describe('callOllama — delegate_to_claude propagation', () => {
  it('re-throws DelegateToClaudeError instead of collapsing to plain chat', async () => {
    // Regression: the delegate reason text contains the word "tool", which used to
    // match the plain-chat fallback regex (/tool|function.?call/i) and silently swallow
    // the hand-off — so a "peak wind in 24h" query got a canned reply instead of Claude.
    vi.mocked(callOllamaWithTools).mockRejectedValueOnce(
      new DelegateToClaudeError('needs historical peak wind — not available from the get_weather tool'),
    );

    await expect(
      callOllama('gemma4:31b', '/tmp/nonexistent-group', 'jid@g.us', 'peak wind in the last 24h?', 'sys'),
    ).rejects.toBeInstanceOf(DelegateToClaudeError);
  });

  it('still falls back to plain chat for genuine tool-support errors', async () => {
    // A real "model does not support tools" error must NOT propagate — it should fall
    // through to callOllamaPlain. We assert it does not reject with DelegateToClaudeError.
    vi.mocked(callOllamaWithTools).mockRejectedValueOnce(new Error('this model does not support tools'));

    await expect(
      callOllama('gemma4:31b', '/tmp/nonexistent-group', 'jid@g.us', 'hello', 'sys', 1),
    ).rejects.not.toBeInstanceOf(DelegateToClaudeError);
  });
});
