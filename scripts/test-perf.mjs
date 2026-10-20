// `npm run test:perf`: only the tests tagged `perf` (speed, CPU cost, memory assertions), with their real limits
// (VITE_PERF_STRICT=1). Run it on a quiet machine. The Node tests run first, then the browser ones, each one file at a
// time (the `unit-timing` and `audio-realtime` projects, as in `npm run check`).
// This is a script (not `VITE_PERF_STRICT=1 vitest …` in package.json) because that syntax only works in a Unix shell;
// Windows' cmd.exe and PowerShell do not understand it. Extra arguments (a file to run, `-t name`) go to both runs; a run
// that finds nothing to do for them passes.
import { spawn } from 'node:child_process';
import { binPath, repoRoot } from './lib/tools.mjs';

/** Runs Vitest with `args` and resolves with its exit code. */
function runVitest(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [binPath('vitest'), ...args], {
      cwd: repoRoot,
      env: { ...process.env, VITE_PERF_STRICT: '1' },
      stdio: 'inherit',
    });
    child.on('error', (error) => {
      console.error(`test:perf: could not start vitest: ${error.message}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

const extra = process.argv.slice(2);
let exitCode = 0;
for (const project of ['unit-timing', 'audio-realtime']) {
  const code = await runVitest(['run', '--project', project, '--tags-filter', 'perf', '--passWithNoTests', ...extra]);
  if (code !== 0) exitCode = code;
}
process.exitCode = exitCode;
