import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LookupAccess } from './types.ts';

/**
 * In-turn look-ups: while the AI answers a request it can call AGstudio's read tools (get_plugin_details, get_mixer,
 * get_pattern_notes…) instead of guessing, through the MCP server of this dev server. The answer still comes back as the
 * structured output and is applied by the page, so nothing here changes the project: the endpoint offers the read tools only.
 *
 * The access is read-only twice over: the endpoint (`/mcp?scope=lookup`, tools/mcp/lookup-scope.ts) does not list or run
 * anything else, and each backend names the read tools it allows. The access token is never written anywhere by this
 * code: the helper program (bin/agstudio-mcp.mjs) reads it from its file for every request.
 *
 * This file holds what the backends share: the server's name, the helper's environment, and the two config formats (a JSON
 * file for Claude Code, `-c` overrides for Codex).
 */

/** The name the MCP server goes by in the CLI's configuration (and in Claude Code's tool names). */
export const LOOKUP_SERVER = 'agstudio';

/** The query of the read-only endpoint. */
export const LOOKUP_SCOPE = 'lookup';

/** Seconds a CLI waits for the helper to start, and for one tool call (the page answers reads in milliseconds). */
const STARTUP_TIMEOUT_SEC = 20;
const TOOL_TIMEOUT_SEC = 60;

/** The environment of the helper program: where to forward, and which file holds the token (never the token itself). */
export function lookupEnv(access: LookupAccess): Record<string, string> {
  return { AGSTUDIO_MCP_URL: access.url, AGSTUDIO_MCP_TOKEN_FILE: access.tokenFile };
}

/** Claude Code names an MCP server's tool `mcp__<server>__<tool>`. */
export const claudeToolName = (tool: string): string => `mcp__${LOOKUP_SERVER}__${tool}`;

/** The names to pass to `--allowedTools`: each read tool by its full name, never the whole server. */
export const claudeAllowedTools = (access: LookupAccess): string[] => access.tools.map(claudeToolName);

/** The `--mcp-config` file's content: one stdio server, the helper program with its environment. */
export function claudeMcpConfig(access: LookupAccess): string {
  const server = { type: 'stdio', command: access.command, args: access.args, env: lookupEnv(access) };
  return JSON.stringify({ mcpServers: { [LOOKUP_SERVER]: server } }, null, 2);
}

/** Writes a private file (the folder is the musician's temp folder): the config of one turn, deleted after it. */
export async function writePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600 });
}

export const removeFile = (path: string): Promise<void> => rm(path, { force: true }).catch(() => {});

/** The TOML text of a string, for a `-c key=value` of Codex (the value is parsed as TOML; JSON strings are valid TOML ones). */
const toml = (text: string): string => JSON.stringify(text);

/**
 * The `-c` overrides that give Codex the same read-only server: the helper program, its environment, only the read
 * tools enabled, and those approved without asking (a turn runs without anyone to ask; every other tool of the server is
 * off, and the endpoint offers nothing else). They work next to `--ignore-user-config`.
 */
export function codexMcpOverrides(access: LookupAccess): string[] {
  const prefix = `mcp_servers.${LOOKUP_SERVER}`;
  const env = Object.entries(lookupEnv(access))
    .map(([key, value]) => `${key}=${toml(value)}`)
    .join(', ');
  const settings = [
    `${prefix}.command=${toml(access.command)}`,
    `${prefix}.args=[${access.args.map(toml).join(', ')}]`,
    `${prefix}.env={${env}}`,
    `${prefix}.enabled_tools=[${access.tools.map(toml).join(', ')}]`,
    `${prefix}.default_tools_approval_mode="approve"`,
    `${prefix}.startup_timeout_sec=${STARTUP_TIMEOUT_SEC}`,
    `${prefix}.tool_timeout_sec=${TOOL_TIMEOUT_SEC}`,
  ];
  return settings.flatMap((setting) => ['-c', setting]);
}

/**
 * Whether a failed turn's message points at the look-up setup (the MCP config, the server, an allowed-tools name), so the
 * turn is worth asking once more without it: a broken look-up must never take the whole chat down with it.
 */
export function looksLikeLookupFailure(message: string): boolean {
  return /\bmcp\b|mcp_servers|--mcp-config|--allowedTools|enabled_tools|approval_mode|--strict-mcp-config/i.test(message);
}
