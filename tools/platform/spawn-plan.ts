import { readFileSync } from 'node:fs';
import { pathsOf, envValue, type Host } from './host.ts';

/**
 * How to start a command line tool from Node on any system.
 *
 * macOS and Linux run the file directly. Windows has two kinds of commands: real programs (`.exe`), which are started
 * directly, and batch files (`.cmd`, `.bat`), which only `cmd.exe` can run. Since Node 18.20 and 20.12 a batch file
 * cannot be started without a shell (it fails with EINVAL, a protection against command injection), and a shell
 * would re-read every argument as cmd syntax. So a batch file is handled in two steps:
 *   1. `npm i -g` writes its `.cmd` files as thin shims around a `.js` or `.exe`; when the shim is that kind, the real
 *      target is started directly (a `.js` through this server's own Node), with no shell at all;
 *   2. any other batch file goes through `cmd.exe /d /s /c` with every argument quoted for cmd (see `quoteForCmd`).
 */

/** What to pass to `child_process.spawn`. */
export interface SpawnPlan {
  command: string;
  args: string[];
  /** True when the arguments are already quoted for cmd.exe and Node must not quote them again. */
  windowsVerbatimArguments: boolean;
  /** True when `cmd.exe` runs the command (its command line may be at most 8 191 characters). */
  throughCmd: boolean;
}

const isBatchFile = (path: string) => /\.(cmd|bat)$/i.test(path);

/** Reads a small text file, or null when that fails. */
export type ReadText = (path: string) => string | null;

const readTextFile: ReadText = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/**
 * The program an npm `.cmd` shim starts, from the text of the shim: the last quoted path under the shim's own
 * folder (`%dp0%` or `%~dp0`) that is not `node.exe`, if it is a script or a program. Null for any other batch file.
 */
export function shimTarget(shimText: string, shimPath: string, host: Host): string | null {
  const paths = pathsOf(host);
  const found = [...shimText.matchAll(/"%(?:~dp0|dp0%)[\\/]?([^"%]+)"/gi)]
    .map((match) => match[1] as string)
    .filter((relative) => !/^node(\.exe)?$/i.test(relative));
  const last = found.at(-1);
  if (!last || !/\.(js|mjs|cjs|exe)$/i.test(last)) return null;
  return paths.join(paths.dirname(shimPath), last);
}

/**
 * Quotes one argument for a command line run by `cmd.exe /d /s /c` (the rules of qntm.org/cmd, the same ones the
 * `cross-spawn` package follows): backslashes before a quote are doubled, the whole argument is wrapped in quotes, and
 * every character cmd treats specially is escaped with a caret. A batch file reads its arguments through cmd a second
 * time, so for those the carets are doubled.
 */
export function quoteForCmd(argument: string, options: { forBatchFile: boolean }): string {
  const metaCharacters = /([()\][%!^"`<>&|;, *?])/g;
  let quoted = argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  quoted = `"${quoted}"`;
  quoted = quoted.replace(metaCharacters, '^$1');
  return options.forBatchFile ? quoted.replace(metaCharacters, '^$1') : quoted;
}

/** Quotes the command itself (its path may contain spaces or parentheses, as in `C:\Program Files (x86)\…`). */
function quoteCommandForCmd(command: string): string {
  return command.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1');
}

/** Windows batch files need the two steps above; everything else is started directly. */
export function planSpawn(command: string, args: string[], host: Host, readText: ReadText = readTextFile): SpawnPlan {
  const direct: SpawnPlan = { command, args, windowsVerbatimArguments: false, throughCmd: false };
  if (host.platform !== 'win32' || !isBatchFile(command)) return direct;

  const shim = readText(command);
  const target = shim === null ? null : shimTarget(shim, command, host);
  if (target) {
    return /\.exe$/i.test(target)
      ? { ...direct, command: target }
      : { ...direct, command: host.nodePath, args: [target, ...args] };
  }

  const forBatchFile = true;
  const line = [quoteCommandForCmd(command), ...args.map((a) => quoteForCmd(a, { forBatchFile }))].join(' ');
  return {
    command: envValue(host, 'ComSpec') || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
    throughCmd: true,
  };
}

/** Windows stops a command line at 32 767 characters, and cmd.exe at 8 191; each limit here leaves room for the environment and quoting. */
const WINDOWS_LIMIT_CHARS = 30_000;
const CMD_LIMIT_CHARS = 7_000;
/** Linux refuses a single argument over 131 072 bytes; macOS and Linux refuse all arguments together over about a million (the environment counts too). */
const UNIX_ARGUMENT_LIMIT_BYTES = 100_000;
const UNIX_TOTAL_LIMIT_BYTES = 500_000;

/** True when this command can safely be started with these arguments on this system (a longer one risks E2BIG or a failed start). */
export function fitsCommandLine(
  plan: Pick<SpawnPlan, 'command' | 'args' | 'throughCmd'>,
  host: Pick<Host, 'platform'>,
): boolean {
  const parts = [plan.command, ...plan.args];
  if (host.platform === 'win32') {
    // Windows counts UTF-16 characters of the one command line string, with two quotes and a space per argument.
    const length = parts.reduce((sum, part) => sum + part.length + 3, 0);
    return length <= (plan.throughCmd ? CMD_LIMIT_CHARS : WINDOWS_LIMIT_CHARS);
  }
  const sizes = parts.map((part) => Buffer.byteLength(part, 'utf8') + 1);
  return Math.max(...sizes) <= UNIX_ARGUMENT_LIMIT_BYTES && sizes.reduce((a, b) => a + b, 0) <= UNIX_TOTAL_LIMIT_BYTES;
}
