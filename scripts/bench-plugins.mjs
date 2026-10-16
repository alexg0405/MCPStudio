#!/usr/bin/env node
// CPU benchmark of every built-in worklet kernel (see test/bench/plugin-bench.ts for what it measures).
//   npm run bench:plugins -- [--only chorus,reverb] [--reps 5] [--seconds 4] [--json]
// Bundles the benchmark with rolldown (the bundler Vite uses for the worklets) and runs it in Node,
// so kernels are measured the way production runs them rather than through a test runner's module
// wrappers.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'node_modules', '.cache', 'ag-bench');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, 'plugin-bench.mjs');

/** Vite's aliases, and stand-ins for what only the browser app needs (worker URLs, CSS modules). */
const plugin = {
  name: 'ag-bench',
  resolveId(id, importer) {
    if (/\?worker/.test(id)) return '\0stub-worker.js';
    if (/\.css($|\?)/.test(id)) return '\0stub-css.js';
    const sdk = id.match(/^@agstudio\/sdk(?:\/(.*))?$/);
    if (sdk) return this.resolve(join(root, 'src/sdk', sdk[1] ?? 'index.ts'), importer, { skipSelf: true });
    const layer = id.match(/^@(core|engine|platform|app|ui)\/(.*)$/);
    if (layer) return this.resolve(join(root, 'src', layer[1], layer[2]), importer, { skipSelf: true });
    return null;
  },
  load(id) {
    if (id === '\0stub-worker.js') return 'export default "";';
    if (id === '\0stub-css.js') return 'export default new Proxy({}, { get: (_, k) => String(k) });';
    return null;
  },
};

const bundle = await rolldown({
  input: join(root, 'test/bench/plugin-bench.ts'),
  platform: 'node',
  plugins: [plugin],
  logLevel: 'silent',
  transform: { jsx: { runtime: 'automatic' } },
});
await bundle.write({ file, format: 'esm', sourcemap: false });
await bundle.close();

const run = spawnSync(process.execPath, [file, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(run.status ?? 1);
