/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

// Cross-origin isolation: lets us use SharedArrayBuffer later (e.g. lock-free meters).
// Consequence: every asset must be self-hosted.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [
    // Audio-thread files must never get React Refresh / HMR code injected.
    react({ exclude: [/\.worklet\.ts$/, /\/src\/sdk\/(worklet|dsp)\//, /\/node_modules\//] }),
  ],
  resolve: {
    alias: [
      { find: /^@agstudio\/sdk$/, replacement: `${root}src/sdk/index.ts` },
      { find: /^@agstudio\/sdk\/(.*)$/, replacement: `${root}src/sdk/$1` },
      { find: /^@core\/(.*)$/, replacement: `${root}src/core/$1` },
      { find: /^@engine\/(.*)$/, replacement: `${root}src/engine/$1` },
      { find: /^@platform\/(.*)$/, replacement: `${root}src/platform/$1` },
      { find: /^@app\/(.*)$/, replacement: `${root}src/app/$1` },
      { find: /^@ui\/(.*)$/, replacement: `${root}src/ui/$1` },
    ],
  },
  // 'es' is required for AudioWorklet modules: the default 'iife' rewrites import.meta.url to
  // self.location, and AudioWorkletGlobalScope has no `self`.
  worker: { format: 'es' },
  build: { target: 'esnext' },
  // PORT lets the preview tooling pick a free port; 5390 is AGstudio's own default.
  server: { port: Number(process.env.PORT) || 5390, strictPort: true, headers: isolation },
  preview: { headers: isolation },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.{ts,tsx}', 'plugins/**/*.test.ts', 'test/unit/**/*.test.ts'],
          exclude: ['**/*.browser.test.{ts,tsx}', '**/node_modules/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'audio',
          include: ['src/**/*.browser.test.{ts,tsx}', 'test/browser/**/*.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            // Uses the locally installed Google Chrome; no Playwright browser download needed.
            provider: playwright({
              launchOptions: { channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] },
            }),
            instances: [{ browser: 'chromium' }],
            screenshotFailures: false,
          },
        },
      },
    ],
  },
});
