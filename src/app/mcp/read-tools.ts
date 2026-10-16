/**
 * The tools that only read: the project as the Studio chat sees it, a pattern's notes, the mixer and
 * the playlist's clips, the plugin catalog and the guide. Text for the AI first, the same facts as data too.
 */
import type { ParamSpecs } from '@agstudio/sdk';
import { gainToDecibels } from '@core/model/fader';
import type { Channel, ChannelId, Clip, Pattern, PatternId, Project } from '@core/model/types';
import { MASTER } from '@core/model/types';
import { insertLabel } from '@core/query/mixer';
import { patternLength } from '@core/query/queries';
import { barSpan } from '@core/time/bars';
import { ticksPerBar } from '@core/time/ppq';
import { findPattern } from '../actions/transport';
import { pluginCatalog } from '../ai/catalog';
import { projectContext, noteLines } from '../ai/context';
import { focusContext, resolveFocus, type AiFocus } from '../ai/focus';
import { STUDIO_PROMPT } from '../ai/prompt';
import type { Services } from '../services';
import { barsArg, fail, int, ok, str, type ToolFn } from './common';

const r2 = (v: number) => Math.round(v * 100) / 100;
const db = (gain: number) => (gain <= 0 ? null : r2(gainToDecibels(gain)));
const dbText = (gain: number) => (gain <= 0 ? '-inf dB' : `${r2(gainToDecibels(gain))} dB`);

/** How this guide differs from talking to Studio: tools instead of an answer in JSON. */
const MCP_PREFACE = `You are driving AGstudio through MCP tools. The guide below was written for Studio, the chat inside the app, which answers with JSON {message, actions}. For you:
- "an answer's actions" are the "actions" of one apply_actions call, and its "message" is the call's "summary". Everything in one call is one undo step, shown to the musician in Studio's chat as "<your name> changed: <summary>" with an Undo button.
- Where it says to answer with just an analyze_mix action, call the analyze_mix tool instead, read the findings, then fix them with apply_actions.
- Read the project with get_project (it is what Studio is given each turn) and the plugin settings with list_plugins; the app commands are in list_commands, and "command" actions or run_command run them. Commands that open a file dialog need the musician's click; use export_audio to write audio files without one.
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

/** A channel by id or exact name (any case). */
export function findChannel(p: Project, ref: string): Channel | undefined {
  const byId = p.channels[ref as ChannelId];
  if (byId) return byId;
  const lower = ref.toLowerCase();
  for (const id of p.channelOrder) {
    const ch = p.channels[id];
    if (ch && ch.name.toLowerCase() === lower) return ch;
  }
  return undefined;
}

export const getPattern: ToolFn = (s, args) => {
  const p = s.doc.getState().project;
  const ref = str(args.pattern);
  const id: PatternId | null | undefined = ref ? findPattern(s, ref) : s.view.getState().currentPatternId;
  const pattern: Pattern | undefined = id ? p.patterns[id] : undefined;
  if (!pattern)
    return fail(ref ? `No pattern called "${ref}". Patterns: ${p.patternOrder.map((i) => `"${p.patterns[i]?.name}" ${i}`).join(', ') || 'none'}.` : 'There is no pattern yet.');
  const channelRef = str(args.channel);
  let only: Channel | undefined;
  if (channelRef) {
    only = findChannel(p, channelRef);
    if (!only) return fail(`No channel called "${channelRef}".`);
  }
  const shown = only ? { ...pattern, notes: { [only.id]: pattern.notes[only.id] ?? {} } } : pattern;
  const lines = noteLines(p, shown as Pattern);
  const channels = p.channelOrder
    .map((cid) => p.channels[cid])
    .filter((c): c is Channel => !!c && (!only || c.id === only.id))
    .map((c) => ({
      id: c.id,
      name: c.name,
      notes: Object.values(pattern.notes[c.id] ?? {})
        .sort((a, b) => a.tick - b.tick || a.key - b.key)
        .map((n) => ({ tick: n.tick, step: r2(n.tick / 240), key: n.key, length_ticks: n.length, velocity: r2(n.velocity), ...(n.muted ? { muted: true } : {}) })),
    }))
    .filter((c) => c.notes.length > 0);
  const bars = patternLength(pattern, p.transport.timeSig) / ticksPerBar(p.transport.timeSig);
  const head = `Pattern "${pattern.name}" ${pattern.id}, ${r2(bars)} bar${bars === 1 ? '' : 's'} (steps are 1/16 notes from 0; pitched notes as step:note/length; @ = velocity 0–1 when not 0.8; 1 step = 240 ticks):`;
  return ok(lines.length ? `${head}\n${lines.join('\n')}` : `${head}\n(no notes)`, {
    pattern: { id: pattern.id, name: pattern.name, bars: r2(bars) },
    channels,
  });
};

export const getMixer: ToolFn = (s) => {
  const p = s.doc.getState().project;
  const lines: string[] = [];
  const tracks = p.mixer.order.map((id, n) => {
    const ins = p.mixer.inserts[id];
    if (!ins) return null;
    const feeds = p.channelOrder.filter((c) => {
      const ch = p.channels[c];
      return ch && ch.kind !== 'automation' && ch.output === id;
    });
    const fx = ins.fx.map((slot) => {
      const def = s.plugins.get(slot.plugin.pluginId);
      const specs = (def?.params ?? {}) as ParamSpecs;
      const settings: Record<string, unknown> = {};
      for (const [pid, spec] of Object.entries(specs)) {
        const v = slot.plugin.params[pid];
        if (v !== undefined && v !== spec.default) settings[pid] = v;
      }
      return {
        id: slot.id,
        plugin: slot.plugin.pluginId,
        name: def?.name ?? `${slot.plugin.pluginId} (missing)`,
        enabled: slot.enabled,
        mix: r2(slot.mix),
        sidechain_from: slot.sidechain ? insertLabel(p, slot.sidechain) : null,
        settings,
      };
    });
    const routes = ins.routes.map((r) => ({ to: insertLabel(p, r.to), level_db: db(r.level), pre_fader: r.pre }));
    lines.push(
      `${n === 0 ? 'Master' : `Insert ${n}`}${id === MASTER ? '' : ` "${ins.name}"`} ${id}: volume ${dbText(ins.volume)}, pan ${r2(ins.pan)}${ins.muted ? ', MUTED' : ''}${ins.solo ? ', SOLO' : ''}` +
        `${feeds.length ? `; channels: ${feeds.map((c) => p.channels[c]?.name).join(', ')}` : ''}` +
        `${routes.length && id !== MASTER ? `; to ${routes.map((r) => `${r.to}${r.level_db === 0 ? '' : ` (${r.level_db} dB${r.pre_fader ? ', pre' : ''})`}`).join(', ')}` : ''}`,
    );
    fx.forEach((f, i) =>
      lines.push(
        `   fx ${i + 1}: ${f.name} (${f.plugin}) ${f.id}${f.enabled ? '' : ' BYPASSED'}, mix ${Math.round(f.mix * 100)}%${f.sidechain_from ? `, sidechain from ${f.sidechain_from}` : ''}${Object.keys(f.settings).length ? `; ${Object.entries(f.settings).map(([k, v]) => `${k} ${String(v)}`).join(', ')}` : ''}`,
      ),
    );
    return { number: n, id, name: ins.name, volume_db: db(ins.volume), pan: r2(ins.pan), muted: ins.muted, solo: ins.solo, channels: feeds.map((c) => ({ id: c, name: p.channels[c]?.name })), routes, effects: fx };
  });
  return ok(lines.join('\n') || '(the mixer is empty)', { tracks: tracks.filter((t) => t !== null) });
};

export const getClips: ToolFn = (s, args) => {
  const p = s.doc.getState().project;
  const ts = p.transport.timeSig;
  const bar = ticksPerBar(ts);
  const fromBar = int(args.from_bar);
  const toBar = int(args.to_bar);
  const trackNo = int(args.track);
  const laneId = trackNo === undefined ? undefined : p.playlist.laneOrder[trackNo - 1];
  if (trackNo !== undefined && !laneId) return fail(`There is no playlist track ${trackNo}; there are ${p.playlist.laneOrder.length}.`);
  const clips = Object.values(p.playlist.clips)
    .filter((c: Clip) => (laneId ? c.laneId === laneId : true))
    .filter((c) => (fromBar === undefined ? true : c.start + c.length > (fromBar - 1) * bar))
    .filter((c) => (toBar === undefined ? true : c.start < toBar * bar))
    .sort((a, b) => a.start - b.start);
  const describe = (c: Clip) =>
    c.kind === 'pattern'
      ? `pattern "${p.patterns[c.patternId]?.name ?? c.patternId}"`
      : c.kind === 'audio'
        ? `audio "${p.channels[c.channelId]?.name ?? c.channelId}"`
        : `automation "${p.channels[c.channelId]?.name ?? c.channelId}"`;
  const lines = p.playlist.laneOrder.flatMap((lid, i) => {
    const mine = clips.filter((c) => c.laneId === lid);
    if (!mine.length) return [];
    const lane = p.playlist.lanes[lid];
    return [
      `Track ${i + 1}${lane?.name ? ` "${lane.name}"` : ''}${lane?.muted ? ' (muted)' : ''}:`,
      ...mine.map((c) => `  ${describe(c)} ${c.id}: ${barSpan(c.start, c.start + c.length, ts)}${c.muted ? ' (muted)' : ''}`),
    ];
  });
  return ok(lines.join('\n') || 'No clips there.', {
    clips: clips.map((c) => ({
      id: c.id,
      track: p.playlist.laneOrder.indexOf(c.laneId) + 1,
      kind: c.kind,
      ...(c.kind === 'pattern' ? { pattern: c.patternId } : { channel: c.channelId }),
      start_bar: c.start / bar + 1,
      bars: c.length / bar,
      ...(c.muted ? { muted: true } : {}),
    })),
  });
};

export const READ_TOOLS: Record<string, ToolFn> = {
  get_guide: getGuide,
  get_project: getProject,
  list_plugins: listPlugins,
  get_pattern: getPattern,
  get_mixer: getMixer,
  get_clips: getClips,
};

