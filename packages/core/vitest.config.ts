import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'better-sqlite3': resolve(
        __dirname,
        '../../apps/emdash-desktop/tooling/node-deps/node_modules/better-sqlite3'
      ),
    },
  },
  test: {
    environment: 'node',
    // Workspace tests also start native Git and language-server subprocesses.
    maxWorkers: 4,
    setupFiles: [resolve(__dirname, '../../tooling/vitest/setup-isolated-home.mjs')],
    include: ['**/*.test.ts', '**/*.test.tsx'],
  },
});
