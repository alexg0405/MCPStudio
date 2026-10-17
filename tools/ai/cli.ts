import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

/** Shared by the CLI backends (Claude Code, Codex): find a command, run it once, collect what it printed. */

export const TIMEOUT_MS = 240_000;

/** The first of these paths that is an executable file, or null. */
export async function firstExecutable(paths: readonly string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      /* not here */
    }
  }
  return null;
}

/** `name` in every folder of the PATH the server runs with. */
export function onPath(name: string): string[] {
  return (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((d) => join(d, name));
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function run(
  bin: string,
  args: string[],
  opts: { input?: string; cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    // SIGINT ends the turn cleanly; SIGTERM if it doesn't go.
    const stop = () => {
      child.kill('SIGINT');
      setTimeout(() => child.kill('SIGTERM'), 5000).unref();
    };
    const timer = setTimeout(stop, opts.timeoutMs ?? TIMEOUT_MS);
    opts.signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', stop);
      if (opts.signal?.aborted) reject(new DOMException('Cancelled.', 'AbortError'));
      else resolve({ code, stdout, stderr });
    });
    // A command that exits before reading its input closes the pipe: not an error of ours.
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });
}
