/**
 * The tools that only read: the project as the Studio chat sees it (text), the plugin catalog, the guide,
 * and every read tool the Studio chat can call (`ai/read.ts`: pattern notes, mixer, channels, clips,
 * automation, selection, transport, settings, windows, plugins), each as its own MCP tool returning JSON.
 */
import type { ParamSpecs } from '@agstudio/sdk';
import { ticksPerBar } from '@core/time/ppq';
import { pluginCatalog } from '../ai/catalog';
import { projectContext } from '../ai/context';
import { focusContext, resolveFocus, type AiFocus } from '../ai/focus';
import { STUDIO_PROMPT } from '../ai/prompt';
import { readTools, runReadTool } from '../ai/read';
import type { Services } from '../services';
import { barsArg, fail, ok, type ToolFn } from './common';
import { mcpReadName } from './defs';

/** How this guide differs from talking to Studio: tools instead of an answer in JSON. */
const MCP_PREFACE = `You are driving AGstudio through MCP tools. The guide below was written for Studio, the chat inside the app, which answers with JSON {message, actions}. For you:
- "an answer's actions" are the "actions" of one apply_actions call, and its "message" is the call's "summary". Everything in one call is one undo step, shown to the musician in Studio's chat as "<your name> changed: <summary>" with an Undo button.
- Where it says to answer with just an analyze_mix action, call the analyze_mix tool instead, read the findings, then fix them with apply_actions. Where it says to ask to look something up (a query action), call the read tools directly (get_pattern_notes, get_notation, get_mixer, get_channel, get_clips, get_automation, get_selection, get_transport, get_chords, get_lyrics, get_settings, get_windows, get_plugins, get_chains, get_mix_snapshots, get_mix_groups, get_versions, get_recent_projects, get_project_summary).
- Read the project with get_project (it is what Studio is given each turn) and the plugin settings with list_plugins or get_plugins; the app commands are in list_commands, and "command" actions or run_command run them. Commands that open a file dialog need the musician's click; use export_audio to write audio files, or export_video for a music video, without one.
- Playback: play, stop, seek, set_loop and transport_state. The musician may be listening: do not start playback unless it helps them hear a change, and say what you did.
- After a change, check it: get_project for the structure, analyze_mix for the sound, render_preview for a short WAV.

--- Studio's guide ---
`;

export const getGuide: ToolFn = () => ok(MCP_PREFACE + STUDIO_PROMPT);

export const listPlugins: ToolFn = (s) => ok(pluginCatalog(s.plugins, s.presets).text);

const pluginInfo = (s: Services) => (id: string) => {
  const def = s.plugins.get(id);
  return def ? { name: def.name, params: def.params as ParamSpecs } : undefined;
};

/** A focus on bars, as the Studio chat's "Ask AI about this part" makes it. */
export function barsFocus(s: Services, from: number, to: number): AiFocus {
  const p = s.doc.getState().project;
  const bar = ticksPerBar(p.transport.timeSig);
  return { kind: 'range', from: (from - 1) * bar, to: to * bar, projectId: p.projectId };
}

export const getProject: ToolFn = (s, args) => {
  const bars = barsArg(args.focus);
  if (typeof bars === 'string') return fail(bars);
  let text = projectContext(s);
  if (bars) {
    const part = resolveFocus(s.doc.getState().project, barsFocus(s, bars.from, bars.to));
    if (part) text += `\n\n<focus>\n${focusContext(s.doc.getState().project, part, pluginInfo(s))}\n</focus>`;
  }
  return ok(text);
};

/** A read tool of the Studio chat as an MCP tool: its JSON as text and as data; a bad argument is an error the AI can fix. */
function readTool(name: string): ToolFn {
  return async (s, args) => {
    await readTools.find((t) => t.name === name)?.prepare?.(s);
    const result = runReadTool(s, name, args);
    if (typeof result === 'object' && result !== null && !Array.isArray(result) && typeof (result as { error?: unknown }).error === 'string')
      return fail((result as { error: string }).error);
    return ok(JSON.stringify(result), typeof result === 'object' && result !== null && !Array.isArray(result) ? (result as Record<string, unknown>) : { result });
  };
}

export const READ_TOOLS: Record<string, ToolFn> = {
  get_guide: getGuide,
  get_project: getProject,
  list_plugins: listPlugins,
  ...Object.fromEntries(readTools.map((t) => [mcpReadName(t.name), readTool(t.name)])),
};
