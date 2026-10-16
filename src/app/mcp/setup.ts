/**
 * The setup lines Settings shows for connecting an AI app, as plain strings to copy. `origin` is where
 * AGstudio runs ("http://localhost:5390"); `root` is the AGstudio folder (for the stdio helper).
 */

export const endpointOf = (origin: string): string => `${origin.replace(/\/+$/, '')}/mcp`;

/** "agmcp_Ab12…" (enough to recognize it, not enough to use it). */
export const maskToken = (token: string): string => (token.length > 12 ? `${token.slice(0, 10)}…` : token);

/** Claude Code: one command, run in any terminal. */
export function claudeCodeCommand(origin: string, token: string): string {
  return `claude mcp add --transport http agstudio ${endpointOf(origin)} --header "Authorization: Bearer ${token}"`;
}

/**
 * Claude Desktop starts MCP servers as programs (its config file has no URL servers; remote ones go
 * through Settings → Connectors, and those must be reachable from the internet), so it runs the stdio
 * helper, which reads the token from the AGstudio folder itself: no secret in the config.
 */
export function claudeDesktopConfig(origin: string, root: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        agstudio: {
          command: `${root.replace(/\/+$/, '')}/bin/agstudio-mcp`,
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
