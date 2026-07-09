import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
  plugins: [sveltekit() as any],
  test: {
    environment: 'jsdom',
    include: [
      'src/**/*.test.ts',
      'scripts/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/cross-cutting/**/*.test.ts'
    ],
    exclude: ['tests/e2e/**'],
    globals: true,
    setupFiles: ['./src/vitest-setup.ts']
  },
  resolve: {
    conditions: ['mode=test', 'browser'],
    alias: [{ find: '$lib', replacement: '/src/lib' }]
  }
});
