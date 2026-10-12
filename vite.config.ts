/// <reference types="vitest/config" />
import { defineConfig, type EnvironmentModuleNode, type Plugin } from 'vite';
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

/**
 * Hot reload for AudioWorklet code. A processor module can't be re-registered in a running
 * AudioContext, and Vite would otherwise full-reload the page (worker modules have no importers).
 * When only audio-thread modules changed, tell the app to reboot its audio engine instead.
 */
function workletHmr(): Plugin {
  const isUrlStub = (url: string) => /[?&]worker(&|$)/.test(url) && !url.includes('worker_file');
  const audioThreadOnly = (m: EnvironmentModuleNode, seen = new Set<EnvironmentModuleNode>()): boolean => {
    if (m.url.includes('worker_file')) return true;
    if (seen.has(m)) return true;
    seen.add(m);
    if (m.importers.size === 0) return false;
    for (const importer of m.importers) if (!audioThreadOnly(importer, seen)) return false;
    return true;
  };
  return {
    name: 'ag:worklet-hmr',
    apply: 'serve',
    hotUpdate({ modules, file }) {
      if (this.environment.name !== 'client') return;
      const real = modules.filter((m) => !isUrlStub(m.url));
      if (real.length > 0 && real.every((m) => audioThreadOnly(m))) {
        this.environment.hot.send({ type: 'custom', event: 'ag:worklet-changed', data: { file } });
        return [];
      }
    },
  };
}

export default defineConfig({
  plugins: [
    // Audio-thread files (worklet entries, kernels, shared params, SDK audio modules) must never get
    // React Refresh / HMR code injected: the AudioWorklet scope has no HMR client.
    react({
      exclude: [
        /\.worklet\.ts$/,
        /(^|\/)(\w+\.)?kernel\.ts$/,
        /\/params\.ts$/,
        /\/src\/sdk\/(worklet|dsp)\//,
        /\/src\/sdk\/(params|protocol)\.ts$/,
        /\/node_modules\//,
      ],
    }),
    workletHmr(),
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
