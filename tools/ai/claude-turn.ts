import { fitsCommandLine, planSpawn, type ReadText } from '../platform/spawn-plan.ts';
import type { Host } from '../platform/host.ts';
import type { BeatRequest } from './types.ts';

/**
 * One turn of Claude Code, in the two ways the request can reach it.
 *
 * `argv` (the way it has always been done on macOS and Linux): the system prompt and the answer schema are
 * command-line arguments, the musician's request is on stdin, and the CLI prints one JSON result.
 *
 * `stdin` (for a command line that would be too long): the system prompt (up to 60 000 characters) and the schema
 * (about 76 KB) travel inside the CLI's own stream-json input, in the `initialize` message the Claude Agent SDK
 * sends, so nothing big is an argument. Windows stops a command line at 32 767 characters (8 191 through cmd.exe), so
 * a Windows turn always takes this way; other systems take it only when the arguments would pass a safe size.
 */

/** The instruction both transports add to the musician's request. */
const TASK_LINE = 'Do what the request below asks. Answer only in the required JSON format.';

/** The fields of Claude Code's result object (`--output-format json`, or the last line of stream-json) this backend reads. */
export interface CliResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  session_id?: string;
  structured_output?: unknown;
}

/** The flags both transports share: no tools, no customizations, a medium effort, at most three turns. */
function commonFlags(req: BeatRequest): string[] {
  return [
    '--safe-mode',
    '--tools',
    '',
    '--permission-mode',
    'dontAsk',
    '--model',
    req.model,
    '--effort',
    'medium',
    '--max-turns',
    '3',
  ];
}

/** The CLI flags of the argv transport (the only part tied to Claude Code's version). The request goes on stdin. */
export function cliArgs(req: BeatRequest): string[] {
  const args = [
    '-p',
    TASK_LINE,
    ...commonFlags(req),
    '--output-format',
    'json',
    '--system-prompt',
    req.system,
    '--json-schema',
    JSON.stringify(req.schema),
  ];
  if (req.session) args.push('--resume', req.session);
  return args;
}

/** The CLI flags of the stdin transport: short, whatever the prompt and the schema weigh. */
export function streamArgs(req: BeatRequest): string[] {
  const args = [
    '-p',
    ...commonFlags(req),
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    // stream-json output needs --verbose.
    '--verbose',
  ];
  if (req.session) args.push('--resume', req.session);
  return args;
}

/**
 * What goes on stdin in the stdin transport: the `initialize` control request (system prompt and schema, as the Agent
 * SDK sends them), then the musician's request as the one user message. One JSON object per line.
 */
export function streamInput(req: BeatRequest): string {
  const initialize = {
    type: 'control_request',
    request_id: 'agstudio-init',
    request: { subtype: 'initialize', systemPrompt: [req.system], jsonSchema: req.schema },
  };
  const userMessage = {
    type: 'user',
    message: { role: 'user', content: `${TASK_LINE}\n\n${req.text}` },
    parent_tool_use_id: null,
    session_id: '',
  };
  return `${JSON.stringify(initialize)}\n${JSON.stringify(userMessage)}\n`;
}

/** How a turn is started: the command-line arguments and what to write to the CLI's stdin. */
export interface TurnCommand {
  transport: 'argv' | 'stdin';
  args: string[];
  input: string;
}

/** Picks the transport: the plain one when its command line is safely short on this system, else the stdin one. */
export function chooseTurn(req: BeatRequest, bin: string, host: Host, readText?: ReadText): TurnCommand {
  const argvArgs = cliArgs(req);
  const plan = planSpawn(bin, argvArgs, host, readText);
  if (fitsCommandLine(plan, host)) return { transport: 'argv', args: argvArgs, input: req.text };
  return { transport: 'stdin', args: streamArgs(req), input: streamInput(req) };
}

/** The result object of a finished turn, or null when the output has none (signed out, crashed, updated…). */
export function readResult(stdout: string, transport: TurnCommand['transport']): CliResult | null {
  if (transport === 'argv') {
    try {
      return JSON.parse(stdout) as CliResult;
    } catch {
      return null;
    }
  }
  // stream-json: one object per line; the `result` line comes last.
  const lines = stdout.split('\n').reverse();
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const message = JSON.parse(line) as CliResult;
      if (message.type === 'result') return message;
    } catch {
      /* a partial line */
    }
  }
  return null;
}

/**
 * The answer of a successful turn. The structured output when the CLI delivered one; in the stdin transport also the
 * answer's text, when that is a JSON object (a schema the CLI did not apply still leaves the model answering in JSON).
 */
export function answerOf(result: CliResult, transport: TurnCommand['transport']): unknown {
  if (result.structured_output !== undefined) return result.structured_output;
  if (transport !== 'stdin' || typeof result.result !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(result.result.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
