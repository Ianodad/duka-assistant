import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  // Next keeps jsx: preserve in tsconfig; tests that import pages need the automatic runtime.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
      // The real 'server-only' throws outside the react-server condition; tests run in plain node.
      'server-only': path.resolve(__dirname, 'tests/stubs/server-only.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Blocks api.anthropic.com and counts SDK clients in every test file (AC-CP-3).
    setupFiles: ['tests/setup/network-guard.ts'],
    // Print only the guard's per-file live-call counter line (evidence in logs/test.txt); all other test console output stays hidden.
    silent: false,
    onConsoleLog: (log) => (log.startsWith('[network-guard]') ? undefined : false),
  },
});
