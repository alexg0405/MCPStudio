import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstExecutable, onPath, run, type RunResult } from './cli.ts';
import { stripNulls, toStrictSchema } from './strict-schema.ts';
import { AiServerError, type Backend, type BackendStatus, type BeatReply, type BeatRequest } from './types.ts';

/**
 * ChatGPT through the musician's own ChatGPT plan: the Codex CLI (it ships inside the ChatGPT app, or
 * `npm i -g @openai/codex`), signed in with their ChatGPT account (`codex login`), runs one `codex exec`
 * turn per request and resumes its thread for follow-ups. It counts toward their plan's Codex usage; nothing
 * is billed separately. Personal use only: it runs when they ask, never in the background, and AGstudio never
 * reads the CLI's credentials (`codex login status` is the only question it asks).
 *
 * Each turn is a plain chat completion with a structured answer, not an agent run: the system prompt replaces
 * Codex's own instructions, every tool-like feature is switched off, the sandbox is read-only in an empty
 * folder with approvals off, and the answer is held to the schema (OpenAI's strict form, see strict-schema.ts).
 * The musician's request goes on stdin, the system prompt and the schema through temp files that are deleted
 * after the turn.
 */

const TIMEOUT_MS = 240_000;
const BASE_DIR = join(tmpdir(), 'agstudio-codex');

export const INSTALL_HINT =
  'Install the ChatGPT app (it includes Codex) or the Codex CLI (in Terminal: npm i -g @openai/codex), then run `codex login` and sign in with your ChatGPT account.';
const signInHint = (bin: string | null) =>
  `Codex is not signed in: run \`${bin?.startsWith('/Applications/') ? `${bin} login` : 'codex login'}\` in Terminal and sign in with your ChatGPT account.`;

/** Variables that would make Codex bill an API key (or send requests elsewhere) instead of using the ChatGPT login. */
const DROP_ENV = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY'];

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of DROP_ENV) delete env[k];
  return env;
}

/** Where the ChatGPT app and the CLI installers put `codex` (the dev server's PATH usually lacks it). */
function candidates(override: string | undefined): string[] {
  const home = homedir();
  return [
    ...(override ? [override] : []),
    ...onPath('codex'),
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    join(home, '.local', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    join(home, '.npm-global', 'bin', 'codex'),
  ];
}

/**
 * Features that give the model tools or side effects, off for our turns (`codex features list` shows which are
 * on by default; the ones listed here that this Codex knows are disabled, so a newer or older CLI never gets a
 * `--disable` for a feature it has never heard of). With the shell, browser, computer, apps, plugins, image and
 * sub-agent tools gone, the model can only answer.
 */
export const TOOL_FEATURES = [
  'apps', // connectors to other apps (ChatGPT's "apps")
  'browser_use', // drives a browser
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use', // drives the desktop
  'goals', // long-running goal tools
  'hooks', // user hook scripts around tool calls
  'image_generation', // image tool
  'in_app_browser',
  'multi_agent', // spawns sub-agents
  'plugins', // plugin-provided skills and tools
  'remote_plugin',
  'shell_tool', // runs commands
  'unified_exec',
  'unified_exec_tty',
  'view_image',
  'skill_search',
  'skill_mcp_dependency_install',
  'tool_suggest', // suggests installing connectors
  'sleep_tool',
  'code_mode_host',
  'workspace_dependencies',
  'shell_snapshot', // snapshots the user's shell at start-up: pure latency for a turn that never runs a command
];

/** The features `codex features list` says are on, from its table (`name  stage  true|false`). */
export function enabledFeatures(table: string): Set<string> {
  const on = new Set<string>();
  for (const line of table.split('\n')) {
    const m = /^(\S+)\s+.*\s(true|false)\s*$/.exec(line.trim());
    if (m && m[2] === 'true') on.add(m[1]!);
  }
  return on;
}

/** The TOML string for a `-c key=value` (the value is parsed as TOML). */
const toml = (s: string) => JSON.stringify(s);

/** Files of one turn (in a folder that is deleted afterwards). */
export interface TurnFiles {
  /** The system prompt, as Codex's instructions. */
  instructions: string;
  /** The answer schema (strict form). */
  schema: string;
  /** Where Codex writes its last message. */
  out: string;
}

/** A thread id is passed as a command line argument: keep it from looking like an option. */
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/**
 * The CLI arguments for one turn: the only part tied to Codex's version (checked against codex-cli 0.155). The
 * request goes on stdin (`-`). A fresh turn is `codex exec …`, a follow-up `codex exec resume <thread> …`.
 */
export function cliArgs(req: BeatRequest, files: TurnFiles, disable: readonly string[] = TOOL_FEATURES): string[] {
  const thread = req.session && THREAD_ID.test(req.session) ? req.session : null;
  const args = [
    'exec',
    ...(thread ? ['resume'] : []),
    // JSONL events on stdout: thread.started has the thread id, the rest is for errors and the fallback answer.
    '--json',
    // The working folder is an empty temp folder, not a git repository.
    '--skip-git-repo-check',
    // Do not read ~/.codex/config.toml (the musician's model, MCP servers, profiles, hooks…); login still comes from CODEX_HOME.
    '--ignore-user-config',
    // No user or project execpolicy .rules files.
    '--ignore-rules',
    // `exec resume` has no --sandbox flag, so the sandbox is a config value, the same on both paths.
    '-c',
    'sandbox_mode="read-only"',
    // Never stop to ask for approval (nothing is asked for: there are no tools).
    '-c',
    'approval_policy="never"',
    // The system prompt replaces Codex's own coding-agent instructions.
    '-c',
    `model_instructions_file=${toml(files.instructions)}`,
    // No AGENTS.md from the working folder or from CODEX_HOME.
    '-c',
    'project_doc_max_bytes=0',
    // No web search tool.
    '-c',
    'web_search="disabled"',
    // Medium effort keeps a turn to a few seconds of thinking: it is an interactive request.
    '-c',
    'model_reasoning_effort="medium"',
    // Every tool-like feature off (see TOOL_FEATURES).
    ...disable.flatMap((f) => ['--disable', f]),
    // The answer must follow this schema (strict structured output).
    '--output-schema',
    files.schema,
    // The last message (the answer) is written here as plain text.
    '-o',
    files.out,
    // Empty model: Codex's own default for the ChatGPT plan.
    ...(req.model ? ['-m', req.model] : []),
  ];
  // The thread to continue; --all because a thread belongs to the folder it began in and the id is enough.
  if (thread) args.push('--all', thread);
  // `-`: the request is read from stdin.
  args.push('-');
  return args;
}

/** What one turn's `--json` events told us. */
export interface TurnEvents {
  thread: string | null;
  /** The last agent message (the fallback when the -o file is empty). */
  message: string | null;
  /** Messages of `error` and `turn.failed` events. */
  errors: string[];
  failed: boolean;
}

/** Reads the JSONL events (lines that aren't JSON, such as warnings, are ignored). */
export function readEvents(stdout: string): TurnEvents {
  const r: TurnEvents = { thread: null, message: null, errors: [], failed: false };
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    let e: { type?: string; thread_id?: string; message?: string; error?: { message?: string }; item?: { type?: string; text?: string } };
    try {
      e = JSON.parse(text) as typeof e;
    } catch {
      continue;
    }
    if (e.type === 'thread.started' && typeof e.thread_id === 'string') r.thread = e.thread_id;
    else if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string')
      r.message = e.item.text;
    else if (e.type === 'turn.failed') {
      r.failed = true;
      if (e.error?.message) r.errors.push(e.error.message);
    } else if (e.type === 'error' && typeof e.message === 'string') r.errors.push(e.message);
  }
  return r;
}

/** Maps a failed run to a message for the musician. */
export function failure(text: string, model: string, bin: string | null): AiServerError {
  const t = text.trim();
  if (/usage limit|rate limit|limit (reached|exceeded)|out of (usage|credits)|too many requests|\b429\b|hit your/i.test(t))
    return new AiServerError(`Your ChatGPT plan's usage limit is reached for now. ${t}`.trim(), 'rate_limit_error', 429);
  if (/model.*(not (found|supported|available)|does not exist|unsupported)|unsupported model|not supported when using codex/i.test(t))
    return new AiServerError(
      `Codex can't use ${model ? `the model "${model}"` : 'its default model'} with your ChatGPT plan: ${t}`,
      'invalid_request_error',
      400,
    );
  if (/log ?in|sign ?in|not (authenticated|logged)|unauthorized|\b401\b|credential|oauth|token.*(expired|invalid|revoked)|expired/i.test(t))
    return new AiServerError(signInHint(bin), 'not_signed_in', 503);
  if (/overloaded|at capacity|\b503\b/i.test(t))
    return new AiServerError('ChatGPT is overloaded right now; try again shortly.', 'overloaded_error', 529);
  if (/(no|could not find|unable to find).*(session|thread|conversation)|(session|thread|conversation).*not found/i.test(t))
    return new AiServerError(
      'Codex no longer has this conversation (its saved thread is gone). Start a new chat in Studio and ask again.',
      'api_error',
      502,
    );
  return new AiServerError(t || 'Codex reported an error.', 'api_error', 502);
}

/** Turn folders older than this are left over from a crashed server: removed (best effort) on the next check. */
const STALE_MS = 3600_000;

async function sweepStale(): Promise<void> {
  for (const name of await readdir(BASE_DIR).catch(() => [] as string[])) {
    if (name === 'work') continue;
    const dir = join(BASE_DIR, name);
    const info = await stat(dir).catch(() => null);
    if (info && Date.now() - info.mtimeMs > STALE_MS) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function codexBackend(override: () => string | undefined): Backend {
  let cached: { at: number; status: BackendStatus; bin: string | null; disable: string[] } | null = null;
  const workDir = join(BASE_DIR, 'work');

  async function check(): Promise<{ status: BackendStatus; bin: string | null; disable: string[] }> {
    if (cached && Date.now() - cached.at < 15_000) return cached;
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    await sweepStale();
    const bin = await firstExecutable(candidates(override()));
    let status: BackendStatus = { ok: false, reason: INSTALL_HINT };
    let disable = [...TOOL_FEATURES];
    if (bin) {
      try {
        // Exit 0 = signed in, and the one line says how ("Logged in using ChatGPT" / "… an API key").
        const r = await run(bin, ['login', 'status'], { cwd: workDir, env: childEnv(), timeoutMs: 20_000 });
        const said = `${r.stdout}\n${r.stderr}`;
        if (r.code !== 0 || /not logged in|logged out/i.test(said)) status = { ok: false, reason: signInHint(bin) };
        else if (/chatgpt/i.test(said)) status = { ok: true };
        else
          status = {
            ok: false,
            reason: /api key/i.test(said)
              ? 'Codex is signed in with an API key, not your ChatGPT plan: run `codex login` in Terminal and choose "Sign in with ChatGPT".'
              : 'Codex is not signed in with your ChatGPT account: run `codex login` in Terminal and choose "Sign in with ChatGPT".',
          };
        if (status.ok) {
          const f = await run(bin, ['features', 'list'], { cwd: workDir, env: childEnv(), timeoutMs: 20_000 }).catch(() => null);
          const on = f && f.code === 0 ? enabledFeatures(f.stdout) : null;
          if (on && on.size > 0) disable = TOOL_FEATURES.filter((x) => on.has(x));
        }
      } catch (e) {
        status = { ok: false, reason: `Codex didn't start: ${e instanceof Error ? e.message : e}` };
      }
    }
    cached = { at: Date.now(), status, bin, disable };
    return cached;
  }

  return {
    async status() {
      return (await check()).status;
    },

    async beat(req: BeatRequest, signal: AbortSignal): Promise<BeatReply> {
      const { status, bin, disable } = await check();
      if (!status.ok || !bin) throw new AiServerError(status.reason ?? INSTALL_HINT, 'not_configured', 503);
      const turnDir = join(BASE_DIR, randomUUID());
      const files: TurnFiles = {
        instructions: join(turnDir, 'instructions.md'),
        schema: join(turnDir, 'schema.json'),
        out: join(turnDir, 'answer.txt'),
      };
      try {
        // The prompt carries the musician's project: only they can read it while the turn runs.
        await mkdir(turnDir, { recursive: true, mode: 0o700 });
        await Promise.all([
          writeFile(files.instructions, req.system, { mode: 0o600 }),
          writeFile(files.schema, JSON.stringify(toStrictSchema(req.schema)), { mode: 0o600 }),
        ]);
        let r: RunResult;
        try {
          r = await run(bin, cliArgs(req, files, disable), { input: req.text, cwd: workDir, env: childEnv(), signal, timeoutMs: TIMEOUT_MS });
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') throw e;
          throw new AiServerError(`Codex didn't run: ${e instanceof Error ? e.message : e}`, 'api_error', 502);
        }
        const events = readEvents(r.stdout);
        let answer = await readFile(files.out, 'utf8').catch(() => '');
        if (!answer.trim()) answer = events.message ?? '';
        if (r.code !== 0 || events.failed || !answer.trim()) {
          cached = null; // look again next time (signed out, updated, …)
          const said = events.errors.join('; ') || r.stderr.trim().split('\n').slice(-3).join(' ') || `exit ${r.code}`;
          throw r.code === 0 && !events.failed && !events.errors.length
            ? new AiServerError("ChatGPT's answer was empty.", 'bad_output', 502)
            : failure(said, req.model, bin);
        }
        let beat: unknown;
        try {
          beat = stripNulls(JSON.parse(answer));
        } catch {
          throw new AiServerError("ChatGPT's answer wasn't valid JSON in the required format.", 'bad_output', 502);
        }
        return { session: events.thread ?? req.session ?? '', beat, model: req.model };
      } finally {
        await rm(turnDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
