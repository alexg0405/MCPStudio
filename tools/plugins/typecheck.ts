import { spawn } from 'node:child_process';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { withForwardSlashes } from './shared.ts';

/** How long the type check may run. */
const TSC_TIMEOUT_MS = 90_000;

/** Runs a program and collects its output; a timeout kills it, a failure to start gives code -1. */
function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    child.stderr.on('data', (b: Buffer) => (out += b.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: String(e) });
    });
  });
}

/** Type-checks the draft like the app does: main-thread files with the DOM, worklet files with the AudioWorklet scope. */
export async function typeCheck(root: string, dir: string): Promise<string[]> {
  const base = withForwardSlashes(relative(dir, join(root, 'tsconfig.base.json')));
  // `import dsp from './x.dsp'` in Faust plugins.
  const dspModules = withForwardSlashes(relative(dir, join(root, 'src', 'sdk', 'faust', 'modules.d.ts')));
  const configs = {
    '.check-main.json': {
      extends: base,
      compilerOptions: {
        lib: ['ES2023', 'DOM', 'DOM.Iterable'],
        types: ['vite/client'],
        jsx: 'react-jsx',
        noEmit: true,
      },
      include: ['./*.ts', './*.tsx', dspModules],
      exclude: ['./*.worklet.ts'],
    },
    '.check-worklet.json': {
      extends: base,
      compilerOptions: { lib: ['ES2023'], types: ['audioworklet'], noEmit: true },
      include: ['./*.worklet.ts'],
    },
  };
  // The compiler's own entry, on the Node that runs this server (the dev server's PATH may have no `node`).
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const problems: string[] = [];
  const hasWorklet = (await readdir(dir)).some((f) => f.endsWith('.worklet.ts'));
  for (const [name, config] of Object.entries(configs)) {
    if (name === '.check-worklet.json' && !hasWorklet) continue;
    const path = join(dir, name);
    await writeFile(path, JSON.stringify(config, null, 2));
    const { code, out } = await run(process.execPath, [tsc, '-p', path, '--pretty', 'false'], root, TSC_TIMEOUT_MS);
    await rm(path, { force: true });
    if (code === 0) continue;
    for (const line of out.split('\n')) {
      const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/.exec(line.trim());
      if (m) problems.push(`${relative(dir, join(root, m[1]!))}:${m[2]}:${m[3]} ${m[4]}: ${m[5]}`);
    }
    if (problems.length === 0)
      problems.push(`The type check failed: ${out.trim().slice(0, 400) || `exit code ${code}`}`);
  }
  return problems.slice(0, 25);
}
