/**
 * Read-only tools: what the AI (and the MCP server) can look at. Each returns compact JSON with ids and
 * names, in the units the actions take (dB, 1-based bars, 1/16 steps, MIDI keys), so what it reads is what
 * it can write back. `readTools` is the list (name, description, JSON schema of the arguments, `run`);
 * `runReadTool` runs one by name and turns a bad argument into `{ error }` instead of a throw.
 */
import type { Draft } from 'immer';
import { formatValue, type ParamSpec, type ParamSpecs, type ParamValue, type PluginDef } from '@agstudio/sdk';
import { formatAutomationValue } from '@core/automation/labels';
import { resolveTarget } from '@core/automation/targets';
import { gainToDecibels } from '@core/model/fader';
import { sameTarget } from '@core/model/targets';
import type {
  AutomationChannel,
  Channel,
  Clip,
  InsertId,
  PatternId,
  PluginInstance,
  PluginOwner,
  Project,
} from '@core/model/types';
import { MASTER } from '@core/model/types';
import { compSegmentsOf } from '@core/ops/comp';
import { songLength } from '@core/query/playlist';
import { takeGroups } from '@core/query/takes';
import { patternLength } from '@core/query/queries';
import { songSections } from '@core/query/sections';
import { TICKS_PER_STEP, ticksPerBar } from '@core/time/ppq';
import { chainChoices, findChainChoice, type ChainChoice } from '../chains';
import { isAtPreset, presetChoices } from '../presets';
import { pitchReport } from '../pitch/report';
import { referenceReport } from '../reference/summary';
import type { Services } from '../services';
import { automationDrives, ownUnitOf, paramTargetOf } from './ops/automation';
import { ActionError, createOpContext, newAnswerState, type OpContext } from './ops/context';
import { RECORD_GRIDS } from './ops/session';
import { isObj, lower, num, str } from './ops/values';
import { OPEN_WINDOWS } from './ops/windows';
import * as S from './schema/parts';

type Args = Record<string, unknown>;

export interface ReadTool {
  name: string;
  description: string;
  /** JSON schema of the arguments (a closed object; every argument is optional unless `required` lists it). */
  schema: { type: 'object'; additionalProperties: false; properties: Record<string, unknown>; required?: string[] };
  /** Returns plain JSON. A bad argument returns `{ error }`. */
  run(s: Services, args?: Args): unknown;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const db = (gain: number) => (gain <= 0 ? -100 : r2(gainToDecibels(gain)));
const project = (s: Services) => s.doc.getState().project;

/** The same lookups the actions use (id, exact name, mixer number…), against the committed project. */
function lookups(s: Services): OpContext {
  const p = project(s) as unknown as Draft<Project>;
  return createOpContext(s, p, { message: '', actions: [] }, { previousBeat: null }, newAnswerState());
}

const barT = (p: Project) => ticksPerBar(p.transport.timeSig);
const bar1 = (p: Project, tick: number) => r2(tick / barT(p) + 1);
const bars = (p: Project, ticks: number) => r2(ticks / barT(p));
/** Mixer number: 0 for Master, 1… for the tracks (what actions accept as "insert"). */
const insNo = (p: Project, id: InsertId) => p.mixer.order.indexOf(id);
const insName = (p: Project, id: InsertId) => (id === MASTER ? 'Master' : (p.mixer.inserts[id]?.name ?? id));

/** One param as the AI sets it: id, the value in its unit, the text shown, and its range or options. */
function paramInfo(id: string, spec: ParamSpec, value: ParamValue | undefined): Record<string, unknown> {
  const v = value ?? spec.default;
  const label = spec.label && lower(spec.label) !== lower(id) ? { label: spec.label } : {};
  const base = { id, ...label, type: spec.type, value: v, text: formatValue(spec, v) };
  switch (spec.type) {
    case 'float':
    case 'int':
      return {
        ...base,
        ...(spec.unit ? { unit: spec.unit === '%' ? '0–1 (shown as %)' : spec.unit } : {}),
        min: spec.min,
        max: spec.max,
        default: spec.default,
      };
    case 'enum':
      return { ...base, options: [...spec.options], default: spec.default };
    case 'bool':
      return { ...base, default: spec.default };
  }
}

/** A plugin instance's settings: all of them, or only those that differ from the defaults. */
function paramsOf(def: PluginDef | undefined, inst: PluginInstance, all: boolean): Record<string, unknown>[] {
  if (!def) return [];
  const out: Record<string, unknown>[] = [];
  for (const [id, spec] of Object.entries(def.params as ParamSpecs) as [string, ParamSpec][]) {
    const v = inst.params[id];
    if (!all && (v === undefined || v === spec.default)) continue;
    out.push(paramInfo(id, spec, v));
  }
  return out;
}

/** The preset an instance is at: the first whose settings match, else the last one loaded (marked edited). */
function presetOf(s: Services, def: PluginDef | undefined, inst: PluginInstance, owner: PluginOwner) {
  if (!def) return null;
  const hit = presetChoices(def, s.presets).find((x) => isAtPreset(def, inst, x));
  if (hit) return { name: hit.name, edited: false };
  const last = s.presets.loadedInto(owner);
  return last ? { name: last, edited: true } : null;
}

/** Channels that make sound (the automation ones are listed by get_automation). */
const soundChannels = (p: Project): Channel[] =>
  p.channelOrder.map((id) => p.channels[id]!).filter((ch) => ch.kind !== 'automation');

const pluginName = (s: Services, id: string) => s.plugins.get(id)?.name ?? `${id} (missing)`;

function channelBrief(p: Project, s: Services, ch: Channel) {
  return {
    id: ch.id,
    name: ch.name,
    kind: ch.kind,
    ...(ch.kind === 'instrument' ? { plugin: ch.plugin.pluginId, plugin_name: pluginName(s, ch.plugin.pluginId) } : {}),
    ...(ch.kind !== 'automation' ? { insert: insNo(p, ch.output) } : {}),
    ...(ch.muted ? { muted: true } : {}),
  };
}

/** Wraps a tool body: ActionErrors (a thing that doesn't exist…) become `{ error }`. */
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  run: (s: Services, a: Args, c: OpContext) => unknown,
): ReadTool {
  return {
    name,
    description,
    schema: { type: 'object', additionalProperties: false, properties },
    run: (s, args = {}) => {
      try {
        return run(s, isObj(args) ? args : {}, lookups(s));
      } catch (e) {
        if (e instanceof ActionError) return { error: e.message };
        throw e;
      }
    },
  };
}

const BAR_RANGE = {
  from_bar: S.int('1-based first bar.'),
  to_bar: S.int('1-based last bar (inclusive).'),
};

/** [from, to) in ticks from optional 1-based inclusive bars. */
function barRange(p: Project, a: Args): { from: number; to: number } {
  const from = num(a.from_bar);
  const to = num(a.to_bar);
  return {
    from: from !== undefined ? (Math.max(1, Math.round(from)) - 1) * barT(p) : 0,
    to: to !== undefined ? Math.max(1, Math.round(to)) * barT(p) : Number.POSITIVE_INFINITY,
  };
}

// --------------------------------------------------------------------------------------------- tools

const get_project = tool(
  'get_project',
  'An overview of the project: title, tempo, time signature, key, length, and every channel, pattern, mixer track, playlist track and marker with its id and name. Start here.',
  {},
  (s) => {
    const p = project(s);
    const t = p.transport;
    return {
      title: p.meta.title,
      ...(p.meta.author ? { author: p.meta.author } : {}),
      bpm: t.bpm,
      time_signature: `${t.timeSig.num}/${t.timeSig.den}`,
      swing: r2(t.swing),
      key: t.key ? { root: t.key.root, scale: t.key.scale } : null,
      length_bars: bars(p, songLength(p)),
      mode: s.view.getState().mode,
      current_pattern: s.view.getState().currentPatternId,
      channels: soundChannels(p).map((ch) => channelBrief(p, s, ch)),
      automation_channels: p.channelOrder.length - soundChannels(p).length,
      patterns: p.patternOrder.map((id) => {
        const pat = p.patterns[id]!;
        return {
          id,
          name: pat.name,
          bars: bars(p, patternLength({ ...pat }, t.timeSig)),
          channels_with_notes: Object.values(pat.notes).filter((n) => n && Object.keys(n).length).length,
        };
      }),
      mixer: p.mixer.order.map((id) => ({ n: insNo(p, id), id, name: insName(p, id) })),
      tracks: p.playlist.laneOrder.map((id, i) => ({
        n: i + 1,
        id,
        name: p.playlist.lanes[id]!.name,
        clips: Object.values(p.playlist.clips).filter((c) => c.laneId === id).length,
      })),
      markers: Object.values(p.playlist.markers)
        .sort((x, y) => x.tick - y.tick)
        .map((m) => ({ id: m.id, name: m.name, bar: bar1(p, m.tick) })),
      sections: songSections(p).map((x) => ({ name: x.name, from_bar: bar1(p, x.from), to_bar: r2(x.to / barT(p)) })),
    };
  },
);

const get_transport = tool(
  'get_transport',
  'Tempo, time signature, swing, key, pattern or song mode, whether it plays, the playhead and song position, the loop region and the record settings.',
  {},
  (s) => {
    const p = project(s);
    const t = p.transport;
    const v = s.view.getState();
    const prefs = s.prefs.getState();
    const grid = Object.entries(RECORD_GRIDS).find(([, ticks]) => ticks === prefs.recordQuantize)?.[0] ?? `${prefs.recordQuantize} ticks`;
    const playhead = s.engine.playing ? s.engine.playhead() : v.songStart;
    return {
      bpm: t.bpm,
      time_signature: `${t.timeSig.num}/${t.timeSig.den}`,
      swing: r2(t.swing),
      key: t.key ? { root: t.key.root, scale: t.key.scale } : null,
      mode: v.mode,
      playing: s.engine.playing,
      position: { tick: Math.round(playhead), bar: bar1(p, playhead) },
      song_start_bar: bar1(p, v.songStart),
      loop: v.loop ? { from_bar: bar1(p, v.loop.start), to_bar: r2(v.loop.end / barT(p)) } : null,
      current_pattern: v.currentPatternId,
      song_length_bars: bars(p, songLength(p)),
      metronome: prefs.metronome,
      count_in_bars: prefs.countInBars,
      record: {
        armed: s.recording.armed,
        notes: prefs.recordNotes,
        audio: prefs.recordAudio,
        mode: prefs.recordMode,
        quantize: grid,
      },
    };
  },
);

const get_selection = tool(
  'get_selection',
  'What is selected now: the channel, the mixer track, the pattern being edited, the selected playlist clips and the selected piano-roll notes.',
  {},
  (s) => {
    const p = project(s);
    const ed = s.editor.getState();
    const ses = s.session.getState();
    const v = s.view.getState();
    const clips = ed.clipSelection.map((id) => p.playlist.clips[id]).filter((c): c is Clip => !!c);
    const pat = v.currentPatternId ? p.patterns[v.currentPatternId] : undefined;
    const cid = ses.selectedChannelId;
    const notes = pat && cid ? Object.values(pat.notes[cid] ?? {}).filter((n) => ed.noteSelection.includes(n.id)) : [];
    const ch = cid ? p.channels[cid] : undefined;
    return {
      channel: ch ? { id: ch.id, name: ch.name } : null,
      insert: ses.selectedInsertId
        ? { n: insNo(p, ses.selectedInsertId), id: ses.selectedInsertId, name: insName(p, ses.selectedInsertId) }
        : { n: 0, id: MASTER, name: 'Master' },
      pattern: pat ? { id: pat.id, name: pat.name } : null,
      clips: {
        count: clips.length,
        ids: clips.slice(0, 200).map((c) => c.id),
        ...(clips.length
          ? { from_bar: bar1(p, Math.min(...clips.map((c) => c.start))), to_bar: r2(Math.max(...clips.map((c) => c.start + c.length)) / barT(p)) }
          : {}),
      },
      notes: {
        count: notes.length,
        ...(notes.length
          ? {
              from_step: r3(Math.min(...notes.map((n) => n.tick)) / TICKS_PER_STEP),
              to_step: r3(Math.max(...notes.map((n) => n.tick + n.length)) / TICKS_PER_STEP),
              lowest_key: Math.min(...notes.map((n) => n.key)),
              highest_key: Math.max(...notes.map((n) => n.key)),
            }
          : {}),
      },
    };
  },
);

const get_pattern_notes = tool(
  'get_pattern_notes',
  'The notes of a pattern, per channel: rows of [step, length in steps, MIDI key, velocity 0..1] (step 0 = the pattern start, 16 steps per 4/4 bar, fractions allowed: the units write_notes takes), plus an object with pan, release, fine or muted for the notes that have them.',
  {
    pattern: S.PATTERN,
    channel: S.CHANNEL,
    ...BAR_RANGE,
    limit: S.int('Most notes to return (default 1500).'),
  },
  (s, a, c) => {
    const p = project(s);
    const pid: PatternId = a.pattern !== undefined ? c.pattern(a.pattern) : c.pattern('current');
    const pat = p.patterns[pid]!;
    const range = barRange(p, a);
    const limit = Math.max(1, Math.min(5000, Math.round(num(a.limit) ?? 1500)));
    const only = a.channel !== undefined ? c.channel(a.channel) : null;
    let left = limit;
    let truncated = false;
    const channels = p.channelOrder
      .filter((id) => (only ? id === only : true) && pat.notes[id] && Object.keys(pat.notes[id]!).length > 0)
      .map((id) => {
        const all = Object.values(pat.notes[id]!)
          .filter((n) => n.tick >= range.from && n.tick < range.to)
          .sort((x, y) => x.tick - y.tick || x.key - y.key);
        const shown = all.slice(0, Math.max(0, left));
        if (shown.length < all.length) truncated = true;
        left -= shown.length;
        return {
          id,
          name: p.channels[id]!.name,
          count: all.length,
          notes: shown.map((n) => {
            const row: unknown[] = [r3(n.tick / TICKS_PER_STEP), r3(n.length / TICKS_PER_STEP), n.key, r2(n.velocity)];
            const extra: Record<string, unknown> = {};
            if (n.muted) extra.muted = true;
            if (n.pan !== undefined && n.pan !== 0) extra.pan = r2(n.pan);
            if (n.release !== undefined) extra.release = r2(n.release);
            if (n.fine) extra.fine = n.fine;
            if (Object.keys(extra).length) row.push(extra);
            return row;
          }),
        };
      });
    return {
      pattern: { id: pid, name: pat.name, bars: bars(p, patternLength({ ...pat }, p.transport.timeSig)), steps: pat.stepCount },
      columns: ['step', 'len', 'key', 'vel'],
      channels,
      ...(truncated ? { truncated: true } : {}),
    };
  },
);

/** One mixer track with its routes, effects (and their settings) and the channels feeding it. */
function insertInfo(s: Services, p: Project, id: InsertId, allParams: boolean) {
  const ins = p.mixer.inserts[id]!;
  return {
    n: insNo(p, id),
    id,
    name: ins.name,
    ...(ins.color ? { color: ins.color } : {}),
    volume_db: db(ins.volume),
    pan: r2(ins.pan),
    muted: ins.muted,
    solo: ins.solo,
    routes: ins.routes.map((r) => ({ to: insNo(p, r.to), name: insName(p, r.to), level_db: db(r.level), pre: r.pre })),
    channels: p.channelOrder
      .map((cid) => p.channels[cid]!)
      .filter((ch) => ch.kind !== 'automation' && ch.output === id)
      .map((ch) => ({ id: ch.id, name: ch.name })),
    fx: ins.fx.map((f, i) => {
      const def = s.plugins.get(f.plugin.pluginId);
      return {
        slot: i + 1,
        id: f.id,
        plugin: f.plugin.pluginId,
        name: pluginName(s, f.plugin.pluginId),
        enabled: f.enabled,
        mix: r2(f.mix),
        ...(f.sidechain ? { sidechain_from: { n: insNo(p, f.sidechain), name: insName(p, f.sidechain) } } : {}),
        ...(def?.kind === 'effect' && def.sidechain ? { has_sidechain_input: true } : {}),
        ...(presetOf(s, def, f.plugin, { kind: 'fx', insertId: id, slotId: f.id })
          ? { preset: presetOf(s, def, f.plugin, { kind: 'fx', insertId: id, slotId: f.id }) }
          : {}),
        params: paramsOf(def, f.plugin, allParams),
      };
    }),
  };
}

const get_mixer = tool(
  'get_mixer',
  'The mixer: every track in use (or one track) with its fader in dB, pan, mute and solo, routes with send levels, the channels playing through it, and its effect slots with their settings (only those that differ from the defaults, with units and ranges), sidechain sources and preset. Tracks nobody uses are only counted (unused_tracks).',
  {
    insert: { ...S.INSERT, description: 'Only this track (default: all).' },
    all_params: S.bool('List every setting of every effect, not only the changed ones.'),
  },
  (s, a, c) => {
    const p = project(s);
    if (a.insert !== undefined) return { inserts: [insertInfo(s, p, c.insert(a.insert), a.all_params === true)] };
    const used = (id: InsertId) => {
      const ins = p.mixer.inserts[id]!;
      return (
        id === MASTER ||
        ins.fx.length > 0 ||
        ins.muted ||
        ins.solo ||
        ins.volume !== 1 ||
        ins.pan !== 0 ||
        ins.name !== `Insert ${insNo(p, id)}` ||
        ins.routes.length !== 1 ||
        ins.routes[0]!.to !== MASTER ||
        p.channelOrder.some((cid) => {
          const ch = p.channels[cid]!;
          return ch.kind !== 'automation' && ch.output === id;
        }) ||
        p.mixer.order.some((o) => p.mixer.inserts[o]!.routes.some((r) => r.to === id) || p.mixer.inserts[o]!.fx.some((f) => f.sidechain === id))
      );
    };
    const shown = p.mixer.order.filter(used);
    const unused = p.mixer.order.filter((id) => !used(id)).map((id) => insNo(p, id));
    return {
      inserts: shown.map((id) => insertInfo(s, p, id, a.all_params === true)),
      ...(unused.length ? { unused_tracks: unused } : {}),
    };
  },
);

const get_channel = tool(
  'get_channel',
  'One channel in full: its plugin with every setting (value, shown text, unit, range or options), preset, volume in dB, pan, pitch, mixer track, mute, solo, and sample. Without a channel: the list of channels.',
  { channel: S.CHANNEL },
  (s, a, c) => {
    const p = project(s);
    if (a.channel === undefined)
      return {
        channels: soundChannels(p).map((ch) => channelBrief(p, s, ch)),
        automation_channels: p.channelOrder.length - soundChannels(p).length,
      };
    const ch = p.channels[c.channel(a.channel)]!;
    const brief = channelBrief(p, s, ch);
    if (ch.kind === 'automation') return { ...brief, points: ch.points.length, drives: automationDrives(s, p, ch) };
    const common = {
      ...brief,
      color: ch.color,
      volume_db: db(ch.volume),
      pan: r2(ch.pan),
      muted: ch.muted,
      solo: ch.solo,
      insert: { n: insNo(p, ch.output), name: insName(p, ch.output) },
    };
    if (ch.kind === 'audioClip') {
      const smp = p.samples[ch.sampleId];
      return {
        ...common,
        sample: smp?.name ?? ch.sampleId,
        ...(ch.pitch ? { pitch_cents: ch.pitch } : {}),
        ...(ch.reverse ? { reverse: true } : {}),
        ...(ch.stretch && ch.stretch !== 'off' ? { follow_tempo: ch.stretch } : {}),
        ...(ch.sourceBpm ? { source_bpm: ch.sourceBpm } : {}),
        ...(ch.filter ? { filter: ch.filter.preset } : {}),
      };
    }
    const def = s.plugins.get(ch.plugin.pluginId);
    const samples = ch.plugin.samples
      ? Object.fromEntries(Object.entries(ch.plugin.samples).map(([slot, id]) => [slot, p.samples[id]?.name ?? id]))
      : undefined;
    return {
      ...common,
      pitch_cents: ch.pitch ?? 0,
      root_key: ch.rootKey,
      plugin_version: ch.plugin.pluginVersion,
      preset: presetOf(s, def, ch.plugin, { kind: 'channel', channelId: ch.id }),
      ...(samples ? { samples } : {}),
      params: paramsOf(def, ch.plugin, true),
      ...(def ? {} : { error: `the plugin ${ch.plugin.pluginId} isn't installed` }),
    };
  },
);

const get_clips = tool(
  'get_clips',
  'Playlist clips: id, track, bar where it starts, length in bars, kind (pattern, audio, automation), what it plays, muted. Filter by bars and tracks. Also the track names.',
  {
    ...BAR_RANGE,
    tracks: { type: 'array', items: { type: 'integer' }, description: '1-based playlist tracks (default all).' },
    kind: { type: 'string', enum: ['pattern', 'audio', 'automation'], description: 'Only this kind of clip.' },
    limit: S.int('Most clips to return (default 400).'),
  },
  (s, a) => {
    const p = project(s);
    const range = barRange(p, a);
    const want = Array.isArray(a.tracks)
      ? new Set(a.tracks.map(num).filter((x): x is number => x !== undefined).map((n) => p.playlist.laneOrder[Math.round(n) - 1]))
      : null;
    const kind = ['pattern', 'audio', 'automation'].find((k) => k === str(a.kind));
    const limit = Math.max(1, Math.min(3000, Math.round(num(a.limit) ?? 400)));
    const hits = (Object.values(p.playlist.clips) as Clip[])
      .filter((x) => x.start < range.to && x.start + x.length > range.from && (!want || want.has(x.laneId)) && (!kind || x.kind === kind))
      .sort((x, y) => p.playlist.laneOrder.indexOf(x.laneId) - p.playlist.laneOrder.indexOf(y.laneId) || x.start - y.start);
    const shown = hits.slice(0, limit);
    const trackNos = [...new Set(shown.map((x) => p.playlist.laneOrder.indexOf(x.laneId) + 1))];
    return {
      tracks: trackNos.map((n) => {
        const lane = p.playlist.lanes[p.playlist.laneOrder[n - 1]!]!;
        return { n, name: lane.name, ...(lane.muted ? { muted: true } : {}), ...(lane.solo ? { solo: true } : {}) };
      }),
      clips: shown.map((x) => ({
        id: x.id,
        track: p.playlist.laneOrder.indexOf(x.laneId) + 1,
        bar: bar1(p, x.start),
        bars: bars(p, x.length),
        kind: x.kind,
        name:
          x.kind === 'pattern'
            ? (p.patterns[x.patternId]?.name ?? '(deleted pattern)')
            : (p.channels[x.channelId]?.name ?? '(deleted channel)'),
        ...(x.muted ? { muted: true } : {}),
      })),
      total: hits.length,
      ...(hits.length > shown.length ? { truncated: true } : {}),
    };
  },
);

const get_automation = tool(
  'get_automation',
  'Automation: the automation channels (what each drives, its clips on the playlist), or the curve points of one: by its channel or by the control it moves. Point values are in the control’s own unit (dB, BPM, Hz…), bars from the clip start.',
  {
    channel: { ...S.CHANNEL, description: 'An automation channel: its id or name.' },
    target: S.AUTOMATION_TARGET,
  },
  (s, a, c) => {
    const p = project(s);
    const autos = p.channelOrder.map((id) => p.channels[id]!).filter((x): x is AutomationChannel => x.kind === 'automation');
    let wanted: AutomationChannel[] = autos;
    if (a.channel !== undefined) {
      const ch = p.channels[c.channel(a.channel)]!;
      if (ch.kind !== 'automation') return { error: `“${ch.name}” is not an automation channel` };
      wanted = [ch];
    } else if (a.target !== undefined) {
      const target = paramTargetOf(c, a.target);
      wanted = autos.filter((x) => x.target && sameTarget(x.target, target));
    }
    const detailed = a.channel !== undefined || a.target !== undefined;
    const specsOf = (id: string) => s.plugins.get(id)?.params as ParamSpecs | undefined;
    return {
      automation: wanted.map((ch) => {
        const clips = (Object.values(p.playlist.clips) as Clip[])
          .filter((x) => x.kind === 'automation' && x.channelId === ch.id)
          .sort((x, y) => x.start - y.start)
          .map((x) => ({ id: x.id, track: p.playlist.laneOrder.indexOf(x.laneId) + 1, bar: bar1(p, x.start), bars: bars(p, x.length) }));
        const head = { id: ch.id, name: ch.name, drives: automationDrives(s, p, ch), points: ch.points.length, clips };
        if (!detailed || !ch.target) return head;
        const res = resolveTarget(p, ch.target, specsOf, ch.range);
        return {
          ...head,
          curve: res
            ? ch.points.map((pt) => ({
                bar: bars(p, pt.tick),
                value: ownUnitOf(res, ch.target!, pt.value),
                text: formatAutomationValue(res, ch.target!, pt.value),
                ...(pt.shape && pt.shape !== 'curve' ? { shape: pt.shape } : {}),
                ...(pt.tension ? { tension: r2(pt.tension) } : {}),
              }))
            : [],
        };
      }),
    };
  },
);

const get_settings = tool(
  'get_settings',
  'The app’s settings: playback and recording preferences, audio, export defaults, look, and the editors’ tool and grid (what the settings action changes).',
  {},
  (s) => {
    const pr = s.prefs.getState();
    const ed = s.editor.getState();
    const grid = Object.entries(RECORD_GRIDS).find(([, ticks]) => ticks === pr.recordQuantize)?.[0] ?? `${pr.recordQuantize} ticks`;
    return {
      metronome: pr.metronome,
      count_in_bars: pr.countInBars,
      record_mode: pr.recordMode,
      record_quantize: grid,
      record_notes: pr.recordNotes,
      record_audio: pr.recordAudio,
      follow_playhead: pr.followPlayhead,
      tooltips: pr.tooltips,
      typing_piano: pr.typingPiano,
      piano_octave: pr.pianoOctave,
      midi_input: pr.midiInput,
      audio_buffer: pr.audioBuffer,
      sample_memory_mb: pr.sampleMemoryMb,
      scope: pr.scopeMode,
      input_device: pr.audioInputDevice || 'system default',
      input_channels: pr.audioInputChannels,
      input_track: pr.audioInputTrack || 'master',
      monitor: pr.audioMonitor,
      latency_offset_ms: pr.recordLatencyOffsetMs,
      output_device: pr.outputDevice || 'system default',
      theme: pr.theme,
      accent: pr.accent,
      export: {
        codec: pr.exportCodec,
        bits: pr.exportCodec === 'flac' ? pr.exportFlacBits : { pcm16: 16, pcm24: 24, float32: 32 }[pr.exportFormat],
        sample_rate: pr.exportSampleRate,
        mp3_kbps: pr.exportMp3Kbps,
        normalize: pr.exportNormalize,
        stems: pr.exportStems,
        master_chain: pr.exportMasterChain,
        stems_to: pr.exportStemsTo,
      },
      piano_roll: {
        tool: ed.pianoRoll.tool,
        snap: ed.pianoRoll.snap,
        scale_snap: ed.pianoRoll.scaleSnap,
        scale_highlight: ed.pianoRoll.scaleHighlight,
      },
      playlist: { tool: ed.playlist.tool, snap: ed.playlist.snap },
    };
  },
);

const get_windows = tool(
  'get_windows',
  'The windows that are open (id, type, visible, focused, maximized), whether the browser panel shows, and the window names the open action takes.',
  {},
  (s) => {
    const v = s.view.getState();
    return {
      windows: Object.values(v.windows)
        .sort((x, y) => y.z - x.z)
        .map((w) => ({
          id: w.id,
          type: w.type,
          visible: w.visible,
          ...(v.focusedId === w.id ? { focused: true } : {}),
          ...(w.maximized ? { maximized: true } : {}),
        })),
      browser: v.browser.visible,
      available: [...OPEN_WINDOWS],
    };
  },
);

const get_plugins = tool(
  'get_plugins',
  'The installed plugins: instruments, effects and piano-roll tools with id, name, category and preset names; give a plugin (id or name) for all its settings with unit, range, default and options.',
  {
    kind: { type: 'string', enum: ['instrument', 'effect', 'tool'], description: 'Only this kind.' },
    plugin: S.str('A plugin id or exact name: its settings in full.'),
  },
  (s, a) => {
    const want = str(a.plugin);
    const kinds = ['instrument', 'effect', 'tool'] as const;
    const kind = kinds.find((k) => k === str(a.kind));
    const all: { kind: (typeof kinds)[number]; def: PluginDef }[] = [
      ...s.plugins.list('instrument').map((e) => ({ kind: 'instrument' as const, def: e.def })),
      ...s.plugins.list('effect').map((e) => ({ kind: 'effect' as const, def: e.def })),
      ...s.plugins.scripts().map((e) => ({ kind: 'tool' as const, def: e.def as unknown as PluginDef })),
    ];
    if (want) {
      const hit = all.find((x) => x.def.id === want || lower(x.def.name) === lower(want));
      if (!hit) return { error: `there is no plugin "${want}"` };
      const def = hit.def;
      return {
        id: def.id,
        name: def.name,
        kind: hit.kind,
        ...(def.category ? { category: def.category } : {}),
        ...(def.description ? { description: def.description } : {}),
        ...(def.kind === 'effect' && def.sidechain ? { has_sidechain_input: true } : {}),
        ...(def.sampleSlots?.length ? { sample_slots: [...def.sampleSlots] } : {}),
        presets: hit.kind === 'tool' ? [] : presetChoices(def, s.presets).map((x) => ({ name: x.name, source: x.source })),
        params: (Object.entries(def.params as ParamSpecs) as [string, ParamSpec][]).map(([id, spec]) => paramInfo(id, spec, undefined)),
      };
    }
    return {
      plugins: all
        .filter((x) => !kind || x.kind === kind)
        .map((x) => ({
          id: x.def.id,
          name: x.def.name,
          kind: x.kind,
          ...(x.def.category ? { category: x.def.category } : {}),
          ...(x.kind !== 'tool' ? { presets: presetChoices(x.def, s.presets).map((y) => y.name) } : {}),
        })),
    };
  },
);

const get_chains = tool(
  'get_chains',
  'The effect chains add_chain can put on a mixer track (the factory vocal chains and the musician’s own): name, what it is for, and its effects in order with plugin, preset, settings, dry/wet and send; give a chain name for one in full.',
  { chain: S.str('A chain name (or part of it): only that chain.') },
  (s, a) => {
    const all = chainChoices(s.presets.chains());
    const want = str(a.chain);
    const brief = (c: ChainChoice) => ({
      name: c.name,
      source: c.source,
      ...(c.description ? { description: c.description } : {}),
      effects: c.steps.map((x) => ({
        plugin: x.pluginId,
        plugin_name: pluginName(s, x.pluginId),
        what: x.label,
        ...(x.preset ? { preset: x.preset } : {}),
        ...(x.params ? { params: x.params } : {}),
        ...(x.mix !== undefined ? { mix: x.mix } : {}),
        ...(x.enabled === false ? { bypassed: true } : {}),
        ...(x.send ? { send_to: x.send.to, send_db: x.send.db } : {}),
      })),
    });
    if (want) {
      const hit = findChainChoice(all, want);
      return hit ? brief(hit) : { error: `there is no chain "${want}"`, chains: all.map((c) => c.name) };
    }
    return { chains: all.map((c) => ({ name: c.name, source: c.source, effects: c.steps.length, ...(c.description ? { description: c.description } : {}) })) };
  },
);

const get_reference = tool(
  'get_reference',
  'The reference song (a song the musician owns that their song should be shaped after): its measured tempo, key, sections with bar counts and energy, loudness, true peak, tonal balance per band and stereo width, next to the musician’s song (tempo, key, sections), what an arrangement like the reference would be at the song’s tempo, and the last tonal comparison of the mix with it. Only measurements: no notes or audio of the reference exist here.',
  {},
  (s) => referenceReport(project(s)),
);

const get_takes = tool(
  'get_takes',
  'Audio recordings that have takes (loop passes): for each take group its comp track and take tracks (1-based playlist tracks), the takes (1-based, in recording order, with their clip ids, bar and length), what the comp plays where (take number per range of bars), its crossfade and which take the musician is listening to on its own (listening_to_take; the comp.listenTake command starts that); also the punch range and recording settings. The comp action takes these numbers.',
  { group: S.str('Only this take group (its id).') },
  (s, a) => {
    const p = project(s);
    const want = str(a.group);
    const open = s.editor.getState().openTakes;
    const heard = s.editor.getState().auditionTake;
    const trackOf = (id: string) => p.playlist.laneOrder.indexOf(id as never) + 1;
    const groups = takeGroups(p)
      .filter((g) => !want || g.id === want)
      .map((g) => {
        const nth = (index: number) => g.takes.findIndex((t) => t.index === index) + 1;
        return {
          group: g.id,
          name: g.compLane ? p.playlist.lanes[g.compLane]!.name.replace(/ · comp$/, '') : g.id,
          comp_track: g.compLane ? trackOf(g.compLane) : null,
          take_tracks: g.takeLanes.map(trackOf),
          takes_open: open.includes(g.id),
          // The take the musician is listening to on its own (a session switch, not in the project), else null.
          listening_to_take: nth(g.takes.find((t) => t.clips.some((c) => c.id === heard))?.index ?? -1) || null,
          crossfade_ms: g.crossfadeMs,
          takes: g.takes.map((t) => ({
            take: nth(t.index),
            clips: t.clips.map((c) => ({ id: c.id, track: trackOf(c.laneId), bar: bar1(p, c.start), bars: bars(p, c.length) })),
          })),
          comp: compSegmentsOf(g).map((x) => ({ take: nth(x.take), bar: bar1(p, x.from), bars: bars(p, x.to - x.from) })),
        };
      });
    const v = s.view.getState();
    const pr = s.prefs.getState();
    return {
      groups,
      punch: v.punch ? { from_bar: bar1(p, v.punch.start), to_bar: r2(v.punch.end / barT(p)) } : null,
      loop: v.loop ? { from_bar: bar1(p, v.loop.start), to_bar: r2(v.loop.end / barT(p)) } : null,
      recording: {
        record_mode_armed: s.recording.armed,
        records_audio: pr.recordAudio,
        count_in_bars: pr.countInBars,
        pre_roll_bars: pr.preRollBars,
        input_channels: pr.audioInputChannels,
        latency_ms: r2(s.audioInput.latency() * 1000),
      },
    };
  },
);

const get_pitch = tool(
  'get_pitch',
  'The sung notes of a recorded audio clip, as the Pitch editor shows them: per note its number (1-based, what the pitch action takes), bar, start/end seconds, pitch (MIDI and note name), how many cents off the nearest note, whether it is in the song key, drift and vibrato measured, and what has been changed (target, shift, flattened drift, vibrato %); also which sound the musician hears (the A/B switch: hearing). The first look at a clip it listens first (state "analyzing": ask again in a moment).',
  { clip: S.str('An audio clip id (clip_…; default: the selected audio clip).') },
  (s, a) => pitchReport(s, a),
);

/** Every read tool, in the order they are listed to the model. */
export const readTools: readonly ReadTool[] = [
  get_project,
  get_transport,
  get_selection,
  get_pattern_notes,
  get_channel,
  get_mixer,
  get_clips,
  get_takes,
  get_automation,
  get_settings,
  get_windows,
  get_plugins,
  get_chains,
  get_reference,
  get_pitch,
];

/** Runs a read tool by name; an unknown name or a bad argument comes back as `{ error }`. */
export function runReadTool(s: Services, name: string, args: unknown = {}): unknown {
  const t = readTools.find((x) => x.name === name);
  if (!t) return { error: `there is no read tool "${name}" (tools: ${readTools.map((x) => x.name).join(', ')})` };
  return t.run(s, isObj(args) ? args : {});
}

/** What a `query` answer brings back, as text for the next turn (each result cut at `max` characters). */
export function formatLookups(queries: readonly { tool: string; args: Args; result: unknown }[], max = 14000): string {
  return queries
    .map((q) => {
      const json = JSON.stringify(q.result);
      const body = json.length > max ? `${json.slice(0, max)}…(cut: ask again for less, e.g. one channel or a range of bars)` : json;
      return `${q.tool} ${JSON.stringify(q.args)}\n${body}`;
    })
    .join('\n\n');
}
