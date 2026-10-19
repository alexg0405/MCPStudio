// One command to start AGstudio, on macOS, Linux and Windows: `agstudio` (bin/agstudio, bin/agstudio.cmd).
//   agstudio          the dev server on port 5390 (or $PORT): hot reload, your plugins, MCP, the plugin builder, the AI studio.
//                     Opens it in the browser, or just opens it when it is already running. Ctrl+C stops the server.
//   agstudio --app    the production build, served on port 5391 (or $APP_PORT): what the installed app is made of. Builds
//                     it when it is missing or older than the code, then opens the installed app (Chrome's or Edge's
//                     "Install AGstudio…"), or the browser tab when it is not installed yet. The AI studio works from
//                     it; the plugin builder and MCP need the dev server (plain `agstudio`).
//
// The bin/ files only find Node and run this one; everything else is here so it behaves the same everywhere.
// Node built-ins only: it runs before `npm ci` has installed anything.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installedAppPath,
  isBuildStale,
  isSafeForCmd,
  npmCliPath,
  openCommand,
  parseArguments,
  pathWithNode,
  portFor,
} from './lib/launcher.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const viteCli = join(repo, 'node_modules', 'vite', 'bin', 'vite.js');

/** How long to wait for the server to answer, and how often to ask, before giving up on opening the browser. */
const SERVER_WAIT_MS = 60_000;
const POLL_EVERY_MS = 500;

const usage = `Usage: agstudio [--app]
  (none)   start the dev server (port 5390, or $PORT) and open it in the browser
  --app    serve the production build (port 5391, or $APP_PORT) and open the installed AGstudio app
           (install it first: open the page, then Help > Install AGstudio as an app)`;

const parsed = parseArguments(process.argv.slice(2));
if ('error' in parsed) {
  console.error(`agstudio: unknown option '${parsed.error}'\n${usage}`);
  process.exit(2);
}
if (parsed.mode === 'help') {
  console.log(usage);
  process.exit(0);
}

const mode = parsed.mode;
const port = portFor(mode, process.env);
const url = `http://localhost:${port}`;

// Programs started from here (Vite and what it runs) use the same Node as this script.
process.env.PATH = pathWithNode(process.execPath, process.env);

/** True when something already answers at the address (any HTTP answer counts, a refused connection does not). */
async function isAnswering() {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

/** Starts a program that outlives this one's attention (the browser); a missing program is not an error. */
function openWithSystem(target) {
  // AGSTUDIO_NO_OPEN=1: a server, a test or a script that wants the program started without a window popping up.
  if (process.env.AGSTUDIO_NO_OPEN) {
    console.log(`Open ${target} in Chrome or Edge.`);
    return;
  }
  const { command, args } = openCommand(process.platform, target);
  if (process.platform === 'win32' && !isSafeForCmd(target)) {
    console.log(`Open ${target} yourself (its name has characters the Windows shell cannot take).`);
    return;
  }
  const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', () => console.log(`Open ${target} in Chrome or Edge.`));
  child.unref();
}

function openBrowser() {
  openWithSystem(url);
}

/** The installed app opens in its own window. Not installed (or not findable): the browser tab, with the way to install. */
function openInstalledApp() {
  const installed = installedAppPath({
    platform: process.platform,
    env: process.env,
    homeDir: homedir(),
    exists: existsSync,
  });
  if (installed) {
    console.log('Opening the installed AGstudio app.');
    openWithSystem(installed);
    return;
  }
  openBrowser();
  console.log(
    "To install it as an app: Help > Install AGstudio as an app (or the install icon in Chrome's or Edge's address bar).",
  );
  console.log(`The app belongs to ${url}: keep using port ${port} for it.`);
}

const openTarget = () => (mode === 'app' ? openInstalledApp() : openBrowser());

/** Runs a Node script in the repo and resolves with its exit code (output goes to this terminal). */
function runNodeScript(script, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: repo, env, stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** `npm ci` (the first run). npm's own script is run with this Node, so no shell and no `npm.cmd` is involved. */
async function installDependencies() {
  console.log('First run: installing dependencies…');
  const cli = npmCliPath({
    platform: process.platform,
    execPath: process.execPath,
    env: process.env,
    exists: existsSync,
  });
  if (cli) return runNodeScript(cli, ['ci']);
  // npm's script was not found next to Node: ask the PATH for `npm` (on Windows a .cmd file, which needs the shell).
  return new Promise((resolve) => {
    const child = spawn('npm', ['ci'], { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Calls `onAnswer` once the server answers; gives up after a minute (the server's own messages say why). */
async function whenServerAnswers(onAnswer, isStillStarting) {
  const startedAt = Date.now();
  while (isStillStarting() && Date.now() - startedAt < SERVER_WAIT_MS) {
    if (await isAnswering()) return onAnswer();
    await new Promise((resolve) => setTimeout(resolve, POLL_EVERY_MS));
  }
  if (isStillStarting()) console.log("AGstudio didn't start within a minute; see the messages above.");
}

async function main() {
  if (await isAnswering()) {
    console.log(`AGstudio is already running at ${url}`);
    openTarget();
    return 0;
  }

  if (!existsSync(join(repo, 'node_modules'))) {
    const code = await installDependencies();
    if (code !== 0) return code;
  }

  if (mode === 'app' && isBuildStale(repo)) {
    console.log('Building the app…');
    const code = await runNodeScript(viteCli, ['build']);
    if (code !== 0) return code;
  }

  const env = { ...process.env };
  const serverArgs = mode === 'app' ? ['preview'] : [];
  if (mode === 'app') env.APP_PORT = port;
  else env.PORT = port;
  console.log(
    mode === 'app'
      ? `Serving the AGstudio app at ${url} (Ctrl+C to stop)…`
      : `Starting AGstudio at ${url} (Ctrl+C to stop)…`,
  );

  const server = spawn(process.execPath, [viteCli, ...serverArgs], { cwd: repo, env, stdio: 'inherit' });
  let isRunning = true;
  // Ctrl+C reaches the server directly (same terminal); this script just waits for it to finish.
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => server.kill('SIGTERM'));
  void whenServerAnswers(openTarget, () => isRunning);
  return new Promise((resolve) => {
    server.on('error', (error) => {
      isRunning = false;
      console.error(`agstudio: could not start the server: ${error.message}`);
      resolve(1);
    });
    server.on('close', (code, signal) => {
      isRunning = false;
      resolve(code ?? (signal ? 0 : 1));
    });
  });
}

process.exitCode = await main();
