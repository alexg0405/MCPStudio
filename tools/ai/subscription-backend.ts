import { spawn } from 'node:child_process';
import { access, constants, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { AiServerError, type Backend, type BackendStatus, type BeatReply, type BeatRequest } from './types.ts';

/**
 * Claude through the musician's own Claude subscription: their installed Claude Code CLI, signed in
 * with their Claude account (`claude auth login`), runs one print-mode turn per request and resumes
 * its session for follow-ups. It counts toward their plan's usage like any other Claude Code use;
 * nothing is billed separately. Personal use only: it runs when they ask for a beat, never in the
 * background, and AGstudio never touches the CLI's credentials.
 *
 * Each turn: `--safe-mode` (no CLAUDE.md, hooks, plugins, MCP servers or memory; unlike `--bare` it
 * still uses the subscription login), no tools, `dontAsk` permissions, the beat's JSON schema as a
 * structured output, and API credentials removed from the environment so the subscription is used.
 */

const TIMEOUT_MS = 240_000;
export const INSTALL_HINT =
  'Install Claude Code (in Terminal: curl -fsSL https://claude.ai/install.sh | bash), then run `claude auth login` and sign in with your Claude account.';
const SIGN_IN_HINT =
  'Claude Code is not signed in: run `claude auth login` in Terminal and sign in with your Claude account.';

/** Variables that outrank the subscription login (or send requests elsewhere). */
const DROP_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of DROP_ENV) delete env[k];
  return env;
}

/** Where Claude Code's installers put the `claude` command (the dev server's PATH may lack it). */
function candidates(override: string | undefined): string[] {
  const home = homedir();
  const onPath = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((d) => join(d, 'claude'));
  return [
    ...(override ? [override] : []),
    join(home, '.local', 'bin', 'claude'),
    ...onPath,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(home, '.npm-global', 'bin', 'claude'),
  ];
}

async function findClaude(override: string | undefined): Promise<string | null> {
  for (const path of candidates(override)) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      /* not here */
    }
  }
  return null;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  bin: string,
  args: string[],
  opts: { input?: string; cwd: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
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
    child.stdin.end(opts.input ?? '');
  });
}

/** The fields of `--output-format json`'s result object this backend reads. */
interface CliResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  session_id?: string;
  structured_output?: unknown;
}

/** The CLI flags for one turn (the only part tied to Claude Code's version). The request goes on stdin. */
export function cliArgs(req: BeatRequest): string[] {
  const args = [
    '-p',
    'Write the beat described below. Answer only with the beat in the required JSON format.',
    '--safe-mode',
    '--tools',
    '',
    '--permission-mode',
    'dontAsk',
    '--output-format',
    'json',
    '--model',
    req.model,
    '--effort',
    'medium',
    '--system-prompt',
    req.system,
    '--json-schema',
    JSON.stringify(req.schema),
    '--max-turns',
    '3',
  ];
  if (req.session) args.push('--resume', req.session);
  return args;
}

/** Maps a failed run to a message for the musician. */
function failure(text: string): AiServerError {
  if (/log ?in|sign ?in|not (authenticated|logged)|credential|oauth|expired/i.test(text))
    return new AiServerError(SIGN_IN_HINT, 'not_signed_in', 503);
  if (/usage limit|rate limit|limit (reached|exceeded)|out of (usage|credits)/i.test(text))
    return new AiServerError(
      `Your Claude plan's usage limit is reached for now. ${text}`.trim(),
      'rate_limit_error',
      429,
    );
  if (/overloaded/i.test(text))
    return new AiServerError('Claude is overloaded right now; try again shortly.', 'overloaded_error', 529);
  return new AiServerError(text || 'Claude Code reported an error.', 'api_error', 502);
}

/** Login methods that use the musician's Claude plan (an API key would bill the API instead). */
const SUBSCRIPTION_LOGINS = new Set(['claude.ai', 'oauth_token']);

export function subscriptionBackend(override: () => string | undefined): Backend {
  let cached: { at: number; status: BackendStatus; bin: string | null } | null = null;
  const workDir = join(tmpdir(), 'agstudio-claude');

  async function check(): Promise<{ status: BackendStatus; bin: string | null }> {
    if (cached && Date.now() - cached.at < 15_000) return cached;
    await mkdir(workDir, { recursive: true });
    const bin = await findClaude(override());
    let status: BackendStatus = { ok: false, reason: INSTALL_HINT };
    if (bin) {
      try {
        // Exit 0 = signed in; the JSON says how.
        const r = await run(bin, ['auth', 'status'], { cwd: workDir, timeoutMs: 20_000 });
        let method = '';
        try {
          method = String((JSON.parse(r.stdout) as { authMethod?: unknown }).authMethod ?? '');
        } catch {
          /* older CLI: no JSON */
        }
        if (r.code !== 0 || method === 'none') status = { ok: false, reason: SIGN_IN_HINT };
        else if (method && !SUBSCRIPTION_LOGINS.has(method))
          status = {
            ok: false,
            reason: `Claude Code is signed in with ${method === 'api_key' || method === 'api_key_helper' ? 'an API key' : `"${method}"`}, not your Claude subscription: run \`claude auth login\` in Terminal.`,
          };
        else status = { ok: true };
      } catch (e) {
        status = { ok: false, reason: `Claude Code didn't start: ${e instanceof Error ? e.message : e}` };
      }
    }
    cached = { at: Date.now(), status, bin };
    return cached;
  }

  return {
    async status() {
      return (await check()).status;
    },

    async beat(req: BeatRequest, signal: AbortSignal): Promise<BeatReply> {
      const { status, bin } = await check();
      if (!status.ok || !bin) throw new AiServerError(status.reason ?? INSTALL_HINT, 'not_configured', 503);
      let r: RunResult;
      try {
        r = await run(bin, cliArgs(req), { input: req.text, cwd: workDir, signal });
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') throw e;
        throw new AiServerError(`Claude Code didn't run: ${e instanceof Error ? e.message : e}`, 'api_error', 502);
      }
      let result: CliResult;
      try {
        result = JSON.parse(r.stdout) as CliResult;
      } catch {
        cached = null; // look again next time (signed out, updated, …)
        throw failure((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' '));
      }
      if (result.is_error || r.code !== 0) {
        cached = null;
        throw failure((result.errors?.join('; ') || result.result || `exit ${r.code}`).trim());
      }
      if (result.structured_output === undefined)
        throw new AiServerError("Claude's answer wasn't a beat in the required format.", 'bad_output', 502);
      return { session: result.session_id ?? req.session ?? '', beat: result.structured_output, model: req.model };
    },
  };
}
