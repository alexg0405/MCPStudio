/**
 * The auto-mix planner: songs (with their analyses) in, a DJ mix out. Pure and deterministic.
 *
 * - **Order**: kept, or chosen (`order.ts`): harmonic moves on the Camelot wheel, close tempos and
 *   the energy shape; pinned songs keep their position.
 * - **Time**: every song plays beat-locked (an audio clip channel with `stretch` at its BPM), so a
 *   song's local beat u (beats from its first downbeat) sits at a fixed song beat: G + u. Song beats
 *   are playlist beats (960 ticks), so placing a song is choosing G, and the tempo map only decides
 *   how fast the beats go by.
 * - **Transitions** are phrase-aligned on downbeats: the outgoing song's mix-out phrase starts on the
 *   same downbeat as the incoming song's mix-in (its intro), and they overlap for 16 or 32 bars (8 for
 *   quick, 0 for a cut). At most two songs ever play at once.
 * - **Tempo** (`follow`, the default): each song plays at its own tempo; during a transition the tempo
 *   moves from one to the other in steps of at most 1 % on bar lines, so neither song strays further
 *   than the gap between them (at most `TEMPO_LIMIT`). The clips are split where the tempo changes,
 *   so each piece is stretched at one constant tempo (its pitch never bends). Songs further apart
 *   (after trying half and double time) are cut. With a fixed `mixTempo` every song plays at it.
 * - **Recipes** per transition, as automation on the two deck tracks: the bass swap (the incoming
 *   song comes in with its lows cut; at the phrase midpoint its lows come back as the outgoing song's
 *   go), equal-power volume curves, a low-pass sweep out of the outgoing song for an energy drop
 *   ("filter"), an echo throw where the outgoing song stops ("echo", and every cut), and a riser into
 *   the swap for an energy rise. Every curve ends where the control sits ("neutral").
 */
import type { Tick } from '../model/types';
import { PPQ } from '../time/ppq';
import { steppedTempo } from '../time/tempo';
import { autoOrder, type EnergyShape } from './order';
import type { Camelot, TrackAnalysis } from './types';
import { harmonicMove, tempoMatch, TEMPO_LIMIT, trackEnergy, type HarmonicMove } from './wheel';

const BEAT = PPQ;
/** Song beats per playlist bar (the mix is in 4/4). */
const BAR = 4;
/** Lows cut to here take a song's bass and kick out (EQ Pro band 1, 24 dB/oct). */
export const BASS_CUT_HZ = 300;
/** Where the filter sweep out of a song ends. */
export const FILTER_OUT_HZ = 350;
/** The largest tempo step inside a transition (as a share of the tempo). */
const STEP_LIMIT = 0.01;
const MAX_STEPS = 8;

export type MixOrder = 'keep' | 'auto';
export type MixTransitionStyle = 'auto' | 'smooth' | 'quick' | 'cut';
export type TransitionRecipe = 'bass-swap' | 'filter' | 'echo' | 'cut';
export const TRANSITION_RECIPES: readonly TransitionRecipe[] = ['bass-swap', 'filter', 'echo', 'cut'];
export const TRANSITION_LENGTHS: readonly number[] = [0, 4, 8, 16, 32];
export type Deck = 'A' | 'B';

export interface MixTrackInput {
  /** The caller's id (the library song or sample). */
  id: string;
  /** "Artist – Title", or the file name. */
  title: string;
  analysis: TrackAnalysis;
  /** Auto order keeps it at its position in the input. */
  pinned?: boolean;
}

/** A change to one transition, by the incoming song's id. */
export interface TransitionTweak {
  /** Overlap in bars (0 = a cut). */
  bars?: number;
  recipe?: TransitionRecipe;
  riser?: boolean;
}

export interface MixOptions {
  order: MixOrder;
  energy: EnergyShape;
  /** 'follow': each song at its own tempo, ramping during transitions; a number: the whole mix at that BPM. */
  mixTempo: 'follow' | number;
  transition: MixTransitionStyle;
  /** Aim for about this many minutes (songs mix out earlier, by whole phrases). */
  lengthTargetMin?: number;
  tweaks?: Readonly<Record<string, TransitionTweak>>;
}

export const DEFAULT_MIX_OPTIONS: MixOptions = { order: 'auto', energy: 'party', mixTempo: 'follow', transition: 'auto' };

export interface PlannedClip {
  start: Tick;
  length: Tick;
  /** Seconds into the song where this piece starts. */
  offsetSec: number;
}

export interface PlannedSong {
  id: string;
  title: string;
  /** Position in the mix, 0-based. */
  index: number;
  deck: Deck;
  /** The tempo its beats are counted at (the channel's source BPM): its own, or half/double for a half-time match. */
  bpm: number;
  nativeBpm: number | null;
  factor: 0.5 | 1 | 2;
  /** False for songs without a steady beat: they play at their own speed and are cut in and out. */
  beatMatched: boolean;
  start: Tick;
  end: Tick;
  sourceIn: number;
  sourceOut: number;
  /** Pieces split where the tempo changes. */
  clips: PlannedClip[];
  tempoStart: number;
  tempoEnd: number;
  /** Level match to the other songs (clip gain). */
  gainDb: number;
  /** Fade at its end (seconds), when the mix ends before the song does. */
  fadeOutSec?: number;
  key: Camelot | null;
  /** Overall energy 0–1 (`trackEnergy`). */
  energy: number;
}

export interface PlannedTransition {
  index: number;
  from: string;
  to: string;
  fromDeck: Deck;
  toDeck: Deck;
  /** The downbeat both songs are on when the incoming one starts. */
  start: Tick;
  /** Overlap (0 for a cut). */
  length: Tick;
  bars: number;
  recipe: TransitionRecipe;
  riser: boolean;
  /** Where the bass swaps (or the outgoing song stops). */
  swap: Tick;
  move: HarmonicMove;
  /** The tempo change as a share (0.03 = 3 %). */
  tempoChange: number;
  /** Plain words for the transitions list. */
  why: string;
}

export type DeckControl = 'volume' | 'low-cut' | 'high-cut' | 'filter' | 'echo';
export type DjPurpose = 'fade-in' | 'fade-out' | 'bass-in' | 'bass-out' | 'filter-out' | 'echo-out';

/**
 * A curve on a deck control. Point values: volume as a factor of the fader's own level (1 = where it
 * sits), low cut / high cut / filter in Hz, echo as the send's gain; 'neutral' = where the control sits.
 */
export interface DjAutomation {
  transition: number;
  deck: Deck;
  control: DeckControl;
  purpose: DjPurpose;
  start: Tick;
  length: Tick;
  points: { at: Tick; value: number | 'neutral' }[];
}

export interface PlannedRiser {
  transition: number;
  start: Tick;
  beats: number;
  /** Tempo at its start (its sample is made for it). */
  bpm: number;
}

export interface TempoPoint {
  tick: Tick;
  bpm: number;
}

export interface MixPlan {
  songs: PlannedSong[];
  transitions: PlannedTransition[];
  automation: DjAutomation[];
  risers: PlannedRiser[];
  markers: { tick: Tick; name: string; song: string }[];
  /** Piecewise constant from tick 0. */
  tempo: TempoPoint[];
  /** Set when the whole mix plays at one tempo. */
  fixedTempo: number | null;
  totalTicks: Tick;
  durationSec: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------------------------

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const pct = (v: number) => `${Math.round(v * 100)} %`;

/** A song placed on its effective grid: local beats (from the first downbeat) of its landmarks. */
interface Local {
  input: MixTrackInput;
  matched: boolean;
  native: number | null;
  bpm: number;
  factor: 0.5 | 1 | 2;
  f: number;
  bpb: number;
  beatSec: number;
  /** File start and end in local beats. */
  uStart: number;
  uEnd: number;
  /** Bar-aligned mix-in and mix-out points. */
  uIn: number;
  uOut: number;
  energy: number;
}

const hasGrid = (a: TrackAnalysis) => !!a.grid && a.grid.bpm > 0 && a.grid.confidence >= 0.25;

function localize(input: MixTrackInput, bpm: number, factor: 0.5 | 1 | 2): Local {
  const a = input.analysis;
  const matched = hasGrid(a);
  const f = matched ? Math.max(0, a.grid!.firstDownbeat) : 0;
  const bpb = matched ? Math.max(1, Math.round(a.grid!.beatsPerBar || 4)) : 4;
  const beatSec = 60 / bpm;
  const at = (sec: number) => (sec - f) / beatSec;
  const uStart = at(0);
  const uEnd = at(Math.max(0, a.durationSec));
  const firstBar = Math.ceil(uStart / bpb - 1e-9) * bpb;
  const lastBar = Math.floor(uEnd / bpb + 1e-9) * bpb;
  const bar = (u: number) => Math.round(u / bpb) * bpb;
  const uIn = Math.min(Math.max(firstBar, bar(at(a.mixIn))), Math.max(firstBar, lastBar - bpb));
  let uOut = Math.min(bar(at(a.mixOut)), lastBar - bpb);
  if (!(uOut > uIn)) uOut = Math.max(uIn, lastBar - bpb);
  return { input, matched, native: matched ? a.grid!.bpm : null, bpm, factor, f, bpb, beatSec, uStart, uEnd, uIn, uOut, energy: trackEnergy(a) };
}

interface Decision {
  bars: number;
  recipe: TransitionRecipe;
  riser: boolean;
  /** Tempos close enough to ramp between (both beat-matched). */
  rampable: boolean;
  move: HarmonicMove;
  tempoChange: number;
  why: string[];
}

function decide(a: Local, b: Local, opts: MixOptions, fixed: boolean): Decision {
  const move = harmonicMove(a.input.analysis.key, b.input.analysis.key);
  const change = fixed ? 0 : b.bpm / a.bpm - 1;
  const rampable = a.matched && b.matched && (fixed || Math.abs(change) <= TEMPO_LIMIT + 1e-9);
  const why: string[] = [];
  let bars = opts.transition === 'smooth' ? 32 : opts.transition === 'quick' ? 8 : opts.transition === 'cut' ? 0 : opts.energy === 'chill' ? 32 : 16;
  let recipe: TransitionRecipe = 'bass-swap';
  const drop = b.energy < a.energy - 0.12;
  const rise = b.energy > a.energy + 0.12;
  if (!rampable) {
    recipe = 'cut';
    why.push(!a.matched || !b.matched ? 'no steady beat to match' : `tempos ${pct(Math.abs(change))} apart: a cut`);
  } else if (opts.transition === 'cut') recipe = 'cut';
  else if (move === 'clash') {
    recipe = 'echo';
    bars = Math.min(bars, 8);
    why.push('keys clash: a short overlap that echoes out');
  } else if (drop) {
    recipe = 'filter';
    why.push('energy drops: the outgoing song filters out');
  }
  let riser = rampable && rise && opts.energy !== 'chill' && opts.transition !== 'cut';
  if (riser) why.push('energy rises: a riser into the swap');
  const tweak = opts.tweaks?.[b.input.id];
  if (tweak) {
    if (tweak.recipe) {
      if (tweak.recipe !== 'cut' && !rampable) why.push('kept as a cut (the tempos are too far apart to blend)');
      else recipe = tweak.recipe;
    }
    if (tweak.bars !== undefined && Number.isFinite(tweak.bars)) {
      const t = Math.max(0, Math.min(64, Math.round(tweak.bars / 4) * 4));
      if (t === 0) recipe = 'cut';
      else if (rampable) {
        bars = t;
        if (recipe === 'cut' && !tweak.recipe) recipe = 'bass-swap';
      }
    }
    if (tweak.riser !== undefined) riser = tweak.riser;
  }
  if (recipe === 'cut') bars = 0;
  else if (bars === 0) bars = 8;
  return { bars, recipe, riser, rampable, move, tempoChange: change, why };
}

interface Layout {
  songs: Local[];
  decisions: Decision[];
  /** Exit start (local beat) per song, the overlap (beats) of each transition, the last song's end. */
  uOut: number[];
  overlap: number[];
  lastEnd: number;
  lastFade: boolean;
  G: number[];
}

/** Places the songs with `shrink[i]` phrases (16 bars) taken off song i's mix-out point. */
function layout(songs: Local[], decisions: Decision[], shrink: readonly number[]): Layout {
  const n = songs.length;
  const uOut: number[] = [];
  const overlap: number[] = [];
  const dec = decisions.map((d) => ({ ...d, why: d.why.slice() }));
  let prevOverlap = 0;
  for (let i = 0; i < n - 1; i++) {
    const a = songs[i]!;
    const b = songs[i + 1]!;
    const d = dec[i]!;
    const entry = i === 0 ? Math.max(0, Math.ceil(a.uStart / a.bpb - 1e-9) * a.bpb) : a.uIn;
    // Earliest exit: after the previous transition (and a bar of its own).
    const lo = entry + prevOverlap + (i === 0 ? 0 : BAR);
    const audioEnd = Math.floor(a.uEnd + 1e-9);
    // The analysis's mix-out point, moved later by phrases (8 bars) when it comes too early, and
    // earlier by 16 bars per shrink step (never before `lo`).
    let out = a.uOut;
    if (out < lo) out = lo + ((((a.uOut - lo) % (8 * BAR)) + 8 * BAR) % (8 * BAR));
    out -= Math.min(shrink[i] ?? 0, Math.floor((out - lo) / (16 * BAR))) * 16 * BAR;
    let bars = d.bars;
    // Both songs need audio for the whole overlap (B also needs a bar after it).
    const fits = (o: number, l: number) => o + l * BAR <= audioEnd && b.uIn + l * BAR + BAR <= Math.floor(b.uEnd + 1e-9);
    while (bars > 4 && !fits(out, bars)) bars = bars > 16 ? bars / 2 : bars - 4;
    while (bars > 0 && !fits(out, bars) && out - 8 * BAR >= lo) out -= 8 * BAR;
    if (bars > 0 && !fits(out, bars)) {
      bars = 0;
      d.recipe = 'cut';
      d.why.push('too little music left for an overlap: a cut');
    }
    if (bars === 0 && out > audioEnd) out = Math.max(lo, Math.floor(audioEnd / a.bpb) * a.bpb);
    if (bars !== d.bars && bars > 0) d.why.push(`${bars} bars (the songs are too short for ${d.bars})`);
    d.bars = bars;
    if (bars === 0) d.recipe = 'cut';
    uOut.push(out);
    overlap.push(bars * BAR);
    prevOverlap = bars * BAR;
  }
  // The last song plays to its end, or mixes out by phrases to meet a length target (with a fade).
  const last = songs[n - 1]!;
  const lastShrink = shrink[n - 1] ?? 0;
  const lastLo = (n === 1 ? Math.max(0, last.uIn) : last.uIn + prevOverlap) + 16 * BAR;
  let lastEnd = last.uEnd;
  let lastFade = false;
  if (lastShrink > 0) {
    lastEnd = Math.max(Math.min(last.uEnd, lastLo), Math.floor(last.uEnd / BAR) * BAR - lastShrink * 16 * BAR);
    lastFade = lastEnd < last.uEnd - 1e-6;
  }
  // Placement: the first song from the file's start (its first downbeat on a bar line).
  const G: number[] = [];
  const first = songs[0]!;
  G.push(n === 0 ? 0 : Math.max(0, Math.ceil(-first.uStart / BAR - 1e-9) * BAR));
  for (let i = 0; i < n - 1; i++) G.push(G[i]! + uOut[i]! - songs[i + 1]!.uIn);
  return { songs, decisions: dec, uOut, overlap, lastEnd, lastFade, G };
}

const ticks = (beats: number) => Math.round(beats * BEAT);

/** Tempo points (beats → bpm) of a layout in follow mode. */
function tempoPoints(l: Layout): { beat: number; bpm: number }[] {
  const pts: { beat: number; bpm: number }[] = [{ beat: 0, bpm: r3(l.songs[0]!.bpm) }];
  for (let i = 0; i < l.songs.length - 1; i++) {
    const a = l.songs[i]!.bpm;
    const b = l.songs[i + 1]!.bpm;
    const x = l.G[i]! + l.uOut[i]!;
    const over = l.overlap[i]!;
    if (a !== b && over > 0) {
      const bars = over / BAR;
      const n = Math.max(1, Math.min(MAX_STEPS, bars, Math.ceil(Math.abs(b / a - 1) / STEP_LIMIT - 1e-9)));
      for (let k = 0; k < n; k++) pts.push({ beat: x + BAR * Math.floor((k * bars) / n), bpm: r3(a + ((b - a) * (k + 0.5)) / n) });
    }
    pts.push({ beat: x + over, bpm: r3(b) });
  }
  // Sorted, one per beat, equal neighbours merged.
  const out: { beat: number; bpm: number }[] = [];
  for (const p of pts.sort((x, y) => x.beat - y.beat)) {
    const last = out[out.length - 1];
    if (last && last.beat === p.beat) last.bpm = p.bpm;
    else if (!last || last.bpm !== p.bpm) out.push({ ...p });
  }
  return out;
}

function durationOf(tempo: readonly TempoPoint[], total: Tick): number {
  return steppedTempo(tempo.map((t) => ({ tick: t.tick, bpm: t.bpm }))).tickToSeconds(total);
}

const median = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0;
};

/** Plans a mix. Songs without analysis data still play (cut in and out); an empty list gives an empty plan. */
export function planMix(tracks: readonly MixTrackInput[], options: Partial<MixOptions> = {}): MixPlan {
  const opts: MixOptions = { ...DEFAULT_MIX_OPTIONS, ...options };
  const warnings: string[] = [];
  const empty: MixPlan = { songs: [], transitions: [], automation: [], risers: [], markers: [], tempo: [{ tick: 0, bpm: 120 }], fixedTempo: null, totalTicks: 0, durationSec: 0, warnings };
  if (tracks.length === 0) return empty;

  // 1. Order.
  const idx = opts.order === 'auto' ? autoOrder(tracks.map((t) => ({ analysis: t.analysis, pinned: !!t.pinned })), opts.energy) : tracks.map((_, i) => i);
  const ordered = idx.map((i) => tracks[i]!);

  // 2. The tempo each song's beats are counted at.
  const fixed = typeof opts.mixTempo === 'number' && Number.isFinite(opts.mixTempo) ? Math.min(250, Math.max(50, opts.mixTempo)) : null;
  const songs: Local[] = [];
  for (const t of ordered) {
    const native = hasGrid(t.analysis) ? t.analysis.grid!.bpm : null;
    const prev = songs[songs.length - 1];
    if (native === null) {
      songs.push(localize(t, fixed ?? prev?.bpm ?? 120, 1));
      warnings.push(`“${t.title}” has no steady beat to match: it is cut in and out at its own speed.`);
      continue;
    }
    if (fixed !== null) {
      const m = tempoMatch(fixed, native, Infinity);
      const bpm = native * m.factor;
      songs.push(localize(t, bpm, m.factor));
      const dev = fixed / bpm - 1;
      if (Math.abs(dev) > TEMPO_LIMIT) warnings.push(`“${t.title}” plays ${pct(Math.abs(dev))} ${dev > 0 ? 'faster' : 'slower'} than recorded at ${fixed} BPM.`);
      continue;
    }
    if (!prev || !prev.matched) {
      songs.push(localize(t, native, 1));
      continue;
    }
    const m = tempoMatch(prev.bpm, native);
    const factor = m.deviation <= TEMPO_LIMIT ? m.factor : 1;
    // Keep tempos readable: no half time below 60 or double time above 200 BPM.
    const f = native * factor < 60 || native * factor > 200 ? 1 : factor;
    songs.push(localize(t, r3(native * f), f));
  }

  // 3. What each transition does.
  const decisions: Decision[] = [];
  for (let i = 0; i < songs.length - 1; i++) decisions.push(decide(songs[i]!, songs[i + 1]!, opts, fixed !== null));

  // 4. Lay out; with a length target take phrases off the longest songs until it fits.
  const shrink = new Array<number>(songs.length).fill(0);
  const build = () => {
    const l = layout(songs, decisions, shrink);
    const tempo: TempoPoint[] = fixed !== null ? [{ tick: 0, bpm: fixed }] : tempoPoints(l).map((p) => ({ tick: ticks(p.beat), bpm: p.bpm }));
    const n = songs.length;
    const end = l.G[n - 1]! + l.lastEnd;
    const total = ticks(end);
    return { l, tempo, total, seconds: durationOf(tempo, total) };
  };
  let cur = build();
  if (opts.lengthTargetMin && opts.lengthTargetMin > 0) {
    const target = opts.lengthTargetMin * 60;
    for (let guard = 0; guard < 400 && cur.seconds > target; guard++) {
      // The song with the most music between its entry and its exit that can lose a phrase.
      let pick = -1;
      let room = 0;
      for (let i = 0; i < songs.length; i++) {
        const s = songs[i]!;
        const entry = i === 0 ? Math.max(0, s.uIn) : s.uIn;
        const prevOver = i > 0 ? cur.l.overlap[i - 1]! : 0;
        const exit = i < songs.length - 1 ? cur.l.uOut[i]! : cur.l.lastEnd;
        const r = exit - (entry + prevOver) - 16 * BAR;
        if (r >= 16 * BAR && r > room) {
          room = r;
          pick = i;
        }
      }
      if (pick < 0) break;
      shrink[pick]!++;
      const next = build();
      if (next.total >= cur.total) {
        shrink[pick]!--;
        break;
      }
      cur = next;
    }
    if (cur.seconds > target + 60) warnings.push(`The mix is ${Math.round(cur.seconds / 60)} min: it can't get closer to ${opts.lengthTargetMin} min without cutting songs too short.`);
    if (cur.seconds < target - 120) warnings.push(`The songs make ${Math.round(cur.seconds / 60)} min of music; add songs for a ${opts.lengthTargetMin} min mix.`);
  }
  const { l, tempo, total } = cur;
  const tempoMap = steppedTempo(tempo);

  // 5. Songs and their clips.
  const lufs = ordered.map((t) => t.analysis.lufs).filter((v) => Number.isFinite(v));
  const refLufs = median(lufs);
  const changes = tempo.map((t) => t.tick);
  const planned: PlannedSong[] = songs.map((s, i) => {
    const n = songs.length;
    const entry = i === 0 ? s.uStart : s.uIn;
    const exit = i < n - 1 ? l.uOut[i]! + l.overlap[i]! : l.lastEnd;
    // Rounded up, so the first piece never starts before the file (its trim stays on the grid).
    const start = Math.max(0, Math.ceil((l.G[i]! + entry) * BEAT - 1e-6));
    const end = ticks(l.G[i]! + exit);
    const src = (tick: Tick) => Math.max(0, s.f + (tick / BEAT - l.G[i]!) * s.beatSec);
    const cuts = [start, ...changes.filter((c) => c > start && c < end && s.matched), end];
    const clips: PlannedClip[] = [];
    for (let k = 0; k < cuts.length - 1; k++) {
      const a = cuts[k]!;
      const b = cuts[k + 1]!;
      if (b > a) clips.push({ start: a, length: b - a, offsetSec: src(a) });
    }
    const gain = Number.isFinite(s.input.analysis.lufs) && lufs.length > 1 ? Math.max(-9, Math.min(9, refLufs - s.input.analysis.lufs)) : 0;
    const song: PlannedSong = {
      id: s.input.id,
      title: s.input.title,
      index: i,
      deck: i % 2 === 0 ? 'A' : 'B',
      bpm: r3(s.bpm),
      nativeBpm: s.native,
      factor: s.factor,
      beatMatched: s.matched,
      start,
      end,
      sourceIn: src(start),
      sourceOut: Math.min(s.input.analysis.durationSec, src(end)),
      clips,
      tempoStart: tempoMap.bpmAt(start),
      tempoEnd: tempoMap.bpmAt(Math.max(start, end - 1)),
      gainDb: Math.round(gain * 10) / 10,
      key: s.input.analysis.key?.camelot ?? null,
      energy: s.energy,
    };
    if (i === n - 1 && l.lastFade) song.fadeOutSec = Math.min(30, (8 * BAR * 60) / tempoMap.bpmAt(end - 1));
    return song;
  });

  // 6. Transitions, their curves and risers.
  const transitions: PlannedTransition[] = [];
  const automation: DjAutomation[] = [];
  const risers: PlannedRiser[] = [];
  for (let i = 0; i < songs.length - 1; i++) {
    const d = l.decisions[i]!;
    const a = planned[i]!;
    const b = planned[i + 1]!;
    const x = ticks(l.G[i]! + l.uOut[i]!);
    const w = l.overlap[i]! * BEAT;
    const mid = d.recipe === 'echo' ? x + w : x + Math.floor(d.bars / 2) * BAR * BEAT;
    const swap = d.recipe === 'cut' ? x : mid;
    const words = d.why.length ? d.why : [d.recipe === 'bass-swap' ? 'a bass swap at the phrase midpoint' : d.recipe];
    transitions.push({
      index: i,
      from: a.id,
      to: b.id,
      fromDeck: a.deck,
      toDeck: b.deck,
      start: x,
      length: w,
      bars: d.bars,
      recipe: d.recipe,
      riser: d.riser,
      swap,
      move: d.move,
      tempoChange: d.tempoChange,
      why: words.join('; '),
    });
    automation.push(...curvesFor(i, d.recipe, a.deck, b.deck, x, w, mid));
    if (d.riser) {
      const bpm = tempoMap.bpmAt(Math.max(0, swap - 1));
      // 2 or 4 bars, whichever is closer to 6 s, never before the song comes in (cuts: the bar before).
      const beats = Math.abs((8 * 60) / bpm - 6) <= Math.abs((16 * 60) / bpm - 6) ? 8 : 16;
      const len = Math.min(beats, d.recipe === 'cut' ? 16 : Math.max(4, (swap - x) / BEAT));
      if (len >= 4 && swap - len * BEAT >= 0) risers.push({ transition: i, start: swap - len * BEAT, beats: len, bpm: r3(tempoMap.bpmAt(swap - len * BEAT)) });
    }
  }
  const markers = planned.map((s, i) => ({ tick: i === 0 ? Math.floor(s.start / (BAR * BEAT)) * BAR * BEAT : transitions[i - 1]!.start, name: s.title, song: s.id }));
  return { songs: planned, transitions, automation, risers, markers, tempo, fixedTempo: fixed, totalTicks: total, durationSec: durationOf(tempo, total), warnings };
}

/** Equal-power curve points over [from, to) of a window: sin for in, cos for out (8 pieces). */
function powerCurve(from: Tick, to: Tick, dir: 'in' | 'out'): { at: Tick; value: number | 'neutral' }[] {
  const pts: { at: Tick; value: number | 'neutral' }[] = [];
  for (let k = 0; k <= 8; k++) {
    const t = k / 8;
    const v = dir === 'in' ? Math.sin((Math.PI / 2) * t) : Math.cos((Math.PI / 2) * t);
    pts.push({ at: Math.round(from + (to - from) * t), value: Math.round(v * 1e6) / 1e6 });
  }
  if (dir === 'in') pts[pts.length - 1]!.value = 'neutral';
  return pts;
}

/** The curves of one transition, points relative to each item's start. */
function curvesFor(i: number, recipe: TransitionRecipe, out: Deck, inn: Deck, x: Tick, w: Tick, mid: Tick): DjAutomation[] {
  const items: DjAutomation[] = [];
  const add = (deck: Deck, control: DeckControl, purpose: DjPurpose, start: Tick, end: Tick, points: { at: Tick; value: number | 'neutral' }[]) =>
    items.push({ transition: i, deck, control, purpose, start, length: Math.max(1, end - start), points: points.map((p) => ({ at: p.at - start, value: p.value })) });
  const throwBeat = (end: Tick) =>
    add(out, 'echo', 'echo-out', end - BEAT, end, [
      { at: end - BEAT, value: 1 },
      { at: end, value: 1 },
      { at: end, value: 'neutral' },
    ]);
  if (recipe === 'cut') {
    if (x - BEAT >= 0) throwBeat(x);
    return items;
  }
  const end = x + w;
  // The incoming song: in on an equal-power curve with its lows cut until the swap.
  add(inn, 'volume', 'fade-in', x, recipe === 'echo' ? mid : end, powerCurve(x, recipe === 'echo' ? mid : end, 'in'));
  add(inn, 'low-cut', 'bass-in', x, mid, [
    { at: x, value: BASS_CUT_HZ },
    { at: mid, value: BASS_CUT_HZ },
    { at: mid, value: 'neutral' },
  ]);
  if (recipe === 'echo') {
    // The outgoing song plays on with its bass and stops on the swap with an echo.
    throwBeat(mid);
    return items;
  }
  // The outgoing song: out on an equal-power curve; its lows go at the swap.
  add(out, 'volume', 'fade-out', x, end, [...powerCurve(x, end, 'out'), { at: end, value: 'neutral' }]);
  add(out, 'low-cut', 'bass-out', mid, end, [
    { at: mid, value: 'neutral' },
    { at: mid, value: BASS_CUT_HZ },
    { at: end, value: BASS_CUT_HZ },
    { at: end, value: 'neutral' },
  ]);
  if (recipe === 'filter')
    add(out, 'filter', 'filter-out', mid, end, [
      { at: mid, value: 'neutral' },
      { at: end, value: FILTER_OUT_HZ },
      { at: end, value: 'neutral' },
    ]);
  return items;
}
