/**
 * Maps a parsed FL Studio project (`flp.ts`) onto a new AGstudio Project, with a report of what
 * came across and what didn't. Pure: plugin defaults and the resolved samples come from the caller.
 *
 * - Ticks are rescaled from the file's PPQ to 960. Notes keep velocity, pan, release and fine pitch.
 * - Channels keep their FL order, names, colours, volume, pan, pitch, root key and mixer insert.
 *   Sampler channels get their sample; a sampler that only appears as playlist clips (and has no
 *   notes) is FL's audio clip channel. Other generators get the closest built-in instrument
 *   ("stand-in"); FL plugin settings are not read, so every plugin starts from its default sound.
 * - Layer channels have no sound of their own: their notes go to each child channel.
 * - Patterns keep their FL numbers' order, names and colours. FL pattern clips don't repeat their
 *   content, so a pattern gets an explicit length when a clip reaches past its content.
 * - The playlist of the arrangement that was open (FL 12.9+ has several) becomes the playlist:
 *   pattern, audio and automation clips on the same tracks, track names/colours, time markers.
 * - Mixer inserts keep their numbers, names, colours, volume, pan, routing and the effects that have
 *   a built-in counterpart.
 */
import type { ParamValue } from '@agstudio/sdk/params';
import { createEmptyProject, makeInsert, makeLane, makePattern, masterRoutes, paletteColor } from '../model/defaults';
import { faderToGain } from '../model/fader';
import { newId } from '../model/ids';
import { KIT_VERSION, kitPiece } from '../model/kit';
import {
  MASTER,
  type AudioClipChannel,
  type AutomationChannel,
  type Channel,
  type ChannelId,
  type Clip,
  type FxSlot,
  type Insert,
  type InsertId,
  type InstrumentChannel,
  type LaneId,
  type Marker,
  type Note,
  type ParamTarget,
  type Pattern,
  type PatternId,
  type PluginInstance,
  type Project,
  type SampleRef,
  type TimeSignature,
} from '../model/types';
import { PPQ, ceilToBars } from '../time/ppq';
import {
  FLP_CHANNEL_TYPE,
  FLP_INSERT_ENABLED,
  FLP_NOTE_SLIDE,
  flpFileName,
  type FlpArrangement,
  type FlpChannel,
  type FlpProject,
  type FlpSlot,
  type FlpVst,
} from './flp';

/** Built-in plugin ids the importer uses. */
export const FLP_PLUGIN = {
  sampler: 'agstudio.sampler',
  threeOsc: 'agstudio.3xosc',
  wavetable: 'agstudio.wavetable',
  fm: 'agstudio.fm',
  bass808: 'agstudio.bass808',
  drumPads: 'agstudio.drum-pads',
  drumSynth: 'agstudio.drum-synth',
  pluck: 'agstudio.pluck',
  slicer: 'agstudio.slicer',
} as const;

export interface FlpPluginInfo {
  version: number;
  /** Default param values. */
  params: Record<string, ParamValue>;
  /** Display name ("Wavetable"). */
  name: string;
}

export interface FlpResolvedSample {
  /** The sample to reference. A missing file still gets a ref (named after it, with no audio). */
  ref: SampleRef;
  /** The audio was found (in the package) and stored. */
  found: boolean;
}

export interface FlpImportOptions {
  /** The imported file's name (the project title when FL's is empty). */
  fileName: string;
  /** Built-in plugin lookup: defaults and name, undefined when not installed. */
  plugin(id: string): FlpPluginInfo | undefined;
  /** Resolved samples by FL sample path (see flpSamplePaths). */
  samples: ReadonlyMap<string, FlpResolvedSample>;
  /** Whether the samples came with the file (a zipped loop package); only changes the advice. */
  fromPackage?: boolean;
  now?: Date;
}

export interface FlpStandIn {
  channel: string;
  /** The FL plugin ("Serum", "Sytrus"). */
  plugin: string;
  /** The built-in that plays instead. */
  using: string;
  vst: boolean;
}

export interface FlpImportReport {
  title: string;
  flVersion: string;
  channels: number;
  patterns: number;
  notes: number;
  clips: number;
  markers: number;
  inserts: number;
  effects: number;
  /** The imported arrangement's name, or null for files without arrangements (before FL 12.9). */
  arrangement: string | null;
  /** Arrangements that weren't imported. */
  otherArrangements: string[];
  standIns: FlpStandIn[];
  missingSamples: { channel: string; file: string; path: string }[];
  /** Effects with a built-in counterpart (FL name → built-in). */
  effectStandIns: { insert: string; plugin: string; using: string }[];
  skippedEffects: { insert: string; plugin: string }[];
  /** Automation clips that came in without a target (FL's target couldn't be matched). */
  untargetedAutomation: string[];
  /** Layer channels whose notes went to their children. */
  layers: { channel: string; children: number }[];
  slideNotes: number;
  /** Notes on channels that don't exist (or can't play notes). */
  orphanNotes: number;
  /** Playlist clips that couldn't be placed. */
  skippedClips: number;
  /** Reader warnings (cut-off file, caps). */
  warnings: string[];
}

export interface FlpImportResult {
  project: Project;
  report: FlpImportReport;
  /** The pattern to show first. */
  firstPatternId: PatternId;
  /** True when the playlist has clips (open in song mode). */
  hasSong: boolean;
}

const MAX_INSERTS = 125;
const MAX_LANES = 500;
const MIN_LANES = 32;
const MIN_INSERTS = 16;
const NAME_MAX = 64;
const STEP_MAX = 512;

const KEYS_3XOSC: Record<string, ParamValue> = {
  osc1Wave: 'triangle',
  osc2Wave: 'sine',
  osc2Level: 0.4,
  attack: 0.003,
  decay: 0.9,
  sustain: 0.25,
  release: 0.4,
  cutoff: 3500,
  filterEnv: 0.8,
};

interface Choice {
  pluginId: string;
  /** A built-in kit sound to load into a sampler stand-in. */
  kit?: string;
  params?: Record<string, ParamValue>;
  /** False when the built-in is FL's own plugin's counterpart (no "stand-in" label). */
  standIn: boolean;
}

/** A single drum sound named in a channel name → kit generator. */
function kitFromName(name: string): string | undefined {
  const n = name.toLowerCase();
  if (/open ?h(i ?)?hat|\boh\b|hat ?open/.test(n)) return 'kit/hat-open';
  if (/h(i ?)?hat|\bhh\b|\bch\b/.test(n)) return 'kit/hat-closed';
  if (/\bkick|\bkik\b|\bbd\b|bass ?drum/.test(n)) return 'kit/kick';
  if (/snare|\bsnr\b|\bsd\b/.test(n)) return 'kit/snare';
  if (/clap/.test(n)) return 'kit/clap';
  if (/crash|cymbal|\bride\b/.test(n)) return 'kit/crash';
  if (/\brim/.test(n)) return 'kit/rim';
  if (/cowbell/.test(n)) return 'kit/cowbell';
  if (/low ?tom|tom ?low|floor ?tom/.test(n)) return 'kit/tom-low';
  if (/hi(gh)? ?tom|tom ?hi/.test(n)) return 'kit/tom-high';
  if (/\btom/.test(n)) return 'kit/tom-mid';
  return undefined;
}

const DRUMS =
  /\bdrums?\b|\bkit\b|\bperc|\bfpc\b|battery|addictive drums|ezdrummer|superior drummer|steven slate|\bxo\b/;

/** FL native generators (internal names, lowercase) → built-in. */
const NATIVE: Record<string, Choice> = {
  '3x osc': { pluginId: FLP_PLUGIN.threeOsc, standIn: false },
  'fl keys': { pluginId: FLP_PLUGIN.threeOsc, params: KEYS_3XOSC, standIn: true },
  fpc: { pluginId: FLP_PLUGIN.drumPads, standIn: true },
  'fruity drumsynth live': { pluginId: FLP_PLUGIN.drumSynth, standIn: true },
  drumaxx: { pluginId: FLP_PLUGIN.drumSynth, standIn: true },
  'fruit kick': { pluginId: FLP_PLUGIN.sampler, kit: 'kit/kick', standIn: true },
  sytrus: { pluginId: FLP_PLUGIN.fm, standIn: true },
  'toxic biohazard': { pluginId: FLP_PLUGIN.fm, standIn: true },
  'fruity dx10': { pluginId: FLP_PLUGIN.fm, standIn: true },
  'plucked!': { pluginId: FLP_PLUGIN.pluck, standIn: true },
  sakura: { pluginId: FLP_PLUGIN.pluck, standIn: true },
  'fl slayer': { pluginId: FLP_PLUGIN.pluck, standIn: true },
  'fruity slicer': { pluginId: FLP_PLUGIN.slicer, standIn: true },
  slicex: { pluginId: FLP_PLUGIN.slicer, standIn: true },
  directwave: { pluginId: FLP_PLUGIN.sampler, standIn: true },
  'fruity granulizer': { pluginId: FLP_PLUGIN.sampler, standIn: true },
};

/** A VST/AU instrument's name → built-in. */
function vstChoice(name: string): Choice {
  const n = name.toLowerCase();
  if (/808/.test(n)) return { pluginId: FLP_PLUGIN.bass808, standIn: true };
  if (DRUMS.test(n)) return { pluginId: FLP_PLUGIN.drumPads, standIn: true };
  if (/piano|keys|keyscape|pianoteq|ivory|grand|rhodes|wurli|organ/.test(n))
    return { pluginId: FLP_PLUGIN.threeOsc, params: KEYS_3XOSC, standIn: true };
  if (/fm8|dexed|\bfm\b|operator|opal/.test(n)) return { pluginId: FLP_PLUGIN.fm, standIn: true };
  if (/pluck|guitar|harp|koto|kalimba/.test(n)) return { pluginId: FLP_PLUGIN.pluck, standIn: true };
  return { pluginId: FLP_PLUGIN.wavetable, standIn: true };
}

/** Is this channel FL's Sampler (or an audio clip channel, which looks the same)? */
function isSamplerChannel(c: FlpChannel): boolean {
  const n = (c.internalName ?? '').trim().toLowerCase();
  return n === '' || n === 'sampler' || n === 'audio clip' || n === 'audioclip';
}

function isVst(c: { internalName?: string }): boolean {
  return (c.internalName ?? '').trim().toLowerCase() === 'fruity wrapper';
}

/** The FL plugin's name as people know it: the VST's own name, else the internal name. */
function pluginLabel(c: { internalName?: string; vst?: FlpVst; name?: string }): string {
  if (isVst(c)) return c.vst?.name || c.name || 'VST plugin';
  return c.internalName || 'plugin';
}

/** Generator → built-in: names first (808s, single drums, drum kits), then the plugin. */
function generatorChoice(c: FlpChannel, name: string): Choice {
  const lower = name.toLowerCase();
  const internal = (c.internalName ?? '').trim().toLowerCase();
  const exact = NATIVE[internal];
  if (exact && !exact.standIn) return exact;
  if (/808/.test(lower)) return { pluginId: FLP_PLUGIN.bass808, standIn: true };
  const kit = kitFromName(name);
  if (kit && internal !== 'fpc') return { pluginId: FLP_PLUGIN.sampler, kit, standIn: true };
  if (DRUMS.test(lower)) return { pluginId: FLP_PLUGIN.drumPads, standIn: true };
  if (exact) return exact;
  if (isVst(c)) return vstChoice(c.vst?.name || c.name || '');
  return { pluginId: FLP_PLUGIN.wavetable, standIn: true };
}

/** FL native effects (internal names, lowercase) → built-in effect id. */
const EFFECTS: Record<string, string> = {
  'fruity limiter': 'agstudio.limiter',
  'fruity compressor': 'agstudio.compressor',
  'fruity multiband compressor': 'agstudio.multiband',
  maximus: 'agstudio.multiband',
  soundgoodizer: 'agstudio.multiband',
  'fruity parametric eq 2': 'agstudio.eq-pro',
  'fruity parametric eq': 'agstudio.eq-pro',
  'fruity 7 band eq': 'agstudio.eq',
  'fruity reeverb 2': 'agstudio.reverb',
  'fruity reeverb': 'agstudio.reverb',
  'fruity reverb 2': 'agstudio.reverb',
  'fruity convolver': 'agstudio.reverb',
  'fruity delay 3': 'agstudio.delay',
  'fruity delay 2': 'agstudio.delay',
  'fruity delay': 'agstudio.delay',
  'fruity delay bank': 'agstudio.delay',
  'fruity chorus': 'agstudio.chorus',
  'fruity flanger': 'agstudio.flanger',
  'fruity flangus': 'agstudio.flanger',
  'fruity phaser': 'agstudio.phaser',
  'fruity filter': 'agstudio.filter',
  'fruity love philter': 'agstudio.filter',
  'fruity free filter': 'agstudio.filter',
  'fruity fast dist': 'agstudio.distortion',
  'fruity blood overdrive': 'agstudio.distortion',
  distructor: 'agstudio.distortion',
  'fruity waveshaper': 'agstudio.distortion',
  'fruity soft clipper': 'agstudio.saturator',
  'fruity squeeze': 'agstudio.lofi',
  'fruity stereo enhancer': 'agstudio.stereo',
  'fruity stereo shaper': 'agstudio.stereo',
  'transient processor': 'agstudio.transient',
  'fruity vocoder': 'agstudio.vocoder',
  vocodex: 'agstudio.vocoder',
  pitcher: 'agstudio.tune',
  newtone: 'agstudio.tune',
  'fruity spectroman': 'agstudio.analyzer',
  'wave candy': 'agstudio.analyzer',
  'gross beat': 'agstudio.stutter',
};

/** A VST effect's name → built-in, only where the kind is plain from the name. */
function vstEffect(name: string): string | undefined {
  const n = name.toLowerCase();
  if (/verb|\broom\b|\bhall\b|plate/.test(n)) return 'agstudio.reverb';
  if (/delay|echo/.test(n)) return 'agstudio.delay';
  if (/limit/.test(n)) return 'agstudio.limiter';
  if (/multiband|ott/.test(n)) return 'agstudio.multiband';
  if (/comp|1176|la-2a|\bcla\b/.test(n)) return 'agstudio.compressor';
  if (/\beq\b|pro-q|equal/.test(n)) return 'agstudio.eq-pro';
  if (/chorus/.test(n)) return 'agstudio.chorus';
  if (/phaser/.test(n)) return 'agstudio.phaser';
  if (/flang/.test(n)) return 'agstudio.flanger';
  if (/satur|tape|decapitator/.test(n)) return 'agstudio.saturator';
  if (/distort|overdrive|fuzz/.test(n)) return 'agstudio.distortion';
  if (/auto-?tune|melodyne|pitch correct/.test(n)) return 'agstudio.tune';
  return undefined;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const trimName = (s: string) => (s.length > NAME_MAX ? s.slice(0, NAME_MAX - 1).trimEnd() + '…' : s);
const stem = (file: string) => file.replace(/\.[^.]+$/, '');

/** Reads the FL project into a new Project (ids from `newId`). */
export function flpToProject(flp: FlpProject, opts: FlpImportOptions): FlpImportResult {
  const scale = PPQ / flp.ppq;
  const tick = (t: number) => Math.max(0, Math.round(t * scale));
  const baseName = opts.fileName.replace(/\.(flp|zip)$/i, '').trim() || 'FL Studio project';
  const title = trimName(flp.title?.trim() || baseName);
  const project = createEmptyProject({ title, ...(opts.now ? { now: opts.now } : {}) });
  if (flp.artist?.trim()) project.meta.author = flp.artist.trim();
  project.transport.bpm = flp.tempo !== null ? clamp(Math.round(flp.tempo * 1000) / 1000, 10, 522) : 140;
  if (flp.timeSig) {
    const num = clamp(Math.round(flp.timeSig.num), 1, 16);
    const den = [2, 4, 8, 16].includes(flp.timeSig.beat) ? flp.timeSig.beat : 4;
    project.transport.timeSig = { num, den };
  }
  const ts: TimeSignature = project.transport.timeSig;

  const report: FlpImportReport = {
    title,
    flVersion: flp.version,
    channels: 0,
    patterns: 0,
    notes: 0,
    clips: 0,
    markers: 0,
    inserts: 0,
    effects: 0,
    arrangement: null,
    otherArrangements: [],
    standIns: [],
    missingSamples: [],
    effectStandIns: [],
    skippedEffects: [],
    untargetedAutomation: [],
    layers: [],
    slideNotes: 0,
    orphanNotes: 0,
    skippedClips: 0,
    warnings: [...flp.warnings],
  };

  const pluginInstance = (id: string, extra: Partial<PluginInstance> = {}): PluginInstance => {
    const info = opts.plugin(id);
    return { pluginId: id, pluginVersion: info?.version ?? 1, params: { ...(info?.params ?? {}) }, ...extra };
  };
  const pluginName = (id: string) => opts.plugin(id)?.name ?? id.replace(/^agstudio\./, '');

  // --- The arrangement ------------------------------------------------------------------------
  const arrangements = flp.arrangements;
  let arrangement: FlpArrangement | undefined =
    (flp.currentArrangement !== null ? arrangements.find((a) => a.index === flp.currentArrangement) : undefined) ??
    arrangements.find((a) => a.items.length > 0) ??
    arrangements[0];
  if (!arrangement) arrangement = { index: 0, items: [], tracks: [], markers: [] };
  const named = (a: FlpArrangement) => a.name || `Arrangement ${a.index + 1}`;
  if (arrangements.length > 1 || (arrangement.name && arrangements.length === 1))
    report.arrangement = named(arrangement);
  for (const a of arrangements)
    if (a !== arrangement && (a.items.length > 0 || a.name)) report.otherArrangements.push(named(a));

  // --- Mixer ----------------------------------------------------------------------------------
  const channelInserts = flp.channels.map((c) => c.insert ?? 0).filter((i) => i > 0);
  const used = (i: number) => {
    const ins = flp.inserts[i];
    return !!ins && (!!ins.name || ins.slots.length > 0);
  };
  let insertCount = Math.max(MIN_INSERTS, ...channelInserts);
  for (let i = 1; i < flp.inserts.length; i++) if (used(i)) insertCount = Math.max(insertCount, i);
  insertCount = Math.min(MAX_INSERTS, insertCount);
  const insertIds: InsertId[] = [];
  const inserts: Record<InsertId, Insert> = {};
  // Only trust the "enabled" flag when the file uses it at all (a wrong guess would mute everything).
  const enabledFlagInUse = flp.inserts.some((i) => i.flags !== undefined && (i.flags & FLP_INSERT_ENABLED) !== 0);
  const routingInUse = flp.inserts.some((i) => i.routing?.some(Boolean));
  for (let i = 0; i <= insertCount; i++) {
    const fl = flp.inserts[i];
    const id = i === 0 ? MASTER : newId.insert();
    const ins = makeInsert(id, trimName(fl?.name || (i === 0 ? 'Master' : `Insert ${i}`)));
    if (fl?.color && fl.name) ins.color = fl.color;
    if (fl?.volume !== undefined) ins.volume = faderToGain(fl.volume / 16000);
    if (fl?.pan !== undefined) ins.pan = clamp(fl.pan / 6400, -1, 1);
    if (enabledFlagInUse && fl?.flags !== undefined && i > 0) ins.muted = (fl.flags & FLP_INSERT_ENABLED) === 0;
    insertIds.push(id);
    inserts[id] = ins;
  }
  for (let i = 1; i <= insertCount; i++) {
    const fl = flp.inserts[i];
    const ins = inserts[insertIds[i] as InsertId] as Insert;
    if (!routingInUse || !fl?.routing) continue;
    const routes: Insert['routes'] = [];
    fl.routing.forEach((on, j) => {
      if (!on || j === i || j > insertCount) return;
      // Keep the graph acyclic: skip a route whose target already feeds this insert.
      if (reaches(inserts, insertIds[j] as InsertId, ins.id)) return;
      const level = fl.sends[j];
      routes.push({
        to: insertIds[j] as InsertId,
        level: level !== undefined ? clamp(faderToGain(level / 16000), 0, 4) : 1,
        pre: false,
      });
    });
    ins.routes = routes.length > 0 ? routes : masterRoutes(ins.id);
  }
  // Effects.
  for (let i = 0; i <= insertCount; i++) {
    const fl = flp.inserts[i];
    if (!fl) continue;
    const ins = inserts[insertIds[i] as InsertId] as Insert;
    const slots = [...fl.slots].sort((a, b) => a.index - b.index);
    for (const s of slots) {
      const mapped = effectFor(s);
      const label = pluginLabel(s);
      if (!mapped || !opts.plugin(mapped)) {
        report.skippedEffects.push({ insert: ins.name, plugin: label });
        continue;
      }
      const slot: FxSlot = {
        id: newId.slot(),
        plugin: pluginInstance(mapped),
        enabled: s.enabled ?? true,
        mix: 1,
        sidechain: null,
      };
      ins.fx.push(slot);
      report.effects++;
      if (isVst(s)) report.effectStandIns.push({ insert: ins.name, plugin: label, using: pluginName(mapped) });
    }
  }
  project.mixer = { inserts, order: insertIds };
  report.inserts = flp.inserts.filter((x, i) => i > 0 && i <= insertCount && used(i)).length;
  const insertFor = (n: number | undefined): InsertId =>
    n && n > 0 && n <= insertCount ? (insertIds[n] as InsertId) : MASTER;

  // --- Channels -------------------------------------------------------------------------------
  const notesByChannel = new Set<number>();
  for (const p of flp.patterns) for (const n of p.notes) notesByChannel.add(n.channel);
  const inPlaylist = new Set<number>();
  for (const it of arrangement.items) if (it.kind === 'channel') inPlaylist.add(it.ref);

  const byIid = new Map<number, ChannelId>();
  const layers = new Map<number, number[]>();
  const channels: Channel[] = [];
  const samples: Record<string, SampleRef> = {};
  const flChannels = [...flp.channels].sort((a, b) => a.iid - b.iid);
  const sampleFor = (path: string | undefined, channelName: string): SampleRef | undefined => {
    if (!path) return undefined;
    const res = opts.samples.get(path);
    if (!res?.found) report.missingSamples.push({ channel: channelName, file: flpFileName(path) || path, path });
    if (!res) return undefined;
    samples[res.ref.id] = res.ref;
    return res.ref;
  };

  flChannels.forEach((c, index) => {
    const color = c.color ?? paletteColor(index);
    const fallbackName = c.samplePath ? stem(flpFileName(c.samplePath)) : c.internalName || `Channel ${c.iid + 1}`;
    const name = trimName(c.name?.trim() || fallbackName);
    const base = { name, color, muted: !c.enabled, solo: false };
    const volume = c.volume !== undefined ? clamp(c.volume / 12800, 0, 1.25) : 0.78;
    const pan = c.pan !== undefined ? clamp((c.pan - 6400) / 6400, -1, 1) : 0;
    const pitch = c.pitch ? clamp(Math.round(c.pitch), -2400, 2400) : 0;
    const output = insertFor(c.insert);

    if (c.type === FLP_CHANNEL_TYPE.layer) {
      layers.set(c.iid, c.children);
      report.layers.push({ channel: name, children: c.children.length });
      return;
    }
    if (c.type === FLP_CHANNEL_TYPE.automation || (c.type === null && c.automation)) {
      const ch: AutomationChannel = {
        kind: 'automation',
        id: newId.channel(),
        ...base,
        target: null,
        points: (c.automation ?? [])
          .map((pt) => ({
            tick: Math.max(0, Math.round(pt.beats * PPQ)),
            value: clamp(pt.value, 0, 1),
            ...(pt.tension ? { tension: clamp(pt.tension, -1, 1) } : {}),
          }))
          .sort((a, b) => a.tick - b.tick),
      };
      byIid.set(c.iid, ch.id);
      channels.push(ch);
      return;
    }
    if (isSamplerChannel(c) && c.type !== FLP_CHANNEL_TYPE.instrument) {
      const ref = sampleFor(c.samplePath, name);
      if (ref && inPlaylist.has(c.iid) && !notesByChannel.has(c.iid)) {
        const ch: AudioClipChannel = {
          kind: 'audioClip',
          id: newId.channel(),
          ...base,
          volume,
          pan,
          output,
          sampleId: ref.id,
          ...(pitch ? { pitch } : {}),
        };
        byIid.set(c.iid, ch.id);
        channels.push(ch);
        return;
      }
      const ch: InstrumentChannel = {
        kind: 'instrument',
        id: newId.channel(),
        ...base,
        volume,
        pan,
        output,
        plugin: pluginInstance(FLP_PLUGIN.sampler, ref ? { samples: { main: ref.id } } : {}),
        rootKey: clamp(Math.round(c.rootNote ?? 60), 0, 127),
        ...(pitch ? { pitch } : {}),
      };
      byIid.set(c.iid, ch.id);
      channels.push(ch);
      return;
    }
    // A generator plugin (or an instrument channel with a sample-less sampler).
    let choice = isSamplerChannel(c) ? { pluginId: FLP_PLUGIN.sampler, standIn: false } : generatorChoice(c, name);
    if (!opts.plugin(choice.pluginId)) choice = { pluginId: FLP_PLUGIN.threeOsc, standIn: true };
    const extra: Partial<PluginInstance> = {};
    if (choice.kit && kitPiece(choice.kit)) {
      const ref: SampleRef = {
        id: newId.sample(),
        name: kitPiece(choice.kit)?.name ?? choice.kit,
        source: { kind: 'builtin', generator: choice.kit, version: KIT_VERSION },
      };
      samples[ref.id] = ref;
      extra.samples = { main: ref.id };
    }
    const plugin = pluginInstance(choice.pluginId, extra);
    if (choice.params) for (const [k, v] of Object.entries(choice.params)) if (k in plugin.params) plugin.params[k] = v;
    let chName = name;
    if (choice.standIn) {
      const flName = pluginLabel(c);
      report.standIns.push({ channel: name, plugin: flName, using: pluginName(choice.pluginId), vst: isVst(c) });
      chName = flName.toLowerCase() === name.toLowerCase() ? `${name} (stand-in)` : `${name} (stand-in for ${flName})`;
    }
    const ch: InstrumentChannel = {
      kind: 'instrument',
      id: newId.channel(),
      ...base,
      name: trimName(chName),
      volume,
      pan,
      output,
      plugin,
      // Kit stand-ins play their sound at the root key, so FL's notes (on any key) keep sounding.
      rootKey: clamp(Math.round(c.rootNote ?? 60), 0, 127),
      ...(pitch ? { pitch } : {}),
    };
    byIid.set(c.iid, ch.id);
    channels.push(ch);
  });

  // Automation targets (FL keeps them apart from the clip): channel volume/pan.
  for (const ch of channels) {
    if (ch.kind !== 'automation') continue;
    const iid = [...byIid].find(([, id]) => id === ch.id)?.[0];
    const link = flp.automationLinks.find((l) => l.channel === iid);
    let target: ParamTarget | null = null;
    if (link && (link.destination & 0x2000) === 0) {
      const to = byIid.get(link.destination);
      const toCh = to ? channels.find((x) => x.id === to) : undefined;
      const param = link.param & 0x7fff;
      if (toCh && toCh.kind !== 'automation' && (param === 0 || param === 1))
        target = { kind: 'channel', channelId: toCh.id, param: param === 0 ? 'volume' : 'pan' };
    }
    ch.target = target;
    if (!target) report.untargetedAutomation.push(ch.name);
  }

  project.channels = {};
  project.channelOrder = [];
  for (const ch of channels) {
    project.channels[ch.id] = ch;
    project.channelOrder.push(ch.id);
  }
  project.samples = samples as Project['samples'];
  report.channels = channels.length;

  // --- Patterns -------------------------------------------------------------------------------
  const patternIds = new Map<number, PatternId>();
  const patterns: Record<PatternId, Pattern> = {};
  const patternOrder: PatternId[] = [];
  const playable = (iid: number): ChannelId[] => {
    const kids = layers.get(iid);
    const ids = kids ? kids.map((k) => byIid.get(k)) : [byIid.get(iid)];
    return ids.filter((id): id is ChannelId => !!id && project.channels[id]?.kind === 'instrument');
  };
  const contentEnd = new Map<PatternId, number>();
  const flPatterns = [...flp.patterns].sort((a, b) => a.iid - b.iid);
  flPatterns.forEach((fp, index) => {
    const id = newId.pattern();
    const pat = makePattern(trimName(fp.name?.trim() || `Pattern ${fp.iid}`), fp.color ?? paletteColor(index), id);
    let end = 0;
    for (const n of fp.notes) {
      if (n.flags & FLP_NOTE_SLIDE) {
        report.slideNotes++;
        continue;
      }
      const targets = playable(n.channel);
      if (targets.length === 0) {
        report.orphanNotes++;
        continue;
      }
      const start = tick(n.position);
      const length = Math.max(1, Math.round(n.length * scale));
      for (const cid of targets) {
        const note: Note = {
          id: newId.note(),
          tick: start,
          length,
          key: clamp(n.key, 0, 127),
          velocity: clamp(n.velocity / 128, 0, 1),
        };
        if (n.pan !== 64) note.pan = clamp((n.pan - 64) / 64, -1, 1);
        if (n.release !== 64) note.release = clamp(n.release / 128, 0, 1);
        // Fine pitch 0–240 around 120: read as ±1 semitone (FL's per-note fine pitch range).
        if (n.fine !== 120) {
          const cents = Math.round(((n.fine - 120) * 100) / 120);
          if (cents !== 0) note.fine = clamp(cents, -100, 100);
        }
        (pat.notes[cid] ??= {})[note.id] = note;
        report.notes++;
      }
      end = Math.max(end, start + length);
    }
    contentEnd.set(id, end);
    pat.stepCount = clamp(Math.round(ceilToBars(end, ts) / 240), 16, STEP_MAX);
    patternIds.set(fp.iid, id);
    patterns[id] = pat;
    patternOrder.push(id);
  });
  if (patternOrder.length > 0) {
    project.patterns = patterns;
    project.patternOrder = patternOrder;
  }
  report.patterns = patternOrder.length;

  // --- Playlist -------------------------------------------------------------------------------
  const tracks = arrangement.tracks;
  const maxTrackUsed = Math.max(
    -1,
    ...arrangement.items.map((i) => i.track),
    ...tracks.filter((t) => t.name).map((t) => t.index),
  );
  const laneCount = clamp(maxTrackUsed + 1, MIN_LANES, MAX_LANES);
  const laneIds: LaneId[] = [];
  project.playlist = { lanes: {}, laneOrder: [], clips: {}, markers: {} };
  for (let i = 0; i < laneCount; i++) {
    const t = tracks[i];
    const lane = makeLane(trimName(t?.name || `Track ${i + 1}`));
    if (t?.name && t.color) lane.color = t.color;
    if (t && !t.enabled) lane.muted = true;
    project.playlist.lanes[lane.id] = lane;
    project.playlist.laneOrder.push(lane.id);
    laneIds.push(lane.id);
  }
  const clipNeed = new Map<PatternId, number>();
  const bpm = project.transport.bpm;
  for (const it of arrangement.items) {
    const laneId = laneIds[it.track];
    if (!laneId) {
      report.skippedClips++;
      continue;
    }
    const start = tick(it.position);
    const length = Math.max(1, Math.round(it.length * scale));
    let clip: Clip | null = null;
    if (it.kind === 'pattern') {
      const patternId = patternIds.get(it.ref);
      if (patternId) {
        const offset = it.startOffset !== null ? tick(it.startOffset) : 0;
        clip = { kind: 'pattern', id: newId.clip(), laneId, start, length, patternId, offset };
        clipNeed.set(patternId, Math.max(clipNeed.get(patternId) ?? 0, offset + length));
      }
    } else {
      const cid = byIid.get(it.ref);
      const ch = cid ? project.channels[cid] : undefined;
      const beats = it.startOffset !== null ? it.startOffset / flp.ppq : 0;
      if (ch?.kind === 'audioClip')
        clip = {
          kind: 'audio',
          id: newId.clip(),
          laneId,
          start,
          length,
          channelId: ch.id,
          offsetSec: (beats * 60) / bpm,
        };
      else if (ch?.kind === 'automation')
        clip = {
          kind: 'automation',
          id: newId.clip(),
          laneId,
          start,
          length,
          channelId: ch.id,
          offset: Math.round(beats * PPQ),
        };
    }
    if (!clip) {
      report.skippedClips++;
      continue;
    }
    if (it.muted) clip.muted = true;
    project.playlist.clips[clip.id] = clip;
    report.clips++;
  }
  // FL pattern clips don't loop their content: make the pattern long enough to hold the longest clip.
  for (const [id, need] of clipNeed) {
    const pat = project.patterns[id];
    const content = ceilToBars(contentEnd.get(id) ?? 0, ts);
    if (pat && need > content) {
      pat.length = ceilToBars(need, ts);
      pat.stepCount = clamp(Math.round(pat.length / 240), 16, STEP_MAX);
    }
  }

  // Markers (time signature markers keep their signature as the name).
  for (const m of [...arrangement.markers].sort((a, b) => a.position - b.position)) {
    const sig = m.kind === 1 && m.numerator && m.denominator ? `${m.numerator}/${m.denominator}` : '';
    const marker: Marker = {
      id: newId.marker(),
      tick: tick(m.position),
      name: trimName(m.name?.trim() || sig || 'Marker'),
    };
    project.playlist.markers[marker.id] = marker;
    report.markers++;
  }

  return {
    project,
    report,
    firstPatternId: project.patternOrder[0] as PatternId,
    hasSong: report.clips > 0,
  };
}

/** Whether audio from `from` reaches `to` through the routes made so far. */
function reaches(inserts: Record<InsertId, Insert>, from: InsertId, to: InsertId): boolean {
  const seen = new Set<InsertId>();
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop() as InsertId;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const r of inserts[id]?.routes ?? []) stack.push(r.to);
  }
  return false;
}

function effectFor(s: FlpSlot): string | undefined {
  if (isVst(s)) return vstEffect(s.vst?.name || s.name || '');
  return EFFECTS[(s.internalName ?? '').trim().toLowerCase()];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function list(names: readonly string[], max = 4): string {
  const unique = [...new Set(names)];
  const shown = unique.slice(0, max).join(', ');
  return unique.length > max ? `${shown} and ${unique.length - max} more` : shown;
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The report in plain words: a headline and one line per thing worth knowing. */
export function describeFlpImport(
  r: FlpImportReport,
  opts: { fromPackage?: boolean } = {},
): {
  headline: string;
  details: string[];
} {
  const got: string[] = [plural(r.channels, 'channel'), plural(r.patterns, 'pattern')];
  if (r.clips > 0)
    got.push(
      r.arrangement
        ? `the arrangement “${r.arrangement}” (${plural(r.clips, 'clip')})`
        : `the playlist (${plural(r.clips, 'clip')})`,
    );
  if (r.markers > 0) got.push(plural(r.markers, 'marker'));
  if (r.effects > 0) got.push(plural(r.effects, 'effect'));
  const headline = `Imported ${joinAnd(got)}.`;
  const details: string[] = [];
  const vsts = r.standIns.filter((s) => s.vst);
  const natives = r.standIns.filter((s) => !s.vst);
  if (vsts.length > 0)
    details.push(
      `Not imported: ${plural(new Set(vsts.map((s) => s.plugin)).size, 'VST plugin')} (${list(vsts.map((s) => s.plugin))}). Their channels keep their notes and play a stand-in (${list(
        vsts.map((s) => s.using),
        3,
      )}), marked “stand-in” in the channel name.`,
    );
  if (natives.length > 0)
    details.push(
      `FL instruments without a match here (${list(natives.map((s) => s.plugin))}) play a stand-in instead (${list(
        natives.map((s) => s.using),
        3,
      )}); their notes are all there.`,
    );
  if (r.missingSamples.length > 0) {
    const files = list(r.missingSamples.map((m) => m.file));
    const n = new Set(r.missingSamples.map((m) => m.path)).size;
    details.push(
      opts.fromPackage
        ? `${plural(n, 'sample was', 'samples were')} not in the zip (${files}): use File > Find missing samples… with the audio files, or drop them on their channels.`
        : `${plural(n, 'sample wasn’t', 'samples weren’t')} in the file (${files}): an .flp only points at samples on the computer that made it. Drop the zipped loop package (in FL: File > Export > Zipped loop package) to bring them, or use File > Find missing samples….`,
    );
  }
  if (r.skippedEffects.length > 0)
    details.push(`Effects not imported: ${list(r.skippedEffects.map((e) => `${e.plugin} (${e.insert})`))}.`);
  if (r.effectStandIns.length > 0)
    details.push(`Effects replaced by a built-in: ${list(r.effectStandIns.map((e) => `${e.plugin} → ${e.using}`))}.`);
  if (r.otherArrangements.length > 0)
    details.push(`Only the open arrangement came in; not imported: ${list(r.otherArrangements.map((a) => `“${a}”`))}.`);
  if (r.layers.length > 0)
    details.push(
      `Layer channels (${list(r.layers.map((l) => l.channel))}) became their child channels, which play the layer’s notes.`,
    );
  if (r.untargetedAutomation.length > 0)
    details.push(
      `${plural(r.untargetedAutomation.length, 'automation clip')} came in without a target (${list(r.untargetedAutomation)}): right-click a control and use “Create automation clip” to redo them.`,
    );
  if (r.slideNotes > 0) details.push(`${plural(r.slideNotes, 'slide note')} (FL’s pitch slides) were left out.`);
  if (r.orphanNotes > 0)
    details.push(`${plural(r.orphanNotes, 'note')} on channels that couldn’t be imported were left out.`);
  if (r.skippedClips > 0)
    details.push(`${plural(r.skippedClips, 'playlist clip')} couldn’t be placed and were left out.`);
  if (r.standIns.length > 0 || r.effects > 0)
    details.push(
      'Plugin settings aren’t read from FL Studio: every instrument and effect starts from its default sound.',
    );
  details.push(...r.warnings);
  return { headline, details };
}
