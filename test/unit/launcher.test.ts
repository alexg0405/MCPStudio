/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installedAppPath,
  isBuildStale,
  isSafeForCmd,
  npmCliPath,
  openCommand,
  parseArguments,
  pathWithNode,
  portFor,
} from '../../scripts/lib/launcher.mjs';

/** The `agstudio` launcher's system-dependent parts, with the platform passed in. */

describe('reading the command line', () => {
  it('starts the dev server by default and the production build with --app', () => {
    expect(parseArguments([])).toEqual({ mode: 'dev' });
    expect(parseArguments(['--app'])).toEqual({ mode: 'app' });
    expect(parseArguments(['app'])).toEqual({ mode: 'app' });
    expect(parseArguments(['--help'])).toEqual({ mode: 'help' });
    expect(parseArguments(['-h'])).toEqual({ mode: 'help' });
  });

  it('names the option it does not know', () => {
    expect(parseArguments(['--app', '--nope'])).toEqual({ error: '--nope' });
  });

  it('serves on 5390 and 5391, or on the port the environment names', () => {
    expect(portFor('dev', {})).toBe('5390');
    expect(portFor('app', {})).toBe('5391');
    expect(portFor('dev', { PORT: '5405', APP_PORT: '5500' })).toBe('5405');
    expect(portFor('app', { PORT: '5405', APP_PORT: '5500' })).toBe('5500');
  });
});

describe('opening the browser', () => {
  const url = 'http://localhost:5390';

  it('uses open on macOS, cmd /c start on Windows and xdg-open on Linux', () => {
    expect(openCommand('darwin', url)).toEqual({ command: 'open', args: [url] });
    expect(openCommand('win32', url)).toEqual({ command: 'cmd.exe', args: ['/c', 'start', '', url] });
    expect(openCommand('linux', url)).toEqual({ command: 'xdg-open', args: [url] });
  });

  it('keeps cmd from reading a shortcut path as more than one command', () => {
    expect(isSafeForCmd('C:\\Users\\Ana Smith\\AppData\\Roaming\\Start Menu\\AGstudio.lnk')).toBe(true);
    expect(isSafeForCmd('http://localhost:5390')).toBe(true);
    expect(isSafeForCmd('C:\\Users\\a&b\\AGstudio.lnk')).toBe(false);
    expect(isSafeForCmd('C:\\100%\\AGstudio.lnk')).toBe(false);
  });
});

describe('finding the installed app', () => {
  const home = 'C:\\Users\\ana';
  const startMenu = 'C:\\Users\\ana\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs';

  it('macOS: the bundle Chrome writes under ~/Applications', () => {
    const bundle = '/Users/ana/Applications/Chrome Apps.localized/AGstudio.app';
    const find = (present: string[]) =>
      installedAppPath({ platform: 'darwin', env: {}, homeDir: '/Users/ana', exists: (p) => present.includes(p) });
    expect(find([bundle])).toBe(bundle);
    expect(find([])).toBeNull();
  });

  it('Windows: the Start menu shortcut of Chrome or Edge, under %APPDATA%', () => {
    const find = (present: string[], env: Record<string, string> = { APPDATA: 'C:\\Users\\ana\\AppData\\Roaming' }) =>
      installedAppPath({ platform: 'win32', env, homeDir: home, exists: (p) => present.includes(p) });
    expect(find([`${startMenu}\\Chrome Apps\\AGstudio.lnk`])).toBe(`${startMenu}\\Chrome Apps\\AGstudio.lnk`);
    expect(find([`${startMenu}\\AGstudio.lnk`])).toBe(`${startMenu}\\AGstudio.lnk`);
    expect(find([`${startMenu}\\Edge Apps\\AGstudio.lnk`])).toBe(`${startMenu}\\Edge Apps\\AGstudio.lnk`);
    expect(find([`${startMenu}\\AGstudio.lnk`], {})).toBe(`${startMenu}\\AGstudio.lnk`); // %APPDATA% unset: the usual folder
    expect(find([])).toBeNull();
  });

  it('Linux: none, so the browser tab opens', () => {
    expect(installedAppPath({ platform: 'linux', env: {}, homeDir: '/home/ana', exists: () => true })).toBeNull();
  });
});

describe('npm without a shell', () => {
  const found = (platform: string, execPath: string, present: string[], env: Record<string, string> = {}) =>
    npmCliPath({ platform, execPath, env, exists: (p) => present.includes(p) });

  it('Windows: npm-cli.js beside node.exe', () => {
    const cli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
    expect(found('win32', 'C:\\Program Files\\nodejs\\node.exe', [cli])).toBe(cli);
  });

  it('macOS and Linux: npm-cli.js under ../lib of the Node folder', () => {
    const cli = '/Users/ana/.local/node/lib/node_modules/npm/bin/npm-cli.js';
    expect(found('darwin', '/Users/ana/.local/node/bin/node', [cli])).toBe(cli);
  });

  it('prefers the script npm itself reports, and gives null when there is none', () => {
    const own = '/opt/npm/bin/npm-cli.js';
    expect(found('linux', '/usr/bin/node', [own], { npm_execpath: own })).toBe(own);
    expect(found('linux', '/usr/bin/node', [])).toBeNull();
  });

  it('puts the running Node first on the PATH', () => {
    expect(pathWithNode('/usr/local/bin/node', { PATH: '/usr/bin' }).startsWith('/usr/local/bin')).toBe(true);
    expect(pathWithNode('/usr/local/bin/node', { PATH: '/usr/bin' }).endsWith('/usr/bin')).toBe(true);
  });
});

describe('knowing when the production build is out of date', () => {
  let repo = '';
  const touch = async (path: string, secondsAgo: number) => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'x');
    const when = new Date(Date.now() - secondsAgo * 1000);
    await utimes(path, when, when);
  };
  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ag-launcher-'));
  });
  afterAll(() => rm(repo, { recursive: true, force: true }));

  it('is stale with no build, fresh when nothing changed since, stale after an edit anywhere in src', async () => {
    expect(isBuildStale(repo)).toBe(true);
    await touch(join(repo, 'src', 'ui', 'a.ts'), 100);
    await touch(join(repo, 'package.json'), 100);
    await touch(join(repo, 'dist', 'sw.js'), 50);
    expect(isBuildStale(repo)).toBe(false);
    await touch(join(repo, 'src', 'ui', 'deep', 'b.ts'), 5);
    expect(isBuildStale(repo)).toBe(true);
  });
});

describe('the launcher files', () => {
  const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

  it('the shell wrappers and the Windows ones all run the Node scripts', async () => {
    expect(await read('bin/agstudio')).toContain('scripts/agstudio.mjs');
    expect(await read('bin/agstudio.cmd')).toContain('scripts\\agstudio.mjs');
    expect(await read('bin/agstudio-mcp')).toContain('agstudio-mcp.mjs');
    expect(await read('bin/agstudio-mcp.cmd')).toContain('agstudio-mcp.mjs');
  });

  it('the macOS and Linux wrappers are executable', async () => {
    if (process.platform === 'win32') return;
    for (const name of ['agstudio', 'agstudio-mcp']) {
      const { mode } = await stat(new URL(`../../bin/${name}`, import.meta.url));
      expect(mode & 0o111, name).not.toBe(0);
    }
  });

  it('the Windows batch files are written to be checked out with CRLF line endings', async () => {
    const attributes = await read('.gitattributes');
    expect(attributes).toMatch(/^\* text=auto eol=lf$/m);
    expect(attributes).toMatch(/^\*\.cmd text eol=crlf$/m);
  });
});
