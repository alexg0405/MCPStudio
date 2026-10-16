/**
 * DJ auto-mix in the project: songs in → analyzed → planned (`core/dj/plan.ts`) → written as one
 * undo step. The mix is two deck tracks on the mixer ("Deck A", "Deck B": EQ Pro with the bass-swap
 * low cut and a high cut at neutral, then a Filter) sending to an "Echo" return, the master Limiter,
 * one audio clip channel per song (time-stretched at its own BPM) with its clips on the "Deck A" /
 * "Deck B" playlist tracks, the mix's tempo curve, the transition curves on "Deck A FX n" /
 * "Deck B FX n" tracks, risers, and a marker per song. `Project.dj` remembers the songs, options and
 * tweaks, and what the mix made: making it again replaces exactly that.
 */
import type { Draft } from 'immer';
import { resolveTarget } from '@core/automation/targets';
import { LaneAllocator } from '@core/arrange/plan';
import { laneNamed } from '@core/arrange/apply';
import {
  DEFAULT_MIX_OPTIONS,
  planMix,
  type Deck,
  type DjAutomation,
  type MixOptions,
  type MixPlan,
  type MixTrackInput,
  type TransitionTweak,
} from '@core/dj/plan';
import type { TrackAnalysis } from '@core/dj/types';
import { fxLabel, fxSampleRef } from '@core/model/fx';
import { makeInsert, makePluginInstance, paletteColor } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import { targetKey } from '@core/model/targets';
import {
  MASTER,
  type AudioClip,
  type AudioClipChannel,
  type AutomationChannel,
  type AutomationClip,
  type AutoPoint,
  type ChannelId,
  type DjMixOptions,
  type DjMixState,
  type InsertId,
  type MarkerId,
  type ParamTarget,
  type Project,
  type SampleId,
  type SampleRef,
  type SlotId,
} from '@core/model/types';
import { addMarker, removeMarker } from '@core/ops/markers';
import { addFxSlot } from '@core/ops/mixer';
import { addClips } from '@core/ops/playlist';
import { removeChannel } from '@core/ops/channels';
import { setRoute } from '@core/ops/routing';
import { findEmptyInsert } from '@core/query/mixer';
import { barSpan } from '@core/time/bars';
import { defaultValues } from '@agstudio/sdk';
import { importAudioFile } from '../actions/samples';
import { specsResolver } from '../arrange/env';
import type { Services } from '../services';
import { peekAnalysis, sampleHash, trackAnalyzer } from './analyzer';

export const EQ_PRO = 'agstudio.eq-pro';
export const FILTER = 'agstudio.filter';
export const DELAY = 'agstudio.delay';
export const LIMITER = 'agstudio.limiter';
export const DECK_NAMES: Record<Deck, string> = { A: 'Deck A', B: 'Deck B' };
export const ECHO_NAME = 'Echo';
export const TEMPO_LANE = 'Mix tempo';
export const DJ_FX_LANE = 'DJ FX';

/** EQ Pro on a deck: band 1 the bass-swap low cut, band 8 a high cut, both at neutral. */
const DECK_EQ = { b1On: true, b1Type: 'lowCut24', b1Freq: 20, b8On: true, b8Type: 'highCut24', b8Freq: 20000 } as const;
/** The deck's filter at neutral (a low-pass all the way open). */
const DECK_FILTER = { type: 'lowpass', cutoff: 20000, resonance: 0.9 } as const;
/** The echo return: quarter-note ping-pong echoes, thinned and darkened. */
const ECHO_DELAY = { time: '1/4', feedback: 0.5, pingPong: true, mix: 1, lowCut: 200, highCut: 6000 } as const;

/** A song for the mix: its sample (stored), the title to show, and whether auto order keeps its place. */
export interface MixSong {
  ref: SampleRef;
  title: string;
  pinned?: boolean;
}

export interface DeckSlots {
  insertId: InsertId;
  eq: SlotId;
  filter: SlotId;
}

export interface MixWriteResult {
  plan: MixPlan;
  changes: string[];
}

const toPlanOptions = (o: DjMixOptions, tweaks: Record<string, TransitionTweak>): MixOptions => ({
  order: o.order,
  energy: o.energy,
  transition: o.transition,
  mixTempo: o.mixTempo,
  ...(o.lengthTargetMin ? { lengthTargetMin: o.lengthTargetMin } : {}),
  ...(o.keyLock ? { keyLock: true } : {}),
  tweaks,
});

export const DEFAULT_DJ_OPTIONS: DjMixOptions = {
  order: DEFAULT_MIX_OPTIONS.order,
  energy: DEFAULT_MIX_OPTIONS.energy,
  transition: DEFAULT_MIX_OPTIONS.transition,
  mixTempo: 'follow',
};

// ---------------------------------------------------------------------------------------------
// Mixer

/** The insert with this name, else an empty "Insert N" renamed, else a new one. */
function insertNamed(d: Draft<Project>, name: string, changes: string[]): InsertId {
  const p = d as unknown as Project;
  for (const id of d.mixer.order) if (d.mixer.inserts[id]?.name === name && id !== MASTER) return id;
  const empty = findEmptyInsert(p);
  if (empty) {
    d.mixer.inserts[empty]!.name = name;
    changes.push(`Mixer track ${d.mixer.order.indexOf(empty)} is now “${name}”`);
    return empty;
  }
  const id = newId.insert();
  d.mixer.inserts[id] = makeInsert(id, name);
  d.mixer.order.push(id);
  changes.push(`Added the mixer track “${name}”`);
  return id;
}

/** The first slot of a plugin on an insert (set to `params`), else a new one at `index`. */
function slotFor(d: Draft<Project>, s: Services, insertId: InsertId, pluginId: string, params: Record<string, string | number | boolean>, index?: number): SlotId | null {
  const ins = d.mixer.inserts[insertId]!;
  const slot = ins.fx.find((f) => f.plugin.pluginId === pluginId);
  if (slot) {
    Object.assign(slot.plugin.params, params);
    slot.enabled = true;
    return slot.id;
  }
  const def = s.plugins.get(pluginId);
  if (!def) return null;
  return addFxSlot(d, insertId, makePluginInstance(pluginId, def.version, { ...defaultValues(def.params), ...params }), index);
}

/** Finds or makes the decks, the echo return and the master limiter, all at neutral. */
export function ensureDecks(d: Draft<Project>, s: Services, changes: string[]): { decks: Record<Deck, DeckSlots | null>; echo: InsertId } {
  const echo = insertNamed(d, ECHO_NAME, changes);
  slotFor(d, s, echo, DELAY, { ...ECHO_DELAY });
  const decks = { A: null, B: null } as Record<Deck, DeckSlots | null>;
  for (const deck of ['A', 'B'] as const) {
    const insertId = insertNamed(d, DECK_NAMES[deck], changes);
    const eq = slotFor(d, s, insertId, EQ_PRO, { ...DECK_EQ }, 0);
    const filter = slotFor(d, s, insertId, FILTER, { ...DECK_FILTER });
    const ins = d.mixer.inserts[insertId]!;
    ins.volume = 1;
    if (!ins.routes.some((r) => r.to === MASTER)) setRoute(d, insertId, MASTER, { level: 1 });
    // The echo send sits at zero; transitions throw into it.
    setRoute(d, insertId, echo, { level: 0, pre: false });
    if (eq && filter) decks[deck] = { insertId, eq, filter };
  }
  const master = d.mixer.inserts[MASTER]!;
  if (!master.fx.some((f) => f.plugin.pluginId === LIMITER)) {
    const def = s.plugins.get(LIMITER);
    if (def && addFxSlot(d, MASTER, makePluginInstance(LIMITER, def.version, defaultValues(def.params)))) changes.push('Added a Limiter to the master');
  }
  return { decks, echo };
}

// ---------------------------------------------------------------------------------------------
// Writing

/** Removes what the previous mix made (its channels with their clips, its markers). */
export function removeMixInDraft(d: Draft<Project>): number {
  const prev = d.dj;
  if (!prev) return 0;
  for (const id of prev.made.channels) removeChannel(d, id as ChannelId);
  for (const id of prev.made.markers) removeMarker(d, id as MarkerId);
  delete d.dj;
  return prev.songs.length;
}

const PURPOSE: Record<DjAutomation['purpose'], string> = {
  'fade-in': 'Fade in',
  'fade-out': 'Fade out',
  'bass-in': 'Bass in',
  'bass-out': 'Bass out',
  'filter-out': 'Filter out',
  'echo-out': 'Echo out',
};

function targetOf(a: DjAutomation, deck: DeckSlots, echo: InsertId): ParamTarget {
  const fx = (slotId: SlotId, paramId: string): ParamTarget => ({ kind: 'plugin', owner: { kind: 'fx', insertId: deck.insertId, slotId }, paramId });
  switch (a.control) {
    case 'volume':
      return { kind: 'insert', insertId: deck.insertId, param: 'volume' };
    case 'low-cut':
      return fx(deck.eq, 'b1Freq');
    case 'high-cut':
      return fx(deck.eq, 'b8Freq');
    case 'filter':
      return fx(deck.filter, 'cutoff');
    case 'echo':
      return { kind: 'route', insertId: deck.insertId, to: echo };
  }
}

const samePoints = (a: readonly AutoPoint[], b: readonly AutoPoint[]) =>
  a.length === b.length && a.every((x, i) => x.tick === b[i]!.tick && Math.abs(x.value - b[i]!.value) < 1e-9 && (x.shape ?? 'curve') === (b[i]!.shape ?? 'curve'));

/** Writes a plan (after removing the previous mix). Returns change lines. */
export function writeMixInDraft(
  d: Draft<Project>,
  s: Services,
  plan: MixPlan,
  songs: ReadonlyMap<string, MixSong>,
  options: DjMixOptions,
  tweaks: Record<string, TransitionTweak>,
): string[] {
  const changes: string[] = [];
  const replaced = removeMixInDraft(d);
  if (replaced) changes.push(`Replaced the previous mix (${replaced} songs)`);
  if (plan.songs.length === 0) return changes;
  const { decks, echo } = ensureDecks(d, s, changes);
  const made: ChannelId[] = [];
  const markers: MarkerId[] = [];
  const specsOf = specsResolver(s);
  const p = d as unknown as Project;

  // Lanes in a fixed order: the decks first, then the tempo, then the curves.
  const laneOf: Record<Deck, ReturnType<typeof laneNamed>> = { A: laneNamed(d, DECK_NAMES.A), B: laneNamed(d, DECK_NAMES.B) };

  // Tempo.
  if (plan.fixedTempo !== null || plan.tempoCurve.length === 1) d.transport.bpm = plan.fixedTempo ?? plan.tempoCurve[0]!.bpm;
  else {
    d.transport.bpm = plan.tempoCurve[0]!.bpm;
    const bpms = plan.tempoCurve.map((t) => t.bpm);
    const range = { min: Math.floor(Math.min(...bpms)) - 1, max: Math.ceil(Math.max(...bpms)) + 1 };
    const res = resolveTarget(p, { kind: 'tempo' }, specsOf, range)!;
    const ch: AutomationChannel = {
      kind: 'automation',
      id: newId.channel(),
      name: 'Mix tempo',
      color: paletteColor(9),
      muted: false,
      solo: false,
      target: { kind: 'tempo' },
      // Holds, and straight glides through the transitions.
      points: plan.tempoCurve.map((t) => ({ tick: t.tick, value: res.toNormalized(t.bpm), ...(t.ramp ? {} : { shape: 'hold' as const }) })),
      range,
    };
    d.channels[ch.id] = ch as Draft<AutomationChannel>;
    d.channelOrder.push(ch.id);
    made.push(ch.id);
    const clip: AutomationClip = { kind: 'automation', id: newId.clip(), laneId: laneNamed(d, TEMPO_LANE), start: 0, length: Math.max(1, plan.totalTicks), channelId: ch.id, offset: 0 };
    addClips(d, [clip]);
  }

  // Songs: one stretched channel each, its pieces on its deck's track.
  const sampleIdByHash = new Map<string, SampleId>();
  for (const sid of Object.keys(d.samples) as SampleId[]) {
    const src = d.samples[sid]!.source;
    if (src.kind === 'embedded') sampleIdByHash.set(src.hash, sid);
  }
  const doneSongs: DjMixState['songs'] = [];
  for (const song of plan.songs) {
    const input = songs.get(song.id);
    const deck = decks[song.deck];
    if (!input || !deck) continue;
    const hash = sampleHash(input.ref);
    let sampleId = hash ? sampleIdByHash.get(hash) : undefined;
    if (!sampleId) {
      sampleId = input.ref.id;
      d.samples[sampleId] = { ...input.ref } as Draft<SampleRef>;
      if (hash) sampleIdByHash.set(hash, sampleId);
    }
    const ch: AudioClipChannel = {
      kind: 'audioClip',
      id: newId.channel(),
      name: song.title.slice(0, 64),
      color: paletteColor(song.index * 3 + (song.deck === 'A' ? 0 : 1)),
      muted: false,
      solo: false,
      volume: 0.78,
      pan: 0,
      output: deck.insertId,
      sampleId,
      ...(song.follow !== 'off' ? { stretch: song.follow, sourceBpm: song.bpm } : {}),
    };
    d.channels[ch.id] = ch as Draft<AudioClipChannel>;
    d.channelOrder.push(ch.id);
    made.push(ch.id);
    const gain = Math.min(4, Math.pow(10, song.gainDb / 20));
    const clips: AudioClip[] = song.clips.map((c, k) => ({
      kind: 'audio',
      id: newId.clip(),
      laneId: laneOf[song.deck],
      start: c.start,
      length: c.length,
      channelId: ch.id,
      offsetSec: c.offsetSec,
      ...(Math.abs(gain - 1) > 1e-6 ? { gain } : {}),
      ...(k === song.clips.length - 1 && song.fadeOutSec ? { fadeOut: song.fadeOutSec } : {}),
    }));
    addClips(d, clips);
    doneSongs.push({
      sampleId,
      title: song.title,
      bpm: song.nativeBpm,
      camelot: song.key,
      deck: song.deck,
      start: song.start,
      end: song.end,
      ...(input.pinned ? { pinned: true } : {}),
    });
  }

  // Transition curves, one automation channel per control and shape (reused), on free FX tracks.
  const lanes = new LaneAllocator(new Set([`${DECK_NAMES.A} FX`, `${DECK_NAMES.B} FX`]));
  const names = new Map(d.playlist.laneOrder.map((id) => [id, d.playlist.lanes[id]?.name ?? '']));
  for (const c of Object.values(d.playlist.clips)) lanes.occupy(names.get(c.laneId) ?? '', c.start, c.start + c.length);
  for (const a of plan.automation) {
    const deck = decks[a.deck];
    if (!deck) continue;
    const target = targetOf(a, deck, echo);
    const res = resolveTarget(p, target, specsOf);
    if (!res) continue;
    const neutral = res.base;
    const plain = (v: number | 'neutral') => (v === 'neutral' ? neutral : a.control === 'volume' ? neutral * v : v);
    const points: AutoPoint[] = a.points.map((pt) => ({ tick: Math.round(pt.at), value: Math.min(1, Math.max(0, res.toNormalized(plain(pt.value)))) }));
    const key = targetKey(target);
    let channelId = made.find((cid) => {
      const ch = d.channels[cid];
      return ch?.kind === 'automation' && ch.target && targetKey(ch.target) === key && samePoints(ch.points, points);
    });
    if (!channelId) {
      const bars = Math.round((a.length / 3840) * 100) / 100;
      const ch: AutomationChannel = {
        kind: 'automation',
        id: newId.channel(),
        name: `${PURPOSE[a.purpose]} · ${DECK_NAMES[a.deck]}${a.control === 'echo' ? '' : ` (${bars} bar${bars === 1 ? '' : 's'})`}`,
        color: paletteColor(a.deck === 'A' ? 4 : 6),
        muted: false,
        solo: false,
        target,
        points,
      };
      d.channels[ch.id] = ch as Draft<AutomationChannel>;
      d.channelOrder.push(ch.id);
      made.push(ch.id);
      channelId = ch.id;
    }
    const lane = laneNamed(d, lanes.place(`${DECK_NAMES[a.deck]} FX`, a.start, a.start + a.length));
    addClips(d, [{ kind: 'automation', id: newId.clip(), laneId: lane, start: a.start, length: a.length, channelId, offset: 0 }]);
  }

  // Risers into the swap.
  for (const r of plan.risers) {
    const ref = fxSampleRef('riser', r.beats, r.bpm);
    d.samples[ref.id] = ref;
    const ch: AudioClipChannel = {
      kind: 'audioClip',
      id: newId.channel(),
      name: fxLabel('riser', r.beats),
      color: '#8c9aa8',
      muted: false,
      solo: false,
      volume: 0.5,
      pan: 0,
      output: MASTER,
      sampleId: ref.id,
      stretch: 'resample',
      sourceBpm: r.bpm,
    };
    d.channels[ch.id] = ch as Draft<AudioClipChannel>;
    d.channelOrder.push(ch.id);
    made.push(ch.id);
    addClips(d, [{ kind: 'audio', id: newId.clip(), laneId: laneNamed(d, DJ_FX_LANE), start: r.start, length: r.beats * 960, channelId: ch.id, offsetSec: 0 }]);
  }

  for (const m of plan.markers) markers.push(addMarker(d, m.tick, m.name));

  d.dj = { songs: doneSongs, options: { ...options }, tweaks: { ...tweaks }, made: { channels: made, markers } } as Draft<DjMixState>;
  const ts = d.transport.timeSig;
  changes.push(
    `Made a ${plan.songs.length}-song mix (${Math.round(plan.durationSec / 60)} min, ${barSpan(0, plan.totalTicks, ts)}): ${plan.transitions.length} transitions${
      plan.fixedTempo ? ` at ${plan.fixedTempo} BPM` : ''
    }`,
  );
  return changes;
}

// ---------------------------------------------------------------------------------------------
// From songs to a mix

export interface MakeMixOptions {
  signal?: AbortSignal;
  /** Analysis progress: the song being analyzed (0-based), how many, and its fraction. */
  onProgress?(p: { index: number; count: number; title: string; fraction: number }): void;
  /** Fold the edit into this undo entry (the Studio's answer). */
  amend?: number;
}

export interface MakeMixResult {
  plan: MixPlan;
  changes: string[];
  warnings: string[];
}

/** Analyses of songs: cached, or computed now (one at a time, with progress). */
export async function analyzeSongs(s: Services, songs: readonly MixSong[], opts: MakeMixOptions = {}): Promise<Map<string, TrackAnalysis>> {
  const out = new Map<string, TrackAnalysis>();
  const analyzer = trackAnalyzer(s);
  for (let i = 0; i < songs.length; i++) {
    const song = songs[i]!;
    if (opts.signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    const cached = peekAnalysis(s, song.ref);
    if (cached) {
      out.set(song.ref.id, cached);
      continue;
    }
    if (!analyzer) throw new Error('Song analysis is not available in this version yet.');
    opts.onProgress?.({ index: i, count: songs.length, title: song.title, fraction: 0 });
    const a = await analyzer.analyze(s, song.ref, {
      ...(opts.signal ? { signal: opts.signal } : {}),
      onProgress: (p) => opts.onProgress?.({ index: i, count: songs.length, title: song.title, fraction: p.fraction }),
    });
    out.set(song.ref.id, a);
  }
  return out;
}

const inputsOf = (songs: readonly MixSong[], analyses: ReadonlyMap<string, TrackAnalysis>): MixTrackInput[] =>
  songs.flatMap((x) => {
    const analysis = analyses.get(x.ref.id);
    return analysis ? [{ id: x.ref.id, title: x.title, analysis, ...(x.pinned ? { pinned: true } : {}) }] : [];
  });

/** Plans and writes a mix of songs whose analyses are known (in a draft; sync). */
export function mixInDraft(
  d: Draft<Project>,
  s: Services,
  songs: readonly MixSong[],
  analyses: ReadonlyMap<string, TrackAnalysis>,
  options: DjMixOptions,
  tweaks: Record<string, TransitionTweak> = {},
): MakeMixResult {
  const plan = planMix(inputsOf(songs, analyses), toPlanOptions(options, tweaks));
  const changes = writeMixInDraft(d, s, plan, new Map(songs.map((x) => [x.ref.id, x])), options, tweaks);
  return { plan, changes, warnings: plan.warnings };
}

/** Analyzes (as needed), plans and writes a mix as one undo step. Songs need at least one. */
export async function makeMix(s: Services, songs: readonly MixSong[], options: DjMixOptions = DEFAULT_DJ_OPTIONS, opts: MakeMixOptions = {}): Promise<MakeMixResult> {
  if (songs.length === 0) throw new Error('Pick some songs for the mix first.');
  const analyses = await analyzeSongs(s, songs, opts);
  let result: MakeMixResult | null = null;
  s.history.transact(
    `DJ mix: ${songs.length} songs`,
    (d) => {
      result = mixInDraft(d, s, songs, analyses, options);
    },
    opts.amend !== undefined ? { amend: opts.amend } : {},
  );
  const r = result as MakeMixResult | null;
  if (!r) throw new Error('The mix could not be made.');
  afterMix(s);
  return r;
}

/** After a mix is written: song mode from the top, the playlist on the mix. */
export function afterMix(s: Services): void {
  const view = s.view.getState();
  view.setMode('song');
  view.setLoop(null);
  view.setSongStart(0);
}

/** Imports audio files (stored once by content), then analyzes, plans and writes the mix. */
export async function importSongs(
  s: Services,
  files: readonly Pick<File, 'name' | 'arrayBuffer'>[],
  options: DjMixOptions = DEFAULT_DJ_OPTIONS,
  opts: MakeMixOptions = {},
): Promise<MakeMixResult> {
  const songs: MixSong[] = [];
  for (const f of files) {
    const ref = await importAudioFile(s, f);
    if (ref) songs.push({ ref, title: ref.name });
  }
  return makeMix(s, songs, options, opts);
}

// ---------------------------------------------------------------------------------------------
// The mix that is there

/** The current mix's songs (samples of the project) in mix order, or null without a mix. */
export function currentMixSongs(p: Project): MixSong[] | null {
  if (!p.dj) return null;
  return p.dj.songs.flatMap((x) => {
    const ref = p.samples[x.sampleId];
    return ref ? [{ ref, title: x.title, ...(x.pinned ? { pinned: true } : {}) }] : [];
  });
}

/**
 * Plans the current mix again with changed tweaks or options, in a draft (keeping its order, so only
 * what changed moves). Throws when the songs' analyses aren't cached.
 */
export function replanInDraft(
  d: Draft<Project>,
  s: Services,
  base: Project,
  patch: { tweaks?: Record<string, TransitionTweak | null>; options?: Partial<DjMixOptions> },
): MakeMixResult {
  const dj = base.dj;
  const songs = currentMixSongs(base);
  if (!dj || !songs) throw new Error('There is no DJ mix in this project yet.');
  const analyses = new Map<string, TrackAnalysis>();
  for (const x of songs) {
    const a = peekAnalysis(s, x.ref);
    if (!a) throw new Error(`“${x.title}” isn't analyzed in this browser yet: open the DJ window to analyze it.`);
    analyses.set(x.ref.id, a);
  }
  const tweaks: Record<string, TransitionTweak> = { ...dj.tweaks };
  for (const [k, v] of Object.entries(patch.tweaks ?? {})) {
    if (v === null) delete tweaks[k];
    else tweaks[k] = { ...tweaks[k], ...v };
  }
  // The order stays as it is; options can change the rest.
  const options: DjMixOptions = { ...dj.options, ...patch.options, order: patch.options?.order ?? 'keep' };
  const res = mixInDraft(d, s, songs, analyses, options, tweaks);
  if (d.dj && options.order === 'keep') d.dj.options.order = dj.options.order;
  return res;
}

/** Changes one transition (by the incoming song's sample id) as one undo step. */
export function tweakTransition(s: Services, toSampleId: string, tweak: TransitionTweak | null): MakeMixResult {
  const base = s.doc.getState().project;
  let result: MakeMixResult | null = null;
  s.history.transact('Change a DJ transition', (d) => {
    result = replanInDraft(d, s, base, { tweaks: { [toSampleId]: tweak } });
  });
  return result as unknown as MakeMixResult;
}

/** One line per song for the Studio: title, BPM, key, start bar. */
export function djLines(p: Project): string[] {
  const dj = p.dj;
  if (!dj || dj.songs.length === 0) return [];
  const ts = p.transport.timeSig;
  const bar = 960 * ts.num * (4 / ts.den);
  const lines = [
    `DJ mix (${dj.songs.length} songs; order ${dj.options.order}, energy ${dj.options.energy}, transitions ${dj.options.transition}, tempo ${
      dj.options.mixTempo === 'follow' ? 'follows each song' : `${dj.options.mixTempo} BPM`
    }${dj.options.keyLock ? ', key lock' : ''}):`,
  ];
  dj.songs.forEach((x, i) => {
    const tweak = dj.tweaks[x.sampleId];
    const t = tweak ? ` (transition in: ${[tweak.bars !== undefined ? `${tweak.bars} bars` : '', tweak.recipe ?? '', tweak.riser ? 'riser' : ''].filter(Boolean).join(', ')})` : '';
    lines.push(`- ${i + 1}. “${x.title}”: ${x.bpm ? `${Math.round(x.bpm * 10) / 10} BPM` : 'no steady beat'}, key ${x.camelot ?? 'unknown'}, Deck ${x.deck}, from bar ${Math.floor(x.start / bar) + 1}${t}`);
  });
  return lines;
}

/** Plain words for a transition list entry: "16 bars · bass swap · 8A → 9A (a step) · +1.6 %". */
export function transitionLabel(t: MixPlan['transitions'][number], from: TrackAnalysis | null, to: TrackAnalysis | null): string {
  const recipe = { 'bass-swap': 'bass swap', filter: 'filter out', echo: 'echo out', cut: 'cut' }[t.recipe];
  const keys = from?.key && to?.key ? ` · ${from.key.camelot} → ${to.key.camelot}` : '';
  const tempo = Math.abs(t.tempoChange) > 0.0005 ? ` · ${t.tempoChange > 0 ? '+' : '−'}${Math.round(Math.abs(t.tempoChange) * 1000) / 10} %` : '';
  return `${t.bars ? `${t.bars} bars · ` : ''}${recipe}${t.riser ? ' + riser' : ''}${keys}${tempo}`;
}

/** The plan of the mix that is there (from the cached analyses), or null (no mix, or not analyzed here). */
export function planOfCurrentMix(s: Services, p: Project): MixPlan | null {
  const songs = currentMixSongs(p);
  if (!p.dj || !songs?.length) return null;
  const analyses = new Map<string, TrackAnalysis>();
  for (const x of songs) {
    const a = peekAnalysis(s, x.ref);
    if (!a) return null;
    analyses.set(x.ref.id, a);
  }
  return planMix(inputsOf(songs, analyses), toPlanOptions({ ...p.dj.options, order: 'keep' }, p.dj.tweaks));
}

/** True when the playlist has clips the mix didn't make (a mix would play on top of them). */
export function hasOtherMusic(p: Project): boolean {
  const mine = new Set<string>(p.dj?.made.channels ?? []);
  return Object.values(p.playlist.clips).some((c) => c.kind === 'pattern' || !mine.has(c.channelId));
}
