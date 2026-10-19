import { spawn } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';
import { currentHost, type Host } from '../platform/host.ts';
import { planSpawn, type SpawnPlan } from '../platform/spawn-plan.ts';

/** Shared by the CLI backends (Claude Code, Codex): find a command, run it once, collect what it printed. */

export const TIMEOUT_MS = 240_000;

/** How long a command that was asked to stop (SIGINT) gets before it is stopped for good. */
const GRACE_MS = 5000;

/**
 * The first of these paths that is a file this system can run, or null. On Windows every existing file passes the
 * executable test, so the folders and `.exe`/`.cmd` names in the list do the choosing.
 */
export async function firstExecutable(paths: readonly string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      if (!(await stat(path)).isFile()) continue;
      await access(path, constants.X_OK);
      return path;
    } catch {
      /* not here */
    }
  }
  return null;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Stops the command, and on Windows everything it started (`cmd.exe` does not pass a stop on to its child). */
function stopCommand(child: ReturnType<typeof spawn>, plan: SpawnPlan, signal: 'SIGINT' | 'SIGTERM'): void {
  // Already finished (the grace timer fires after a clean stop): its process id may belong to something else by now.
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (plan.throughCmd && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    return;
  }
  child.kill(signal);
}

export function run(
  bin: string,
  args: string[],
  opts: { input?: string; cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number; host?: Host },
): Promise<RunResult> {
  const plan = planSpawn(bin, args, opts.host ?? currentHost());
  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });
    let stdout = '';
    let stderr = '';
    // SIGINT ends the turn cleanly; SIGTERM if it doesn't go. (Windows has no signals: both end the program.)
    const stop = () => {
      stopCommand(child, plan, 'SIGINT');
      setTimeout(() => stopCommand(child, plan, 'SIGTERM'), GRACE_MS).unref();
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
