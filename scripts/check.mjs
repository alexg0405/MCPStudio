// `npm run check`: everything CI would run, in three phases.
//   1. tsc -b (all four tsconfigs) and eslint run side by side: they are independent, mostly single-threaded
//      and both cached (tsc incremental state, eslint --cache), so a warm run costs a few seconds. Their output is
//      buffered so the two never interleave.
//   2. the unit tests (Node), 3. the audio tests (headless Chrome), one after the other. They used to share one
//      `vitest run`, so nine Node workers and nine Chrome pages competed for the cores and the speed- and
//      UI-timing tests failed under that load; one phase at a time keeps every test on a machine its own size.
// The tests only run when the static checks passed; unit and audio both run even if the other failed, so one run
// shows every failure. Exit code 1 when anything failed.
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(label, args, { stream = false } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(npm, args, { stdio: stream ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ label, code: code ?? 1, out, seconds: (Date.now() - started) / 1000 }));
  });
}

const t0 = Date.now();
const phases = [];

const statics = await Promise.all([
  run('tsc -b', ['run', '--silent', 'typecheck']),
  run('eslint', ['run', '--silent', 'lint']),
]);
for (const r of statics) {
  phases.push(r);
  if (r.code !== 0) console.error(`\n--- ${r.label} failed (exit ${r.code}) ---\n${r.out}`);
}

if (statics.every((r) => r.code === 0)) {
  phases.push(await run('vitest unit', ['exec', '--', 'vitest', 'run', '--project', 'unit'], { stream: true }));
  phases.push(await run('vitest audio', ['exec', '--', 'vitest', 'run', '--project', 'audio'], { stream: true }));
} else {
  console.error('\nSkipping the tests: fix the type or lint errors above first.');
}

console.log('\ncheck:');
for (const r of phases) console.log(`  ${r.code === 0 ? 'ok    ' : 'FAILED'} ${r.label.padEnd(13)} ${r.seconds.toFixed(1)} s`);
console.log(`  total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(phases.some((r) => r.code !== 0) || phases.length < 4 ? 1 : 0);
