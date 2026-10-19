/**
 * The setup lines Settings shows for connecting an AI app, as plain strings to copy. `origin` is where
 * AGstudio runs ("http://localhost:5390"); `root` is the AGstudio folder (for the stdio helper).
 */

/** The operating system of the computer AGstudio runs on (Node's `process.platform` values the setup lines care about). */
export type HostPlatform = 'win32' | 'darwin' | 'linux';

/** The system the dev server reported, or (before it answered) a guess from the browser: AGstudio runs on this computer. */
export function hostPlatformOf(reported: string, browserPlatform: string): HostPlatform {
  const name = reported || browserPlatform;
  if (/^win/i.test(name)) return 'win32';
  if (/^(darwin|mac|iphone|ipad)/i.test(name)) return 'darwin';
  return 'linux';
}

export const endpointOf = (origin: string): string => `${origin.replace(/\/+$/, '')}/mcp`;

/** "agmcp_Ab12…" (enough to recognize it, not enough to use it). */
export const maskToken = (token: string): string => (token.length > 12 ? `${token.slice(0, 10)}…` : token);

/**
 * Claude Code: one command, run in any terminal. The same text works in macOS and Linux shells, in PowerShell and in
 * cmd.exe: the one quoted argument uses double quotes only, and the token has only letters, digits, `-` and `_`.
 */
export function claudeCodeCommand(origin: string, token: string): string {
  return `claude mcp add --transport http agstudio ${endpointOf(origin)} --header "Authorization: Bearer ${token}"`;
}

/** Where Claude Desktop keeps its settings file (its own Settings → Developer → Edit Config opens the right one). */
export function claudeDesktopConfigPath(platform: HostPlatform): string {
  if (platform === 'win32') return '%APPDATA%\\Claude\\claude_desktop_config.json';
  if (platform === 'darwin') return '~/Library/Application Support/Claude/claude_desktop_config.json';
  return '~/.config/Claude/claude_desktop_config.json';
}

/** The stdio helper's launcher inside the AGstudio folder: a .cmd with backslashes on Windows, a script elsewhere. */
export function mcpLauncherPath(root: string, platform: HostPlatform): string {
  const folder = root.replace(/[\\/]+$/, '');
  if (platform === 'win32') return `${folder.replace(/\//g, '\\')}\\bin\\agstudio-mcp.cmd`;
  return `${folder}/bin/agstudio-mcp`;
}

/**
 * Claude Desktop starts MCP servers as programs (its config file has no URL servers; remote ones go
 * through Settings → Connectors, and those must be reachable from the internet), so it runs the stdio
 * helper, which reads the token from the AGstudio folder itself: no secret in the config.
 */
export function claudeDesktopConfig(origin: string, root: string, platform: HostPlatform): string {
  return JSON.stringify(
    {
      mcpServers: {
        agstudio: {
          command: mcpLauncherPath(root, platform),
          env: { AGSTUDIO_URL: origin.replace(/\/+$/, '') },
        },
      },
    },
    null,
    2,
  );
}

/** Apps that take a URL and headers (Cursor, VS Code, Claude Code's .mcp.json…). */
export function urlClientConfig(origin: string, token: string): string {
  return JSON.stringify(
    { mcpServers: { agstudio: { type: 'http', url: endpointOf(origin), headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );
}

/** "Connected: Claude Code · 3 calls in the last minute", or what to do when nothing is connected. */
export function statusLine(status: { clients: { name: string; lastSeen: number }[]; callsLastMinute: number; tabs: number }, label: (name: string) => string): string {
  if (status.clients.length === 0) return 'No AI app has connected yet. Paste one of the setup lines below into it.';
  const names = status.clients.map((c) => label(c.name)).join(', ');
  const n = status.callsLastMinute;
  return `Connected: ${names} · ${n === 0 ? 'no calls' : `${n} call${n === 1 ? '' : 's'}`} in the last minute`;
}
