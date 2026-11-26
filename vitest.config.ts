import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';
import {
  UNIT_TEST_EXCLUDE,
  UNIT_TEST_INCLUDE,
  vitestForceRerunTriggers
} from './scripts/unit-test-selection.mjs';

export default defineConfig({
  plugins: [sveltekit() as any],
  test: {
    environment: 'node',
    include: UNIT_TEST_INCLUDE,
    exclude: UNIT_TEST_EXCLUDE,
    forceRerunTriggers: vitestForceRerunTriggers(),
    globals: true,
    globalSetup: ['./src/vitest-global-setup.ts'],
    setupFiles: ['./src/vitest-setup.ts']
  },
  resolve: {
    conditions: ['mode=test', 'browser'],
    alias: [{ find: '$lib', replacement: '/src/lib' }]
  }
});
