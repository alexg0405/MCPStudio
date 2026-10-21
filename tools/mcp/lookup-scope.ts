import { STUDIO_LOOKUP_CLIENT, type ClientInfo } from '../../src/app/mcp/types.ts';
import { UnknownToolError, type McpBackend } from './protocol.ts';

/**
 * The read-only face of the MCP server, for Studio's own AI backends (`POST /mcp?scope=lookup`, tools/ai/lookup.ts). It
 * offers and runs the read tools in `allowed` and nothing else: a call to any other tool (apply_actions, run_command, play,
 * export…) is "no such tool", whatever the caller asked for. A caller can only narrow its own access this way; the access
 * token is the same as for the full endpoint.
 *
 * Its calls are Studio reading its own project, not an app the musician connected: they run as the client
 * `STUDIO_LOOKUP_CLIENT`, which the page answers without a toast and the settings do not list.
 */

/** The query that asks for this scope. */
export const LOOKUP_SCOPE_QUERY = 'lookup';

const INSTRUCTIONS =
  'These are the read tools of the AGstudio project that is open: look at it before answering. They only read; to change anything, answer in the required format.';

const STUDIO_CLIENT: ClientInfo = { name: STUDIO_LOOKUP_CLIENT };

/** `backend` limited to the tools `allowed` names (read fresh on every request: the list follows the app's code). */
export function lookupScope(backend: McpBackend, allowed: () => Promise<readonly string[]>): McpBackend {
  return {
    async tools() {
      const names = new Set(await allowed());
      return (await backend.tools()).filter((tool) => names.has(tool.name));
    },
    resources: async () => [],
    instructions: async () => INSTRUCTIONS,
    async call(name, args) {
      if (!(await allowed()).includes(name)) throw new UnknownToolError(name);
      return backend.call(name, args, STUDIO_CLIENT);
    },
  };
}
