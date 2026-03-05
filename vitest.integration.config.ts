import { defineConfig } from 'vitest/config';

// NODE_EXTRA_CA_CERTS is needed so Node.js can verify TLS certificates for sites
// that don't send the full intermediate chain (e.g. example.com via Cloudflare).
// Node.js bundles Mozilla's CA store; system store has broader coverage.
process.env.NODE_EXTRA_CA_CERTS ??= '/etc/ssl/certs/ca-certificates.crt';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 300000,
    hookTimeout: 30000,
  },
});
