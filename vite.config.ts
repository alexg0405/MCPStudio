/// <reference types="vitest/config" />
import { defineConfig, loadEnv, normalizePath, type EnvironmentModuleNode, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { draftServer } from './tools/ai/drafts.ts';
import { faustPlugin } from './tools/faust/vite-plugin.ts';
import { aiServer } from './tools/ai/server.ts';
import { mcpServer } from './tools/mcp/server.ts';
import { pwaPrecache } from './tools/pwa/precache.ts';
import { findQuietFiles } from './tools/test/quiet-files.ts';

// Vite, its globs and its aliases use forward slashes on every system; fileURLToPath gives `C:\Users\…\` on Windows.
// (The folder keeps its trailing slash, so `${root}src/…` below reads the same everywhere.)
const root = normalizePath(fileURLToPath(new URL('.', import.meta.url)));

/** The browser the audio tests run in: the installed Google Chrome, or another Chromium browser of the same install (`msedge`). */
const testBrowser = process.env.AGSTUDIO_TEST_BROWSER || 'chrome';

const UNIT_INCLUDE = ['src/**/*.test.{ts,tsx}', 'plugins/**/*.test.ts', 'test/unit/**/*.test.ts'];
const UNIT_EXCLUDE = ['**/*.browser.test.{ts,tsx}', '**/node_modules/**', 'plugins/_*/**'];
/** Runs before each Node test file (a longer default for `vi.waitFor`, which gives up after 1 s). */
const UNIT_SETUP = ['test/unit/setup.ts'];
const AUDIO_INCLUDE = ['src/**/*.browser.test.{ts,tsx}', 'test/browser/**/*.test.ts'];

/**
 * How many test files run in Chrome side by side in the `audio` project: about six tenths of the cores. Vitest's default (all
 * cores but one) put nine pages on ten cores, and each page renders audio on threads of its own, so the pages waited for each
 * other: on this machine nine pages took 248 to 292 s and six took 229 s, with every file's own time a third shorter (and the
 * timing-sensitive UI tests failing less).
 */
const AUDIO_WORKERS = Math.max(2, Math.round(availableParallelism() * 0.6));

/** The files with `perf` or `realtime` tests (tools/test/quiet-files.ts): what the two sequential projects run. */
const quietFiles = findQuietFiles(root);

/** A project that runs its test files in headless Chrome; `sequential` runs them one at a time instead of side by side. */
function browserProject(options: {
  name: string;
  include: string[];
  testTimeout: number;
  sequential?: boolean;
  maxWorkers?: number;
}) {
  return {
    extends: true,
    // The dev server's strictPort would otherwise apply to the browser-test server too; parallel
    // runs (another terminal, a worktree) should take the next free port instead of failing.
    server: { strictPort: false },
    test: {
      name: options.name,
      include: options.include,
      testTimeout: options.testTimeout,
      hookTimeout: 120_000,
      // Fixed entity ids: renders (whose noise is seeded from ids) repeat from run to run.
      setupFiles: ['test/browser/setup.ts'],
      ...(options.sequential ? { fileParallelism: false } : {}),
      ...(options.maxWorkers ? { maxWorkers: options.maxWorkers } : {}),
      browser: {
        enabled: true,
        headless: true,
        // Uses the locally installed Google Chrome (or the browser named in AGSTUDIO_TEST_BROWSER, e.g. msedge); no Playwright browser download needed.
        provider: playwright({
          launchOptions: { channel: testBrowser, args: ['--autoplay-policy=no-user-gesture-required'] },
        }),
        instances: [{ browser: 'chromium' as const }],
        screenshotFailures: false,
      },
    },
  };
}

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

export default defineConfig(({ mode }) => ({
  plugins: [
    // The beat assistant reaches Claude through the dev/preview server (subscription or API key).
    aiServer(() => loadEnv(mode, root, '')),
    // AI apps (Claude Code, Claude Desktop…) control the open project over MCP: POST /mcp, relayed to the tab.
    mcpServer({ root }),
    // Plugins the AI studio writes: drafts in plugins/_drafts, checked, installed on request.
    draftServer(root),
    // `.dsp` files: Faust plugins, compiled to WebAssembly (tools/faust).
    faustPlugin(),
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
    // Installable app: after the build, dist/sw.js (the service worker) with the list of files it keeps offline.
    pwaPrecache({ entry: `${root}src/sw/sw.ts` }),
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
      { find: /^@sw\/(.*)$/, replacement: `${root}src/sw/$1` },
    ],
  },
  // 'es' is required for AudioWorklet modules: the default 'iife' rewrites import.meta.url to
  // self.location, and AudioWorkletGlobalScope has no `self`.
  // Worker (and AudioWorklet) bundles get their own plugin list: Faust worklets are generated by ours.
  worker: { format: 'es', plugins: () => [faustPlugin()] },
  // One app bundle (~1.4 MB, ~500 kB gzipped before the first render) is fine for a desktop DAW that loads once. The warning limit sits a bit
  // above it, so the build is quiet today and warns when the bundle grows another ~15 %.
  build: { target: 'esnext', chunkSizeWarningLimit: 2048 },
  // PORT lets the preview tooling pick a free port; 5390 is AGstudio's own default.
  server: {
    port: Number(process.env.PORT) || 5390,
    strictPort: true,
    headers: isolation,
    // Helper-agent worktrees live inside the project folder; their files aren't this app's. Anchored to
    // this root, so a dev server started inside a worktree still watches its own files.
    watch: { ignored: [`${root}.claude/worktrees/**`] },
  },
  // Optimized up front: a dependency discovered mid-run gets re-bundled under a new hash, and modules
  // that already loaded the old copy end up with a second React (hooks then fail).
  optimizeDeps: {
    entries: ['index.html'],
    include: [
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-dom',
      'react-dom/client',
      'zustand',
      'zustand/vanilla',
      // useShallow (the Decks window): a dependency found mid-run would re-bundle and reload the page.
      'zustand/react/shallow',
      'immer',
      'fflate',
      // MP3 export: only the encoder Worker imports it, which the dependency scan doesn't see.
      '@breezystack/lamejs',
    ],
  },
  // The production build served locally (`agstudio --app`): its own port, so the installed app's address never
  // collides with the dev server's (an installed app belongs to one origin, port included).
  preview: { headers: isolation, port: Number(process.env.APP_PORT) || 5391, strictPort: true },
  test: {
    // Vitest's persistent transform cache keys modules by their own source, so an `import.meta.glob`
    // (plugin discovery, feature registration) keeps its old matches after folders are added or
    // removed. Discovery is central here, so correctness wins over a slightly faster cold start.
    fsModuleCache: false,
    // `expect.poll` (UI and engine tests waiting for a state to arrive) gives up after 1 s unless told otherwise; a state that
    // arrives is passed at once whatever the limit, and a busy machine only delays it.
    expect: { poll: { timeout: 15_000, interval: 25 } },
    // Two tags mark the tests that only mean something on a machine that is not shared with other tests. `npm run check`
    // (scripts/check.mjs) leaves them out of the parallel stages and runs them last, one file at a time (the `unit-timing`
    // and `audio-realtime` projects below):
    //  - `perf`: asserts on speed, CPU cost or memory. The regular run keeps loose sanity bounds for them (the whole suite
    //    competes for the same cores); `npm run test:perf` runs only these, with the real limits (VITE_PERF_STRICT).
    //  - `realtime`: needs a live audio clock (a realtime AudioContext that must keep up, a loopback recording, playing
    //    while something else changes), so any other load on the machine changes what it measures.
    tags: [
      { name: 'perf', description: 'Asserts on speed, CPU cost or memory: real limits only under `npm run test:perf` (quiet machine).' },
      { name: 'realtime', description: 'Needs a live audio clock: runs alone, after the parallel tests (`npm run check`).' },
    ],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: UNIT_INCLUDE,
          exclude: UNIT_EXCLUDE,
          setupFiles: UNIT_SETUP,
          // DSP tests render seconds of audio and a busy machine (the other workers, a browser run alongside) can take
          // several times as long as a quiet one: a timeout is for a hang, not a speed check.
          testTimeout: 60_000,
        },
      },
      {
        // The Node tests tagged `perf` (kernel cost, analysis speed), one file at a time. `npm run check` runs only the
        // tagged tests here and leaves them out of the `unit` project.
        extends: true,
        test: {
          name: 'unit-timing',
          environment: 'node',
          include: quietFiles.node,
          exclude: UNIT_EXCLUDE,
          setupFiles: UNIT_SETUP,
          testTimeout: 120_000,
          fileParallelism: false,
        },
      },
      browserProject({
        name: 'audio',
        include: AUDIO_INCLUDE,
        // Offline renders compete with up to nine other files for the cores, and tests that run concurrently
        // inside a file (describe.concurrent) wait for each other: the browser default of 15 s only ever fired
        // on a busy machine. A timeout is for a hang, not a speed check. Longer chains of renders set their own.
        testTimeout: 180_000,
        maxWorkers: AUDIO_WORKERS,
      }),
      // The browser tests tagged `perf` or `realtime`, one file at a time, so the live audio clock and the wall-clock
      // measurements of one test are not disturbed by the renders of another.
      browserProject({ name: 'audio-realtime', include: quietFiles.browser, testTimeout: 180_000, sequential: true }),
    ],
  },
}));
