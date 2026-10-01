import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['carriers/**/*.live.test.ts', 'providers/**/*.live.test.ts', 'testing/**/*.live.test.ts'], environment: 'node', fileParallelism: false, maxConcurrency: 1, testTimeout: 60_000, reporters: ['default', './scripts/canary-report.mjs'] } });
