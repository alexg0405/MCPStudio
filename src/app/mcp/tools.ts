/**
 * What AI apps can do over MCP, running in the page (the dev server relays each call here, see
 * `bridge.ts`). Every project change goes through the same applier as the Studio chat
 * (`assistant.applyExternal`), so it is one undo step, shown in the chat with an Undo button.
 * Pure enough to unit test with `createTestServices`.
 *
 * The tools live in `edit-tools.ts` (apply_actions and commands), `transport-tools.ts`, `history-tools.ts`,
 * `read-tools.ts` and `audio-tools.ts`; this file puts them in one table and runs calls.
 */
import type { Services } from '../services';
import { audioTools, defaultAudioDeps } from './audio-tools';
import { fail, type Args, type ToolContext, type ToolFn } from './common';
import { editTools } from './edit-tools';
import { HISTORY_TOOLS } from './history-tools';
import { READ_TOOLS } from './read-tools';
import type { ToolDeps } from './tool-deps';
import { TRANSPORT_TOOLS } from './transport-tools';
import type { ToolResult } from './types';

export type { ToolDeps } from './tool-deps';

/** The tools one page can run: their names and a way to call one. */
export interface McpTools {
  /** Tool names this runtime can run. */
  names(): string[];
  call(name: string, args: Args, ctx?: ToolContext): Promise<ToolResult>;
}

/**
 * Edits run one at a time, in the order they arrive: this makes a wrapper that holds a second call until the first
 * is done. A failed edit does not block the ones behind it.
 */
function inArrivalOrder(): (tool: ToolFn) => ToolFn {
  let queue: Promise<unknown> = Promise.resolve();
  return (tool) => (s, args, ctx) => {
    const run = queue.then(() => tool(s, args, ctx));
    queue = run.catch(() => undefined);
    return run;
  };
}

/** The MCP tools for one page: reads, edits, transport, history and the audio tools, by their MCP names. */
export function createMcpTools(s: Services, deps: ToolDeps = {}): McpTools {
  const serial = inArrivalOrder();
  const edit = editTools(deps);
  const table: Record<string, ToolFn> = {
    ...READ_TOOLS,
    apply_actions: serial(edit.apply_actions),
    list_commands: edit.list_commands,
    run_command: serial(edit.run_command),
    ...TRANSPORT_TOOLS,
    undo: serial(HISTORY_TOOLS.undo),
    redo: serial(HISTORY_TOOLS.redo),
    history: HISTORY_TOOLS.history,
    ...audioTools(deps.audio ?? defaultAudioDeps()),
  };

  return {
    names: () => Object.keys(table),
    async call(name, args, ctx = {}) {
      const tool = table[name];
      if (!tool) return fail(`This AGstudio has no tool "${name}".`);
      try {
        return await tool(s, args, ctx);
      } catch (e) {
        console.error(`[agstudio] MCP tool ${name} failed`, e);
        return fail(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}
