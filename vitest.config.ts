import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Tests for the Electron side (main, worker, shared). Run through Electron's Node runtime
 * (`pnpm test:electron`) so native addons match the app. Renderer tests run via `ng test`.
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) },
  },
  test: {
    include: ['src/{main,worker,shared}/**/*.spec.ts'],
    environment: 'node',
  },
});
