/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { cliCandidates, onPath, pathFolders } from '../../tools/platform/find-cli.ts';
import { envValue, envWithout, type Host } from '../../tools/platform/host.ts';
import { fitsCommandLine, planSpawn, quoteForCmd, shimTarget } from '../../tools/platform/spawn-plan.ts';

/** Finding the Claude Code and Codex commands and starting them, checked for Windows, macOS and Linux with an injected host. */

const windows = (env: Record<string, string> = {}): Host => ({
  platform: 'win32',
  env: {
    PATH: 'C:\\Windows\\System32;"C:\\Program Files\\nodejs";C:\\Users\\ana\\AppData\\Roaming\\npm',
    APPDATA: 'C:\\Users\\ana\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    ...env,
  },
  homeDir: 'C:\\Users\\ana',
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
});

const mac: Host = { platform: 'darwin', env: { PATH: '/usr/bin:/opt/tools/bin' }, homeDir: '/Users/ana', nodePath: '/usr/local/bin/node' };
const linux: Host = { platform: 'linux', env: { PATH: '/usr/bin' }, homeDir: '/home/ana', nodePath: '/usr/bin/node' };

describe('the PATH', () => {
  it('splits on semicolons on Windows (dropping quotes) and colons elsewhere', () => {
    expect(pathFolders(windows())).toEqual([
      'C:\\Windows\\System32',
      'C:\\Program Files\\nodejs',
      'C:\\Users\\ana\\AppData\\Roaming\\npm',
    ]);
    expect(pathFolders(mac)).toEqual(['/usr/bin', '/opt/tools/bin']);
  });

  it('is found under any capitalization of its name on Windows', () => {
    const host = windows();
    delete host.env.PATH;
    host.env.Path = 'C:\\tools';
    expect(pathFolders(host)).toEqual(['C:\\tools']);
    expect(envValue(host, 'path')).toBe('C:\\tools');
    expect(envValue({ platform: 'linux', env: { Path: 'x' } }, 'PATH')).toBeUndefined();
  });

  it('lists a command with every extension Windows runs, and plain elsewhere', () => {
    expect(onPath('claude', windows({ PATH: 'C:\\bin' }))).toEqual([
      'C:\\bin\\claude.exe',
      'C:\\bin\\claude.cmd',
      'C:\\bin\\claude.bat',
      'C:\\bin\\claude.com',
    ]);
    expect(onPath('claude', mac)).toEqual(['/usr/bin/claude', '/opt/tools/bin/claude']);
  });
});

describe('where Claude Code and Codex are looked for', () => {
  it('Windows: an override, the native installer folder, the PATH, then npm, pnpm, WinGet and Scoop', () => {
    const found = cliCandidates('claude', windows(), 'D:\\tools\\claude');
    expect(found.slice(0, 5)).toEqual([
      'D:\\tools\\claude',
      'D:\\tools\\claude.exe',
      'D:\\tools\\claude.cmd',
      'D:\\tools\\claude.bat',
      'D:\\tools\\claude.com',
    ]);
    expect(found).toContain('C:\\Users\\ana\\.local\\bin\\claude.exe');
    expect(found).toContain('C:\\Users\\ana\\AppData\\Roaming\\npm\\claude.cmd');
    expect(found).toContain('C:\\Users\\ana\\AppData\\Local\\pnpm\\claude.cmd');
    expect(found).toContain('C:\\Users\\ana\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe');
    expect(found).toContain('C:\\Users\\ana\\scoop\\shims\\claude.exe');
    // The native installer's folder is tried before the PATH, like on the other systems.
    expect(found.indexOf('C:\\Users\\ana\\.local\\bin\\claude.exe')).toBeLessThan(
      found.indexOf('C:\\Program Files\\nodejs\\claude.exe'),
    );
  });

  it('Windows: an override that already has an extension is used as given', () => {
    expect(cliCandidates('codex', windows(), 'D:\\codex\\codex.exe')[0]).toBe('D:\\codex\\codex.exe');
    expect(cliCandidates('codex', windows(), 'D:\\codex\\codex.exe')).not.toContain('D:\\codex\\codex.exe.exe');
  });

  it('Windows: uses the usual AppData folders when the variables are missing', () => {
    const host = windows();
    delete host.env.APPDATA;
    delete host.env.LOCALAPPDATA;
    expect(cliCandidates('codex', host)).toContain('C:\\Users\\ana\\AppData\\Roaming\\npm\\codex.cmd');
  });

  it('Windows: never lists a bare name with no extension (CreateProcess cannot start npm\u2019s shell shim)', () => {
    for (const path of cliCandidates('codex', windows())) expect(path).toMatch(/\.(exe|cmd|bat|com)$/);
  });

  it('macOS keeps its old order for Claude Code', () => {
    expect(cliCandidates('claude', mac, '/x/claude')).toEqual([
      '/x/claude',
      '/Users/ana/.local/bin/claude',
      '/usr/bin/claude',
      '/opt/tools/bin/claude',
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      '/Users/ana/.npm-global/bin/claude',
    ]);
  });

  it('macOS and Linux look inside the ChatGPT app for Codex; Windows does not guess', () => {
    expect(cliCandidates('codex', mac)).toContain('/Applications/ChatGPT.app/Contents/Resources/codex');
    expect(cliCandidates('codex', linux)).toContain('/home/ana/.local/bin/codex');
    expect(cliCandidates('codex', windows()).some((p) => p.includes('ChatGPT'))).toBe(false);
  });
});

describe('the environment handed to a command', () => {
  it('drops the named variables, ignoring capitalization on Windows only', () => {
    const env = { OPENAI_API_KEY: 'a', openai_base_url: 'b', KEEP: 'c' };
    expect(envWithout({ platform: 'win32', env }, ['OPENAI_API_KEY', 'OPENAI_BASE_URL'])).toEqual({ KEEP: 'c' });
    expect(envWithout({ platform: 'linux', env }, ['OPENAI_API_KEY', 'OPENAI_BASE_URL'])).toEqual({
      openai_base_url: 'b',
      KEEP: 'c',
    });
  });
});

/** What `npm i -g @openai/codex` writes as codex.cmd (cmd-shim 7), shortened. */
const NPM_SHIM_SCRIPT = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n');

/** A shim for a package whose command is a program (Claude Code's npm package ships claude.exe). */
const NPM_EXE_SHIM = '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';

describe('starting a command', () => {
  const shimPath = 'C:\\Users\\ana\\AppData\\Roaming\\npm\\codex.cmd';

  it('runs macOS and Linux commands directly', () => {
    expect(planSpawn('/usr/bin/claude', ['-p', 'a b'], mac)).toEqual({
      command: '/usr/bin/claude',
      args: ['-p', 'a b'],
      windowsVerbatimArguments: false,
      throughCmd: false,
    });
  });

  it('runs a Windows .exe directly, with no shell', () => {
    const plan = planSpawn('C:\\Users\\ana\\.local\\bin\\claude.exe', ['auth', 'status'], windows());
    expect(plan).toMatchObject({ command: 'C:\\Users\\ana\\.local\\bin\\claude.exe', args: ['auth', 'status'], throughCmd: false });
  });

  it('reads the target of an npm .cmd shim and runs a script with this server\u2019s own Node', () => {
    const plan = planSpawn(shimPath, ['exec', '--json'], windows(), () => NPM_SHIM_SCRIPT);
    expect(plan).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\Users\\ana\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', 'exec', '--json'],
      windowsVerbatimArguments: false,
      throughCmd: false,
    });
  });

  it('reads the target of a shim that starts a program', () => {
    const plan = planSpawn('C:\\Users\\ana\\AppData\\Roaming\\npm\\claude.cmd', ['-p'], windows(), () => NPM_EXE_SHIM);
    expect(plan.command).toBe(
      'C:\\Users\\ana\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
    );
    expect(plan.throughCmd).toBe(false);
  });

  it('does not take node.exe for the target', () => {
    expect(shimTarget('SET "_prog=%dp0%\\node.exe"', shimPath, windows())).toBeNull();
    expect(shimTarget('"%~dp0\\node.exe" "%~dp0\\run.mjs" %*', shimPath, windows())).toBe(
      'C:\\Users\\ana\\AppData\\Roaming\\npm\\run.mjs',
    );
  });

  it('sends any other batch file through cmd.exe with every argument quoted', () => {
    const plan = planSpawn('C:\\tools\\my tool.cmd', ['-p', 'say "hi" & more', ''], windows(), () => '@echo off\r\nfoo\r\n');
    expect(plan.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(plan.throughCmd).toBe(true);
    expect(plan.windowsVerbatimArguments).toBe(true);
    expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    const line = plan.args[3] as string;
    expect(line.startsWith('"') && line.endsWith('"')).toBe(true);
    // The ampersand and the quotes are escaped, so cmd cannot start a second command from the text.
    expect(line).not.toMatch(/[^^]&/);
    expect(line).toContain('C:\\tools\\my^ tool.cmd');
  });

  it('falls back to cmd.exe when the shim cannot be read', () => {
    expect(planSpawn(shimPath, [], windows(), () => null).throughCmd).toBe(true);
  });

  it('quotes an argument for cmd: wrapped, with quotes and trailing backslashes handled, metacharacters caret-escaped', () => {
    expect(quoteForCmd('plain', { forBatchFile: false })).toBe('^"plain^"');
    expect(quoteForCmd('a b', { forBatchFile: false })).toBe('^"a^ b^"');
    expect(quoteForCmd('x\\', { forBatchFile: false })).toBe('^"x\\\\^"');
    expect(quoteForCmd('a"b', { forBatchFile: false })).toBe('^"a\\^"b^"');
    expect(quoteForCmd('50%', { forBatchFile: false })).toBe('^"50^%^"');
    expect(quoteForCmd('a&b', { forBatchFile: true })).toBe('^^^"a^^^&b^^^"');
  });

  it('knows how long a command line may be on each system', () => {
    const long = (n: number) => 'x'.repeat(n);
    const direct = (args: string[]) => ({ command: 'claude', args, throughCmd: false });
    expect(fitsCommandLine(direct([long(20_000)]), windows())).toBe(true);
    expect(fitsCommandLine(direct([long(40_000)]), windows())).toBe(false);
    expect(fitsCommandLine({ ...direct([long(9_000)]), throughCmd: true }, windows())).toBe(false);
    expect(fitsCommandLine(direct([long(90_000), long(90_000)]), mac)).toBe(true);
    expect(fitsCommandLine(direct([long(110_000)]), linux)).toBe(false);
    expect(fitsCommandLine(direct(Array.from({ length: 6 }, () => long(90_000))), mac)).toBe(false);
  });
});
