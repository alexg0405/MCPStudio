// `npm run test:perf`: only the tests tagged `perf` (speed assertions), with their real limits (VITE_PERF_STRICT=1).
// Run it on a quiet machine. This is a script (not `VITE_PERF_STRICT=1 vitest …` in package.json) because that syntax
// only works in a Unix shell; Windows' cmd.exe and PowerShell do not understand it. Extra arguments go to vitest.
import { spawn } from 'node:child_process';
import { binPath, repoRoot } from './lib/tools.mjs';

const vitestArguments = ['run', '--tags-filter', 'perf', ...process.argv.slice(2)];
const child = spawn(process.execPath, [binPath('vitest'), ...vitestArguments], {
  cwd: repoRoot,
  env: { ...process.env, VITE_PERF_STRICT: '1' },
  stdio: 'inherit',
});
child.on('error', (error) => {
  console.error(`test:perf: could not start vitest: ${error.message}`);
  process.exitCode = 1;
});
child.on('close', (code) => {
  process.exitCode = code ?? 1;
});
