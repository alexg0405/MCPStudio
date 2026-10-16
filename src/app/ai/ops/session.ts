/**
 * Actions on the app itself rather than the project: `settings` (preferences and editor settings), `select`
 * (what the editors and commands act on: channel, mixer track, pattern, clips, notes, the loop region) and
 * `save_preset`. They change stores that are not part of the document, so they make no undo step; they run
 * right after the edit (an answer can write notes and then select them) and report in `AppliedTurn.ui`.
 */
import type { Draft } from 'immer';
import { markerTarget } from '@core/filters/target';
import type { ChannelId, Clip, ClipId, NoteId, PatternId, PluginOwner, Project } from '@core/model/types';
import { SNAP_OPTIONS, type Snap } from '@core/time/snap';
import { ticksPerBar } from '@core/time/ppq';
import type { Services } from '../../services';
import type { AudioBufferSize, PrefsState } from '../../stores/prefs';
import { PIANO_ROLL_TOOLS, PLAYLIST_TOOLS } from '../../stores/editor';
import type { AiAction, AiAnswer } from '../schema';
import * as S from '../schema/parts';
import { ActionError, createOpContext, fail, type AnswerState, type OpContext, type OpModule } from './context';
import { bool, isObj, lower, num, r2, str } from './values';

/** Record-quantize grids by name (ticks; 0 = off). */
export const RECORD_GRIDS: Readonly<Record<string, number>> = {
  off: 0,
  '1/4': 960,
  '1/8': 480,
  '1/16': 240,
  '1/32': 120,
  '1/8t': 320,
  '1/16t': 160,
};
export const AUDIO_BUFFERS: readonly AudioBufferSize[] = ['small', 'medium', 'large'];
const SCOPES = ['scope', 'spectrum', 'off'] as const;
const SNAPS = SNAP_OPTIONS.map((o) => o.value);

/** The export defaults as `settings.export` names them. */
function exportPatch(p: Record<string, unknown>, warn: (m: string) => void): { patch: Partial<PrefsState>; text: string[] } {
  const patch: Partial<PrefsState> = {};
  const text: string[] = [];
  const codec = (['wav', 'flac', 'mp3'] as const).find((x) => x === str(p.codec));
  if (p.codec !== undefined && !codec) warn(`export codec must be wav, flac or mp3 (not ${JSON.stringify(p.codec)})`);
  if (codec) {
    patch.exportCodec = codec;
    text.push(codec.toUpperCase());
  }
  const bits = num(p.bits);
  if (bits !== undefined) {
    const kind = codec ?? undefined;
    if (bits === 16 || bits === 24) {
      patch.exportFormat = bits === 16 ? 'pcm16' : 'pcm24';
      patch.exportFlacBits = bits;
      text.push(`${bits}-bit`);
    } else if (bits === 32 && kind !== 'flac') {
      patch.exportFormat = 'float32';
      text.push('32-bit float');
    } else warn(`export bits must be 16 or 24 (WAV also 32), not ${bits}`);
  }
  const rate = num(p.sample_rate);
  if (rate !== undefined) {
    if ([44100, 48000, 96000].includes(rate)) {
      patch.exportSampleRate = rate;
      text.push(`${rate / 1000} kHz`);
    } else warn('export sample_rate must be 44100, 48000 or 96000');
  }
  const kbps = num(p.mp3_kbps);
  if (kbps !== undefined) {
    if ([128, 192, 256, 320].includes(kbps)) {
      patch.exportMp3Kbps = kbps;
      text.push(`${kbps} kbps`);
    } else warn('export mp3_kbps must be 128, 192, 256 or 320');
  }
  for (const [key, pref, label] of [
    ['normalize', 'exportNormalize', 'normalize'],
    ['stems', 'exportStems', 'stems'],
    ['master_chain', 'exportMasterChain', 'stems through the master chain'],
  ] as const) {
    const v = bool(p[key]);
    if (v !== undefined) {
      patch[pref] = v;
      text.push(`${label} ${v ? 'on' : 'off'}`);
    }
  }
  const to = (['folder', 'zip'] as const).find((x) => x === str(p.stems_to));
  if (p.stems_to !== undefined && !to) warn('export stems_to must be folder or zip');
  if (to) {
    patch.exportStemsTo = to;
    text.push(`stems into a ${to}`);
  }
  return { patch, text };
}

const EDITOR_FIELDS = (tools: readonly string[], what: string) => ({
  type: 'object',
  description: `${what}.`,
  additionalProperties: false,
  properties: {
    tool: { type: 'string', enum: [...tools] },
    snap: { type: 'string', enum: [...SNAPS], description: 'Grid to snap to.' },
    ...(what === 'Piano roll'
      ? {
          scale_snap: S.bool('Drawn notes stay in the key’s scale.'),
          scale_highlight: S.bool('Shade rows outside the key’s scale.'),
        }
      : {}),
  },
});

export const session: OpModule = {
  schemas: [
    S.op('settings', 'App settings (not the project); only what you list changes. Applied after the edits, not undoable.', {
      metronome: S.bool('Metronome.'),
      count_in_bars: S.int('Count-in bars before recording (0–4).'),
      record_mode: { type: 'string', enum: ['overdub', 'replace'] },
      record_quantize: { type: 'string', enum: Object.keys(RECORD_GRIDS), description: 'Grid recorded notes snap to.' },
      record_notes: S.bool('Record notes and knob moves.'),
      record_audio: S.bool('Record audio from the input.'),
      follow_playhead: S.bool('Scroll with the playhead.'),
      tooltips: S.bool('Hover hints.'),
      typing_piano: S.bool('Computer keys play notes.'),
      piano_octave: S.int('Typing keyboard octave (0–9; 5 = middle C).'),
      midi_input: S.bool('MIDI keyboards.'),
      audio_buffer: { type: 'string', enum: [...AUDIO_BUFFERS], description: 'Large plays smoothest, small answers fastest live.' },
      sample_memory_mb: S.int('Decoded-audio memory in MB (256–16384).'),
      scope: { type: 'string', enum: [...SCOPES], description: 'Toolbar display.' },
      input_channels: { type: 'string', enum: ['mono', 'stereo'], description: 'Audio input.' },
      input_track: { ...S.INSERT, description: 'Mixer track the audio input records and monitors through.' },
      monitor: S.bool('Hear the input while recording (headphones!).'),
      latency_offset_ms: S.num('Recording latency correction, ms (−200…200).'),
      export: {
        type: 'object',
        description: 'Export defaults.',
        additionalProperties: false,
        properties: {
          codec: { type: 'string', enum: ['wav', 'flac', 'mp3'] },
          bits: S.int('16, 24 (WAV also 32 float).'),
          sample_rate: S.int('44100, 48000 or 96000.'),
          mp3_kbps: S.int('128, 192, 256 or 320.'),
          normalize: S.bool('Normalize.'),
          stems: S.bool('Stems.'),
          master_chain: S.bool('Stems through the master chain.'),
          stems_to: { type: 'string', enum: ['folder', 'zip'] },
        },
      },
      piano_roll: EDITOR_FIELDS(PIANO_ROLL_TOOLS, 'Piano roll'),
      playlist: EDITOR_FIELDS(PLAYLIST_TOOLS, 'Playlist'),
    }),
    S.op(
      'select',
      'Selects what the editors and commands act on, applied after the edits. Then run a command (copy, transpose, delete…) on it.',
      {
        channel: S.CHANNEL,
        insert: S.INSERT,
        pattern: S.PATTERN,
        clips: {
          type: 'object',
          description: 'Playlist clips: ids, or those on a track and/or touching bars.',
          additionalProperties: false,
          properties: {
            ids: { type: 'array', items: { type: 'string' } },
            track: S.int('1-based playlist track.'),
            from_bar: S.int('1-based first bar.'),
            to_bar: S.int('1-based last bar (inclusive).'),
            all: S.bool('Every clip.'),
          },
        },
        notes: {
          type: 'object',
          description: 'Piano-roll notes of a channel (default: the selected one) in a pattern, within bars and keys (default all).',
          additionalProperties: false,
          properties: {
            pattern: S.PATTERN,
            channel: S.CHANNEL,
            from_bar: S.int('1-based first bar.'),
            to_bar: S.int('1-based last bar (inclusive).'),
            from_key: S.int('Lowest MIDI key.'),
            to_key: S.int('Highest MIDI key.'),
          },
        },
        loop: {
          type: 'object',
          description: 'The loop region: bars, or a marker’s section.',
          additionalProperties: false,
          properties: {
            from_bar: S.int('1-based first bar.'),
            to_bar: S.int('1-based last bar (inclusive).'),
            section: S.str('A marker name: its span to the next marker.'),
          },
        },
        clear: { type: 'string', enum: ['clips', 'notes', 'loop', 'all'], description: 'Clear that selection.' },
      },
    ),
    S.op(
      'save_preset',
      'Saves a channel’s or effect’s settings as the musician’s own preset (same name replaces); load it later with preset.',
      { channel: S.CHANNEL, effect: S.EFFECT, name: S.str('The preset’s name.') },
      ['name'],
    ),
  ],
  prompt: {
    id: 'session',
    order: 40,
    text: `App settings and selection: settings changes preferences (metronome, count-in, record mode, follow playhead, tooltips, audio buffer, input, export defaults, the editors' tool and grid), not the project. select picks what commands act on: channel, mixer track, pattern, clips (by id, track or bars), notes, the loop region. Selection-based commands (pianoRoll.transpose, playlist.copy, channels.delete, audioClip.*) act on it. open also closes, focuses or maximizes a window. Neither of these is undoable.`,
  },
  handlers: {},
};

/** The names of the actions here (they run after the edit, not inside it). */
export const SESSION_OP_NAMES: readonly string[] = session.schemas.map((o) => o.properties.op.const);

type Lines = { ui: string[]; warn: (m: string) => void };

function applySettings(s: Services, a: AiAction, c: OpContext, out: Lines): void {
  const prefs: Partial<PrefsState> = {};
  const text: string[] = [];
  const on = (v: boolean) => (v ? 'on' : 'off');
  const flag = (key: string, pref: keyof PrefsState, label: string) => {
    const v = bool(a[key]);
    if (v === undefined) return;
    (prefs as Record<string, unknown>)[pref] = v;
    text.push(`${label} ${on(v)}`);
  };
  flag('metronome', 'metronome', 'metronome');
  flag('record_notes', 'recordNotes', 'record notes');
  flag('record_audio', 'recordAudio', 'record audio');
  flag('follow_playhead', 'followPlayhead', 'follow playhead');
  flag('tooltips', 'tooltips', 'tooltips');
  flag('typing_piano', 'typingPiano', 'typing piano');
  flag('midi_input', 'midiInput', 'MIDI input');
  flag('monitor', 'audioMonitor', 'input monitoring');
  const countIn = num(a.count_in_bars);
  if (countIn !== undefined) {
    prefs.countInBars = Math.max(0, Math.min(4, Math.round(countIn)));
    text.push(`count-in ${prefs.countInBars} bar${prefs.countInBars === 1 ? '' : 's'}`);
  }
  const rm = (['overdub', 'replace'] as const).find((x) => x === str(a.record_mode));
  if (a.record_mode !== undefined && !rm) out.warn('record_mode must be overdub or replace');
  if (rm) {
    prefs.recordMode = rm;
    text.push(`record mode ${rm}`);
  }
  const grid = str(a.record_quantize);
  if (a.record_quantize !== undefined) {
    const key = Object.keys(RECORD_GRIDS).find((k) => k === grid);
    if (key === undefined) out.warn(`record_quantize must be one of ${Object.keys(RECORD_GRIDS).join(', ')}`);
    else {
      prefs.recordQuantize = RECORD_GRIDS[key]!;
      text.push(`record quantize ${key}`);
    }
  }
  const oct = num(a.piano_octave);
  if (oct !== undefined) {
    prefs.pianoOctave = Math.max(0, Math.min(9, Math.round(oct)));
    text.push(`typing keyboard octave ${prefs.pianoOctave}`);
  }
  const buf = AUDIO_BUFFERS.find((x) => x === str(a.audio_buffer));
  if (a.audio_buffer !== undefined && !buf) out.warn('audio_buffer must be small, medium or large');
  if (buf) {
    prefs.audioBuffer = buf;
    text.push(`audio buffer ${buf}`);
  }
  const mem = num(a.sample_memory_mb);
  if (mem !== undefined) {
    prefs.sampleMemoryMb = Math.max(256, Math.min(16384, Math.round(mem)));
    text.push(`sample memory ${prefs.sampleMemoryMb} MB`);
  }
  const scope = SCOPES.find((x) => x === str(a.scope));
  if (a.scope !== undefined && !scope) out.warn('scope must be scope, spectrum or off');
  if (scope) {
    prefs.scopeMode = scope;
    text.push(`toolbar display ${scope}`);
  }
  const ch = (['mono', 'stereo'] as const).find((x) => x === str(a.input_channels));
  if (a.input_channels !== undefined && !ch) out.warn('input_channels must be mono or stereo');
  if (ch) {
    prefs.audioInputChannels = ch;
    text.push(`input ${ch}`);
  }
  if (a.input_track !== undefined) {
    try {
      const id = c.insert(a.input_track);
      prefs.audioInputTrack = id === 'master' ? '' : id;
      text.push(`input track ${c.project.mixer.inserts[id]?.name ?? id}`);
    } catch (e) {
      out.warn(e instanceof ActionError ? e.message : String(e));
    }
  }
  const lat = num(a.latency_offset_ms);
  if (lat !== undefined) {
    prefs.recordLatencyOffsetMs = Math.max(-200, Math.min(200, lat));
    text.push(`latency correction ${r2(prefs.recordLatencyOffsetMs)} ms`);
  }
  if (isObj(a.export)) {
    const e = exportPatch(a.export, out.warn);
    Object.assign(prefs, e.patch);
    if (e.text.length) text.push(`export ${e.text.join(', ')}`);
  }
  if (Object.keys(prefs).length) s.prefs.getState().set(prefs);

  const editor = s.editor.getState();
  for (const [key, tools, set] of [
    ['piano_roll', PIANO_ROLL_TOOLS, editor.setPianoRoll],
    ['playlist', PLAYLIST_TOOLS, editor.setPlaylist],
  ] as const) {
    const e = a[key];
    if (!isObj(e)) continue;
    const patch: Record<string, unknown> = {};
    const tool = (tools as readonly string[]).find((x) => x === str(e.tool));
    if (e.tool !== undefined && !tool) out.warn(`${key.replace('_', ' ')} tool must be one of ${tools.join(', ')}`);
    if (tool) patch.tool = tool;
    const snap = SNAPS.find((x) => x === str(e.snap));
    if (e.snap !== undefined && !snap) out.warn(`snap must be one of ${SNAPS.join(', ')}`);
    if (snap) patch.snap = snap satisfies Snap;
    if (key === 'piano_roll') {
      if (bool(e.scale_snap) !== undefined) patch.scaleSnap = e.scale_snap;
      if (bool(e.scale_highlight) !== undefined) patch.scaleHighlight = e.scale_highlight;
    }
    if (Object.keys(patch).length) {
      (set as (p: Record<string, unknown>) => void)(patch);
      text.push(`${key.replace('_', ' ')} ${Object.entries(patch).map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => ` ${m.toLowerCase()}`)} ${typeof v === 'boolean' ? on(v) : String(v)}`).join(', ')}`);
    }
  }
  if (text.length) out.ui.push(`Settings: ${text.join(', ')}`);
  else if (!isObj(a.export)) out.warn('nothing to change (give a setting)');
}

/** Clips by ids, or on a track and/or touching bars. */
function pickClips(c: OpContext, p: Project, spec: Record<string, unknown>, warn: (m: string) => void): ClipId[] {
  if (Array.isArray(spec.ids) && spec.ids.length) {
    const ids = spec.ids.map(str).filter((x): x is string => !!x) as ClipId[];
    const found = ids.filter((id) => p.playlist.clips[id]);
    if (!found.length) fail("none of those clips exist");
    if (found.length < ids.length) warn(`${ids.length - found.length} of those clips don't exist`);
    return found;
  }
  const bar = ticksPerBar(p.transport.timeSig);
  const track = spec.track !== undefined ? c.lane(spec.track) : undefined;
  const from = num(spec.from_bar);
  const to = num(spec.to_bar);
  if (!track && from === undefined && to === undefined && spec.all !== true) fail('say which clips: ids, a track, bars, or all');
  const a = from !== undefined ? (Math.max(1, Math.round(from)) - 1) * bar : 0;
  const b = to !== undefined ? Math.max(1, Math.round(to)) * bar : Number.POSITIVE_INFINITY;
  return (Object.values(p.playlist.clips) as Clip[])
    .filter((x) => (!track || x.laneId === track) && x.start < b && x.start + x.length > a)
    .sort((x, y) => x.start - y.start || x.id.localeCompare(y.id))
    .map((x) => x.id);
}

function applySelect(s: Services, a: AiAction, c: OpContext, out: Lines): void {
  const p = c.project;
  const parts: string[] = [];
  const view = s.view.getState();
  const editor = s.editor.getState();
  const session = s.session.getState();
  const step = <T,>(f: () => T): T | undefined => {
    try {
      return f();
    } catch (e) {
      if (e instanceof ActionError) {
        out.warn(e.message);
        return undefined;
      }
      throw e;
    }
  };
  if (a.channel !== undefined) {
    const id = step(() => c.channel(a.channel));
    if (id) {
      session.selectChannel(id);
      parts.push(`channel “${p.channels[id]!.name}”`);
    }
  }
  if (a.insert !== undefined) {
    const id = step(() => c.insert(a.insert));
    if (id) {
      session.selectInsert(id === 'master' ? null : id);
      parts.push(`mixer track “${p.mixer.inserts[id]?.name ?? id}”`);
    }
  }
  if (a.pattern !== undefined) {
    const id = step(() => c.pattern(a.pattern));
    if (id) {
      view.setCurrentPattern(id);
      parts.push(`pattern “${p.patterns[id]!.name}”`);
    }
  }
  if (isObj(a.clips)) {
    const ids = step(() => pickClips(c, p, a.clips as Record<string, unknown>, out.warn));
    if (ids) {
      editor.selectClips(ids);
      parts.push(`${ids.length} clip${ids.length === 1 ? '' : 's'}`);
    }
  }
  if (isObj(a.notes)) {
    const spec = a.notes;
    step(() => {
      const pid: PatternId =
        spec.pattern !== undefined ? c.pattern(spec.pattern) : (s.view.getState().currentPatternId ?? c.pattern('current'));
      const cid: ChannelId =
        spec.channel !== undefined
          ? c.channel(spec.channel)
          : (s.session.getState().selectedChannelId ?? fail('which channel? (the notes belong to a channel)'));
      const pat = p.patterns[pid]!;
      const ch = p.channels[cid]!;
      if (ch.kind !== 'instrument') fail(`“${ch.name}” has no notes`);
      const bar = ticksPerBar(p.transport.timeSig);
      const from = num(spec.from_bar);
      const to = num(spec.to_bar);
      const lo = from !== undefined ? (Math.max(1, Math.round(from)) - 1) * bar : 0;
      const hi = to !== undefined ? Math.max(1, Math.round(to)) * bar : Number.POSITIVE_INFINITY;
      const k0 = num(spec.from_key) ?? 0;
      const k1 = num(spec.to_key) ?? 127;
      const ids = Object.values(pat.notes[cid] ?? {})
        .filter((n) => n.tick >= lo && n.tick < hi && n.key >= Math.min(k0, k1) && n.key <= Math.max(k0, k1))
        .sort((x, y) => x.tick - y.tick || x.key - y.key)
        .map((n) => n.id as NoteId);
      view.setCurrentPattern(pid);
      session.selectChannel(cid);
      editor.selectNotes(ids);
      parts.push(`${ids.length} note${ids.length === 1 ? '' : 's'} of “${ch.name}” in “${pat.name}”`);
    });
  }
  if (isObj(a.loop)) {
    const spec = a.loop;
    step(() => {
      const bar = ticksPerBar(p.transport.timeSig);
      const section = str(spec.section);
      const from = num(spec.from_bar);
      const to = num(spec.to_bar);
      let start: number;
      let end: number;
      if (section) {
        const markers = Object.values(p.playlist.markers);
        const m = markers.find((x) => lower(x.name) === lower(section)) ?? markers.find((x) => lower(x.name).startsWith(lower(section)));
        if (!m) return fail(`there is no marker “${section}”`);
        const t = markerTarget(p, m.id);
        if (!t) return fail(`“${section}” has no section (it needs a marker after it, or songs to end it)`);
        start = t.from;
        end = t.to;
      } else if (from !== undefined) {
        start = (Math.max(1, Math.round(from)) - 1) * bar;
        end = Math.max(1, Math.round(to ?? from)) * bar;
      } else return fail('the loop needs from_bar and to_bar, or a section');
      if (end <= start) return fail('the loop must end after it starts');
      view.setLoop({ start, end });
      parts.push(`loop bars ${r2(start / bar + 1)}–${r2(end / bar)}`);
    });
  }
  const clear = str(a.clear);
  if (a.clear !== undefined && !['clips', 'notes', 'loop', 'all'].includes(clear ?? '')) out.warn('clear must be clips, notes, loop or all');
  if (clear === 'clips' || clear === 'all') {
    editor.selectClips([]);
    parts.push('no clips');
  }
  if (clear === 'notes' || clear === 'all') {
    editor.selectNotes([]);
    parts.push('no notes');
  }
  if (clear === 'loop' || clear === 'all') {
    view.setLoop(null);
    parts.push('no loop');
  }
  if (parts.length) out.ui.push(`Selected ${parts.join(', ')}`);
  else if (a.clear === undefined) out.warn('select what? (channel, insert, pattern, clips, notes, loop or clear)');
}

function applySavePreset(s: Services, a: AiAction, c: OpContext, out: Lines): void {
  const name = str(a.name) ?? fail('the preset needs a name');
  let owner: PluginOwner;
  let inst;
  if (a.effect !== undefined) {
    const e = c.effect(a.effect);
    owner = { kind: 'fx', insertId: e.insertId, slotId: e.slotId };
    inst = c.project.mixer.inserts[e.insertId]!.fx.find((f) => f.id === e.slotId)!.plugin;
  } else {
    const ch = c.project.channels[c.channel(a.channel)]!;
    if (ch.kind !== 'instrument') return fail(`“${ch.name}” has no instrument to save`);
    owner = { kind: 'channel', channelId: ch.id };
    inst = ch.plugin;
  }
  const def = s.plugins.get(inst.pluginId) ?? fail(`the plugin ${inst.pluginId} isn't installed`);
  const saved = s.presets.save({
    pluginId: def.id,
    version: def.version,
    name,
    params: structuredClone({ ...inst.params }),
    ...(inst.state !== undefined ? { state: structuredClone(inst.state) as never } : {}),
  });
  s.presets.noteLoaded(owner, saved.name);
  out.ui.push(`Saved ${def.name} preset “${saved.name}”`);
}

/** Runs the answer's settings, selection and preset actions (after its edits are committed). */
export function sessionAfter(s: Services, answer: AiAnswer, state: AnswerState): void {
  const wanted = answer.actions.filter((a) => SESSION_OP_NAMES.includes(a.op));
  if (!wanted.length) return;
  const c = createOpContext(s, s.doc.getState().project as unknown as Draft<Project>, answer, { previousBeat: null }, state);
  for (const a of wanted) {
    const label = a.op.replace(/_/g, ' ');
    const out: Lines = { ui: state.ui, warn: (m) => state.warnings.push(`${label}: ${m}`) };
    try {
      if (a.op === 'settings') applySettings(s, a, c, out);
      else if (a.op === 'select') applySelect(s, a, c, out);
      else if (a.op === 'save_preset') applySavePreset(s, a, c, out);
    } catch (e) {
      if (e instanceof ActionError) out.warn(e.message);
      else throw e;
    }
  }
}
