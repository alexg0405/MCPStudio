import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliCandidates } from '../platform/find-cli.ts';
import { currentHost, envWithout, type Host } from '../platform/host.ts';
import { chooseTurn, answerOf, readResult, type CliLookup } from './claude-turn.ts';
import { firstExecutable, run as runCli, type RunResult } from './cli.ts';
import {
  claudeAllowedTools,
  claudeMcpConfig,
  looksLikeLookupFailure,
  removeFile,
  writePrivateFile,
} from './lookup.ts';
import {
  AiServerError,
  type Backend,
  type BackendStatus,
  type BeatReply,
  type BeatRequest,
  type LookupAccess,
} from './types.ts';

/**
 * Claude through the musician's own Claude subscription: their installed Claude Code CLI, signed in
 * with their Claude account (`claude auth login`), runs one print-mode turn per request and resumes
 * its session for follow-ups. It counts toward their plan's usage like any other Claude Code use;
 * nothing is billed separately. Personal use only: it runs when they ask for a beat, never in the
 * background, and AGstudio never touches the CLI's credentials.
 *
 * Each turn: `--safe-mode` (no CLAUDE.md, hooks, plugins, MCP servers or memory; unlike `--bare` it
 * still uses the subscription login), no built-in tools, `dontAsk` permissions, the beat's JSON schema as a
 * structured output, and API credentials removed from the environment so the subscription is used.
 * The only tools a turn can have are AGstudio's own read tools (lookup.ts), through a temp MCP config of that turn.
 * How the prompt and the schema reach the CLI (command line or stdin) is in claude-turn.ts.
 */

const WINDOWS_INSTALL = 'in PowerShell: irm https://claude.ai/install.ps1 | iex';
const UNIX_INSTALL = 'in Terminal: curl -fsSL https://claude.ai/install.sh | bash';
const OVERRIDE_NOTE = 'If it is installed somewhere unusual, set AGSTUDIO_CLAUDE_BIN to its full path in .env.local.';

/** What to tell the musician when Claude Code isn't installed (or can't be found). */
export function installHint(platform: NodeJS.Platform = process.platform): string {
  const how = platform === 'win32' ? WINDOWS_INSTALL : UNIX_INSTALL;
  const terminal = platform === 'win32' ? 'PowerShell or Command Prompt' : 'Terminal';
  return `Install Claude Code (${how}), then run \`claude auth login\` in ${terminal} and sign in with your Claude account. ${OVERRIDE_NOTE}`;
}
export const INSTALL_HINT = installHint();
const SIGN_IN_HINT =
  'Claude Code is not signed in: run `claude auth login` in a terminal and sign in with your Claude account.';

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

function childEnv(host: Host): NodeJS.ProcessEnv {
  return envWithout(host, DROP_ENV);
}

const findClaude = (host: Host, override: string | undefined) => firstExecutable(cliCandidates('claude', host, override));

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

/**
 * The Claude subscription backend. `host` is the computer it runs on (the tests pass a different one to check the
 * Windows paths and the long-prompt transport).
 */
export function subscriptionBackend(override: () => string | undefined, host: Host = currentHost()): Backend {
  let cached: { at: number; status: BackendStatus; bin: string | null } | null = null;
  const workDir = join(tmpdir(), 'agstudio-claude');
  const run = (bin: string, args: string[], opts: { input?: string; cwd: string; signal?: AbortSignal; timeoutMs?: number }) =>
    runCli(bin, args, { ...opts, env: childEnv(host), host });

  async function check(): Promise<{ status: BackendStatus; bin: string | null }> {
    if (cached && Date.now() - cached.at < 15_000) return cached;
    await mkdir(workDir, { recursive: true });
    const bin = await findClaude(host, override());
    let status: BackendStatus = { ok: false, reason: installHint(host.platform) };
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

  /** One turn of Claude Code, with the read tools of `lookup` or none. */
  async function turn(req: BeatRequest, bin: string, signal: AbortSignal, lookup: CliLookup | undefined): Promise<BeatReply> {
    const command = chooseTurn(req, bin, host, undefined, lookup);
    let r: RunResult;
    try {
      r = await run(bin, command.args, { input: command.input, cwd: workDir, signal });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      throw new AiServerError(`Claude Code didn't run: ${e instanceof Error ? e.message : e}`, 'api_error', 502);
    }
    const result = readResult(r.stdout, command.transport);
    if (!result) {
      cached = null; // look again next time (signed out, updated, …)
      throw failure((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' '));
    }
    if (result.is_error || r.code !== 0) {
      cached = null;
      throw failure((result.errors?.join('; ') || result.result || `exit ${r.code}`).trim());
    }
    const beat = answerOf(result, command.transport);
    if (beat === undefined)
      throw new AiServerError("Claude's answer wasn't a beat in the required format.", 'bad_output', 502);
    return { session: result.session_id ?? req.session ?? '', beat, model: req.model };
  }

  return {
    async status() {
      return (await check()).status;
    },

    async beat(req: BeatRequest, signal: AbortSignal, access?: LookupAccess): Promise<BeatReply> {
      const { status, bin } = await check();
      if (!status.ok || !bin) throw new AiServerError(status.reason ?? installHint(host.platform), 'not_configured', 503);
      if (!req.readTools || !access) return turn(req, bin, signal, undefined);
      const config = join(workDir, `mcp-${randomUUID()}.json`);
      await writePrivateFile(config, claudeMcpConfig(access));
      try {
        const lookup: CliLookup = { mcpConfigPath: config, allowedTools: claudeAllowedTools(access) };
        return await turn(req, bin, signal, lookup);
      } catch (e) {
        // A look-up setup the CLI does not accept must not take the chat down: ask again without read tools (the model
        // then looks things up with a query action).
        if (e instanceof AiServerError && looksLikeLookupFailure(e.message)) return turn(req, bin, signal, undefined);
        throw e;
      } finally {
        await removeFile(config);
      }
    },
  };
}
