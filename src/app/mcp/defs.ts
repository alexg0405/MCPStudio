/**
 * The tools, resources and instructions AGstudio offers AI apps over MCP. Plain data: the dev server
 * loads this file (tools/mcp/server.ts) to answer `tools/list` even before a tab is open, and the page
 * runs the tools (`tools.ts`). Each tool has a JSON Schema input and a description written for the AI.
 */
import { ACTIONS_SCHEMA } from '../ai/schema';
import { readTools } from '../ai/read';
import type { ResourceDef, ToolDef } from './types';

export const SERVER_INSTRUCTIONS = `AGstudio is a music studio (a DAW like FL Studio) running in the musician's browser. These tools read and change the open project, play it, and render it, exactly like the Studio chat inside the app does.

Start with get_guide (once per conversation: the rules for apply_actions and the music know-how), then get_project and list_plugins (every instrument and effect with its settings). Change things with apply_actions: batch related edits into one call, because every call is one undo step the musician sees in Studio's chat with an Undo button. Refer to things by the ids that get_project shows, or by exact names. After a change, check it with get_project, analyze_mix or render_preview. The musician is listening and watching: prefer small, reversible steps, say what you changed in "summary", and ask before big rewrites.`;

const bars = (what: string) => ({
  type: 'object',
  additionalProperties: false,
  description: `${what} Bars are 1-based and both ends are included ("from_bar 5, to_bar 8" is four bars).`,
  properties: {
    from_bar: { type: 'integer', minimum: 1, description: 'First bar.' },
    to_bar: { type: 'integer', minimum: 1, description: 'Last bar (included).' },
  },
  required: ['from_bar', 'to_bar'],
});

const none = { type: 'object', additionalProperties: false, properties: {} };
const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

const OWN_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: 'get_guide',
    title: 'How to control AGstudio',
    description:
      'The rules for apply_actions (how to refer to things, units, plugin settings), what each action does, and the beat, arrangement and mixing know-how Studio itself uses. Read it once before editing.',
    inputSchema: none,
    annotations: READ,
  },
  {
    name: 'get_project',
    title: 'Read the project',
    description:
      'The open project as text: the song (tempo, key), every channel with its instrument settings and mixer track, the mixer (levels, routes, effects with settings, sidechains), patterns and the notes of the current one, the playlist (the arrangement, with a song check for problems), what is selected, and what Undo would revert. Ids (ch_…, ins_…, fx_…, pat_…) are what apply_actions takes. With a focus, also the bars around that part: every track\'s clips there, the notes playing, the automation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        focus: bars('Also describe this part of the song in detail.'),
      },
    },
    annotations: READ,
  },
  {
    name: 'list_plugins',
    title: 'List instruments and effects',
    description:
      'Every instrument and effect plugin with its id, every setting (type, range, unit, default) and its presets. Needed to set plugin settings in apply_actions.',
    inputSchema: none,
    annotations: READ,
  },
  {
    name: 'apply_actions',
    title: 'Change the project',
    description:
      'Edit the project: the Studio action list (tempo and key, channels and instruments, mixer tracks, effects, routing, sidechains, patterns and notes, the playlist, automation, beats, mix leveling, sound filters, app commands…). All actions of one call are applied together as ONE undo step, labelled with your client name and the summary, and shown in Studio\'s chat with an Undo button. Actions that cannot apply are skipped with a warning; the rest still apply. Heavy follow-up work that some actions request (leveling the mix, sound filters) runs before the call returns; stop playback first, or it waits (up to 30 s) for the music to stop. With a focus, only that part of the song may change: edits reaching outside it are not applied until you call again with approve_outside true (the result lists what would change). Read get_guide first.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: {
          type: 'string',
          description:
            'One or two plain sentences for the musician: what you changed and why. Shown in Studio\'s chat and used as the undo label.',
        },
        actions: ACTIONS_SCHEMA.properties.actions,
        focus: bars('Limit the edit to this part of the song (everything else is kept).'),
        approve_outside: {
          type: 'boolean',
          description:
            'With a focus: also allow the edits that reach outside the part (the previous call listed them). Default false.',
        },
      },
      required: ['actions'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'list_commands',
    title: 'List app commands',
    description:
      'Everything the app can do like a menu item or a button: save, export, undo, windows, layouts, settings, markers, recording… Each has an id, a title, a hint and what argument it takes. Run one with run_command.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        search: { type: 'string', description: 'Only commands whose id, title or hint contain this text.' },
      },
    },
    annotations: READ,
  },
  {
    name: 'run_command',
    title: 'Run an app command',
    description:
      'Runs an app command from list_commands (like clicking its menu item). Commands that open a file dialog cannot run from here: the browser needs the musician\'s click, so AGstudio shows them a button ("Claude Code wants to export: click to choose where") and the result says it is waiting. To render audio to a file without a dialog use export_audio.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'The command id, e.g. "edit.undo" or "view.mixer".' },
        args: { description: 'The argument the command takes (see its "args" in list_commands), if any.' },
      },
      required: ['id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'transport_state',
    title: 'Playback state',
    description:
      'Whether the music is playing, the position (bar and tick), the tempo, the mode (song or pattern), the loop region, the current pattern, and whether the browser has unlocked sound (it needs one click in AGstudio first).',
    inputSchema: none,
    annotations: READ,
  },
  {
    name: 'play',
    title: 'Play',
    description:
      'Starts playback. Default: the song (the playlist) from the start. With "pattern" it loops that pattern in pattern mode. With from_bar it plays the song from there. With loop_from_bar and loop_to_bar it loops just those bars.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: { type: 'string', description: 'Loop this pattern (id, exact name or number) in pattern mode.' },
        from_bar: { type: 'integer', minimum: 1, description: 'Play the song from this bar.' },
        loop_from_bar: { type: 'integer', minimum: 1, description: 'Loop from this bar…' },
        loop_to_bar: { type: 'integer', minimum: 1, description: '…to this bar (included).' },
      },
    },
    annotations: WRITE,
  },
  {
    name: 'stop',
    title: 'Stop',
    description: 'Stops playback and returns to the start.',
    inputSchema: none,
    annotations: { ...WRITE, idempotentHint: true },
  },
  {
    name: 'seek',
    title: 'Move the playhead',
    description:
      'Sets where song playback starts (and where Stop returns). While playing, it jumps there and keeps playing.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { bar: { type: 'integer', minimum: 1, description: 'The bar to go to (1 = the start).' } },
      required: ['bar'],
    },
    annotations: { ...WRITE, idempotentHint: true },
  },
  {
    name: 'set_loop',
    title: 'Set the loop region',
    description: 'Sets the loop region of the song (the bars that repeat in song mode), or clears it.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from_bar: { type: 'integer', minimum: 1, description: 'First bar of the loop.' },
        to_bar: { type: 'integer', minimum: 1, description: 'Last bar of the loop (included).' },
        clear: { type: 'boolean', description: 'true removes the loop region (the whole song plays).' },
      },
    },
    annotations: { ...WRITE, idempotentHint: true },
  },
  {
    name: 'undo',
    title: 'Undo',
    description:
      'Undoes the last change (yours or the musician\'s). Pass steps to undo several. Redo brings them back. Use history to see what would be undone.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        steps: { type: 'integer', minimum: 1, maximum: 50, description: 'How many steps (default 1).' },
        to_point: {
          type: 'integer',
          minimum: 0,
          description:
            'Instead of steps: go back to this history point (the before_point that apply_actions returned, or a point from history; 0 = before every step).',
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: 'redo',
    title: 'Redo',
    description: 'Redoes what Undo reverted. Pass steps to redo several.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { steps: { type: 'integer', minimum: 1, maximum: 50, description: 'How many steps (default 1).' } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'history',
    title: 'Undo history',
    description: 'The recent changes, oldest first, then what Redo would bring back. Each has a label and a point you can go back to with undo.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many recent steps (default 20).' } },
    },
    annotations: READ,
  },
  {
    name: 'analyze_mix',
    title: 'Listen to the mix',
    description:
      'Renders the mix (and every mixer track) offline, measures it and reports in words and numbers: loudness (LUFS), peaks, balance between tracks, frequency bands, stereo width, and what is worth fixing. It listens to the loop region, else the start of the song (at most 30 s); pass bars to listen to a part. Takes a few seconds.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { bars: bars('Listen to just this part of the song.') },
    },
    annotations: READ,
  },
  {
    name: 'render_preview',
    title: 'Render a short preview',
    description:
      'Renders part of the song offline to a short WAV and returns it as audio (32 kHz, 16-bit stereo, at most 30 s). Default: the loop region, else the start of the song. Use it to let the musician or an audio-capable client hear a change without opening the app.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bars: bars('The part of the song to render.'),
        max_seconds: { type: 'number', minimum: 1, maximum: 30, description: 'Cap on the length (default 15).' },
      },
    },
    annotations: READ,
  },
  {
    name: 'export_audio',
    title: 'Export audio to a file',
    description:
      'Renders the song (or some bars) to an audio file in the AGstudio folder inside the Music folder (no file dialog needed) and returns its path. Defaults to the last export settings (usually WAV 24-bit).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bars: bars('Export just this part of the song (default: the whole song).'),
        format: { type: 'string', enum: ['wav', 'flac', 'mp3'], description: 'File format (default: the last one used).' },
        stems: { type: 'boolean', description: 'One file per mixer track, all the same length (into a sub-folder). Default false.' },
        normalize: { type: 'boolean', description: 'Raise the level so the loudest moment peaks at −0.3 dBFS.' },
        file_name: { type: 'string', description: 'Name without extension (default: the project name).' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

/** The MCP name of a read tool: the Studio chat's `get_project` (a JSON overview) can't take the name of the full text. */
export const mcpReadName = (name: string): string => (name === 'get_project' ? 'get_project_summary' : name);

/** Every read tool the Studio chat has (`ai/read.ts`), as an MCP tool with the same arguments. */
const READ_TOOL_DEFS: readonly ToolDef[] = readTools.map((t) => ({
  name: mcpReadName(t.name),
  title: `Read: ${t.name.replace(/^get_/, '').replace(/_/g, ' ')}`,
  description:
    t.name === 'get_project'
      ? `${t.description} This is a compact JSON overview; get_project has the full text the Studio chat reads.`
      : t.description,
  inputSchema: t.schema,
  annotations: READ,
}));

/** get_guide, get_project, list_plugins, then the read tools, then everything that changes or plays something. */
export const TOOL_DEFS: readonly ToolDef[] = [...OWN_TOOL_DEFS.slice(0, 3), ...READ_TOOL_DEFS, ...OWN_TOOL_DEFS.slice(3)];

export const RESOURCE_DEFS: readonly ResourceDef[] = [
  {
    uri: 'agstudio://project',
    name: 'project',
    title: 'The open project',
    description: 'A text summary of the open project: song, channels, mixer, patterns and playlist.',
    mimeType: 'text/plain',
    tool: 'get_project',
  },
  {
    uri: 'agstudio://commands',
    name: 'commands',
    title: 'App commands',
    description: 'Every command the app can run (menu items, buttons) with ids and arguments.',
    mimeType: 'text/plain',
    tool: 'list_commands',
  },
  {
    uri: 'agstudio://plugins',
    name: 'plugins',
    title: 'Instruments and effects',
    description: 'Every plugin with its settings and presets.',
    mimeType: 'text/plain',
    tool: 'list_plugins',
  },
  {
    uri: 'agstudio://guide',
    name: 'guide',
    title: 'How to control AGstudio',
    description: 'The rules and know-how for apply_actions.',
    mimeType: 'text/plain',
    tool: 'get_guide',
  },
];
