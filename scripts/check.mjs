// `npm run check`: everything CI would run, in phases.
//   1. tsc -b (all five tsconfigs) and eslint run side by side: they are independent, mostly single-threaded
//      and both cached (tsc incremental state, eslint --cache), so a warm run costs a few seconds. Their output is
//      buffered so the two never interleave.
//   2. the unit tests (Node), 3. the audio tests (headless Chrome), one after the other. They used to share one
//      `vitest run`, so nine Node workers and nine Chrome pages competed for the cores and the speed- and
//      UI-timing tests failed under that load; one phase at a time keeps every test on a machine its own size.
//   4. the quiet-machine tests: the ones tagged `perf` (speed, CPU cost, memory) or `realtime` (a live audio clock), in Node
//      and then in Chrome, one file at a time. Even with the phases above apart, many files at once still share the cores, which
//      is exactly what those tests cannot take; the two parallel phases leave them out and this one runs them alone
//      (scripts/lib/test-stages.mjs, vite.config.ts).
// The tests only run when the static checks passed; every test phase runs even if another failed, so one run
// shows every failure. Exit code 1 when anything failed.
//
// The tools are started with this Node and their own JavaScript files (scripts/lib/tools.mjs), not through `npm run`:
// on Windows `npm` and `.bin/*` are .cmd files that Node cannot start without a shell. The typecheck and lint command
// lines still come from package.json's scripts, so `npm run lint` and this stay the same thing.
import { spawn } from 'node:child_process';
import { STAGES, vitestArguments } from './lib/test-stages.mjs';
import { binPath, nodeArgumentsForScript, packageScripts, repoRoot } from './lib/tools.mjs';

const scripts = packageScripts();

/** Runs a tool's JavaScript file with Node, collecting its output (or letting it print, with `stream`). */
function run(label, nodeArguments, { stream = false } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, nodeArguments, {
      cwd: repoRoot,
      stdio: stream ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.on('error', (error) => resolve({ label, code: 1, out: String(error), seconds: 0 }));
    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ label, code: code ?? 1, out, seconds: (Date.now() - started) / 1000 }));
  });
}

/** The test stages, in order: the two parallel ones, then the quiet-machine ones (one file at a time). */
const TEST_STAGES = ['unit', 'audio', 'unit-timing', 'audio-realtime'];

const t0 = Date.now();
const phases = [];

const statics = await Promise.all([
  run('tsc -b', nodeArgumentsForScript(scripts.typecheck)),
  run('eslint', nodeArgumentsForScript(scripts.lint)),
]);
for (const r of statics) {
  phases.push(r);
  if (r.code !== 0) console.error(`\n--- ${r.label} failed (exit ${r.code}) ---\n${r.out}`);
}

if (statics.every((r) => r.code === 0)) {
  const vitest = binPath('vitest');
  for (const name of TEST_STAGES) {
    phases.push(await run(STAGES[name].label, [vitest, ...vitestArguments(name)], { stream: true }));
  }
} else {
  console.error('\nSkipping the tests: fix the type or lint errors above first.');
}

console.log('\ncheck:');
for (const r of phases)
  console.log(`  ${r.code === 0 ? 'ok    ' : 'FAILED'} ${r.label.padEnd(16)} ${r.seconds.toFixed(1)} s`);
console.log(`  total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(phases.some((r) => r.code !== 0) || phases.length < 2 + TEST_STAGES.length ? 1 : 0);
