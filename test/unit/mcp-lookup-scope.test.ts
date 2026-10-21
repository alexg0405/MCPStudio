/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { LOOKUP_TOOL_NAMES, TOOL_DEFS } from '@app/mcp/defs';
import { STUDIO_LOOKUP_CLIENT, type ToolDef } from '../../src/app/mcp/types.ts';
import { lookupScope } from '../../tools/mcp/lookup-scope.ts';
import { createMcpProtocol, UnknownToolError, type HttpIn, type McpBackend } from '../../tools/mcp/protocol.ts';

/**
 * The read-only face of the MCP server (`POST /mcp?scope=lookup`): what Studio's own AI backends may call during a turn. It
 * lists and runs the read tools and nothing else, however the caller asks, and its calls are not "a connected app".
 */

const tool = (name: string, readOnly: boolean): ToolDef => ({
  name,
  title: name,
  description: `${name}.`,
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: readOnly },
});

function fullBackend() {
  const calls: { name: string; client: unknown }[] = [];
  const backend: McpBackend = {
    tools: async () => [tool('get_mixer', true), tool('apply_actions', false), tool('play', false), tool('get_plugins', true)],
    resources: async () => [{ uri: 'agstudio://project', name: 'p', title: 'p', description: 'd', mimeType: 'text/plain', tool: 'get_mixer' }],
    instructions: async () => 'everything',
    call: async (name, _args, client) => {
      calls.push({ name, client });
      return { content: [{ type: 'text', text: `ran ${name}` }] };
    },
    onClient: () => {
      throw new Error('a look-up is not a connected app');
    },
  };
  return { backend, calls };
}

const post = (method: string, params: Record<string, unknown> = {}): HttpIn => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
});

const INFO = { name: 'agstudio', title: 'AGstudio', version: '0.1.0' };
const ALLOWED = ['get_mixer', 'get_plugins'];

describe('lookupScope', () => {
  it('lists only the tools it allows', async () => {
    const { backend } = fullBackend();
    const scoped = lookupScope(backend, async () => ALLOWED);
    expect((await scoped.tools()).map((t) => t.name)).toEqual(['get_mixer', 'get_plugins']);
    expect(await scoped.resources()).toEqual([]);
  });

  it('runs an allowed tool as Studio itself, not as a connected app', async () => {
    const { backend, calls } = fullBackend();
    const scoped = lookupScope(backend, async () => ALLOWED);
    await scoped.call('get_mixer', {}, { name: 'something-else' });
    expect(calls).toEqual([{ name: 'get_mixer', client: { name: STUDIO_LOOKUP_CLIENT } }]);
  });

  it('refuses every other tool as if it did not exist, and never reaches the backend', async () => {
    const { backend, calls } = fullBackend();
    const scoped = lookupScope(backend, async () => ALLOWED);
    for (const name of ['apply_actions', 'play', 'run_command', 'not_a_tool'])
      await expect(scoped.call(name, {}, undefined), name).rejects.toBeInstanceOf(UnknownToolError);
    expect(calls).toEqual([]);
  });

  it('works over the protocol: tools/list shows the read tools, tools/call of a write tool is "no such tool"', async () => {
    const { backend } = fullBackend();
    const protocol = createMcpProtocol(lookupScope(backend, async () => ALLOWED), INFO);
    const list = await protocol.handle(post('tools/list'));
    const names = ((list.body as { result: { tools: ToolDef[] } }).result.tools).map((t) => t.name);
    expect(names).toEqual(['get_mixer', 'get_plugins']);
    const refused = await protocol.handle(post('tools/call', { name: 'apply_actions', arguments: { actions: [] } }));
    expect((refused.body as { error: { code: number } }).error.code).toBe(-32602);
    const allowed = await protocol.handle(post('tools/call', { name: 'get_plugins', arguments: {} }));
    expect((allowed.body as { result: { content: { text: string }[] } }).result.content[0]!.text).toBe('ran get_plugins');
  });
});

describe('the read tools Studio’s backends may call', () => {
  const byName = new Map(TOOL_DEFS.map((def) => [def.name, def]));

  it('are all declared read-only, and exist', () => {
    expect(LOOKUP_TOOL_NAMES.length).toBeGreaterThanOrEqual(20);
    for (const name of LOOKUP_TOOL_NAMES) {
      expect(byName.has(name), name).toBe(true);
      expect(byName.get(name)!.annotations?.readOnlyHint, name).toBe(true);
    }
  });

  it('include the catalog lookups and the reads of the project', () => {
    for (const name of [
      'get_plugin_details',
      'get_commands',
      'search_catalog',
      'get_plugins',
      'get_mixer',
      'get_channel',
      'get_pattern_notes',
      'get_clips',
      'get_chords',
      'get_lyrics',
      'get_automation',
      'get_transport',
      'get_selection',
    ])
      expect(LOOKUP_TOOL_NAMES, name).toContain(name);
  });

  it('leave out everything that changes the project, plays it or renders it, and the two big text dumps', () => {
    for (const name of [
      'apply_actions',
      'run_command',
      'play',
      'stop',
      'seek',
      'set_loop',
      'undo',
      'redo',
      'export_audio',
      'export_video',
      'render_preview',
      'analyze_mix',
      'get_guide',
      'list_plugins',
      'list_commands',
      'get_project',
    ])
      expect(LOOKUP_TOOL_NAMES, name).not.toContain(name);
  });

  it('weigh little as tool definitions (they ride along in every turn of the API backend)', () => {
    const size = TOOL_DEFS.filter((def) => LOOKUP_TOOL_NAMES.includes(def.name)).reduce(
      (total, def) => total + JSON.stringify({ name: def.name, description: def.description, input_schema: def.inputSchema }).length,
      0,
    );
    expect(size).toBeLessThan(30_000);
  });
});
