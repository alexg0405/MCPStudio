// `npm run check`: everything CI would run.
//   1. tsc -b (all four tsconfigs) and eslint run side by side: they are independent, mostly single-threaded
//      and both cached (tsc incremental state, eslint --cache), so a warm run costs a few seconds.
//   2. vitest (unit + audio projects) runs only when both passed, on a machine that is not busy with
//      type-checking: the audio tests measure speed and are the ones that suffer from contention.
// Output of the parallel steps is buffered so the two never interleave; a failure prints its output and exits 1.
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
const statics = await Promise.all([
  run('tsc -b', ['run', '--silent', 'typecheck']),
  run('eslint', ['run', '--silent', 'lint']),
]);
let failed = false;
for (const r of statics) {
  if (r.code !== 0) {
    failed = true;
    console.error(`\n--- ${r.label} failed (exit ${r.code}) ---\n${r.out}`);
  } else {
    console.log(`ok  ${r.label} (${r.seconds.toFixed(1)}s)`);
  }
}
if (failed) process.exit(1);

const tests = await run('vitest', ['exec', 'vitest', 'run'], { stream: true });
console.log(
  `\n${tests.code === 0 ? 'ok ' : 'FAILED'} vitest (${tests.seconds.toFixed(1)}s); check total ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
process.exit(tests.code);
