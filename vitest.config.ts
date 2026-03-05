import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests: exclude integration tests (those need a live Ollama container)
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
  },
});
