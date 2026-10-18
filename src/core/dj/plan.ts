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
 *   glides from one to the other, so neither song strays further than the gap between them (at most
 *   `TEMPO_LIMIT`; songs further apart, after trying half and double time, are cut). By default the
 *   songs follow it like a turntable (`resample`: sample-exact beats, the pitch bends with the tempo
 *   while they are off their own, as on a DJ's pitch fader); away from transitions they play
 *   untouched. With `keyLock` they are time-stretched instead (pitch kept): then the tempo moves in
 *   steps of at most 1 % on bar lines and the clips are split there, so each piece is stretched at
 *   one constant tempo. With a fixed `mixTempo` every song is stretched to it (key lock always).
 * - **Recipes** per transition, as automation on the two deck tracks: the bass swap (the incoming
 *   song comes in with its lows cut; at the phrase midpoint its lows come back as the outgoing song's
 *   go), equal-power volume curves, a low-pass sweep out of the outgoing song for an energy drop
 *   ("filter"), an echo throw where the outgoing song stops ("echo", and every cut), and a riser into
 *   the swap for an energy rise. Every curve ends where the control sits ("neutral").
 *
 * The steps live in `plan-layout.ts` (songs on grids, what each transition does, where songs sit), `plan-tempo.ts`
 * (the tempo curve) and `plan-curves.ts` (the deck automation of a transition); the types are in `plan-types.ts`.
 * This file runs them in order. Everything importers used from here is still exported from here.
 */
import type { Tick } from '../model/types';
import { steppedTempo } from '../time/tempo';
import { autoOrder } from './order';
import { transitionCurves } from './plan-curves';
import {
  BEATS_PER_BAR,
  decide,
  hasGrid,
  layoutSongs,
  percent,
  roundBpm,
  ticksOf,
  TICKS_PER_BEAT,
  toGridSong,
  type Decision,
  type GridSong,
  type Layout,
} from './plan-layout';
import { durationOfTempo, tempoPlan } from './plan-tempo';
import {
  DEFAULT_MIX_OPTIONS,
  type DjAutomation,
  type MixOptions,
  type MixPlan,
  type MixTrackInput,
  type PlannedClip,
  type PlannedRiser,
  type PlannedSong,
  type PlannedTransition,
  type TempoPoint,
} from './plan-types';
import { tempoMatch, TEMPO_LIMIT } from './wheel';

export * from './plan-types';
export { BASS_CUT_HZ, FILTER_OUT_HZ } from './plan-curves';

/** The song's tempo map (what the project's tempo does), as `steppedTempo` makes it. */
type TempoMap = ReturnType<typeof steppedTempo>;

/** The tempo a mix starts at when nothing says otherwise (and an empty plan has). */
const FALLBACK_BPM = 120;
/** A fixed mix tempo is held within this range (BPM). */
const MIN_FIXED_BPM = 50;
const MAX_FIXED_BPM = 250;
/** Follow mode keeps tempos readable: no half time below this, no double time above that (BPM). */
const MIN_READABLE_BPM = 60;
const MAX_READABLE_BPM = 200;
/** Level matching moves a song at most this far (dB) either way. */
const MAX_LEVEL_MATCH_DB = 9;
/** A song cut short by a length target fades out over 8 bars, but never longer than this (seconds). */
const FADE_OUT_BARS = 8;
const MAX_FADE_OUT_SEC = 30;
/** A length target takes at most this many phrases off in total (a guard against a loop that cannot end). */
const MAX_SHRINK_ATTEMPTS = 400;
/** A mix this much longer (seconds) than its target, or shorter, gets a warning. */
const TOO_LONG_TOLERANCE_SEC = 60;
const TOO_SHORT_TOLERANCE_SEC = 120;
/** A song needs at least this many beats of music to lose a phrase from (16 bars). */
const PHRASE_BEATS = 16 * BEATS_PER_BAR;
/** A riser is 8 or 16 beats, whichever is closer to this long (seconds). */
const RISER_TARGET_SEC = 6;
const SHORT_RISER_BEATS = 8;
const LONG_RISER_BEATS = 16;
/** A riser after a cut is at most this long (beats): the bar before the swap. */
const MAX_CUT_RISER_BEATS = 16;
/** A riser shorter than this (beats) is not worth making. */
const MIN_RISER_BEATS = 4;

/** The median of a list (0 for none). */
function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = sorted.length / 2;
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The plan of a mix with no songs. */
function emptyPlan(warnings: string[]): MixPlan {
  return {
    songs: [],
    transitions: [],
    automation: [],
    risers: [],
    markers: [],
    tempo: [{ tick: 0, bpm: FALLBACK_BPM }],
    tempoCurve: [{ tick: 0, bpm: FALLBACK_BPM, ramp: false }],
    fixedTempo: null,
    totalTicks: 0,
    durationSec: 0,
    warnings,
  };
}

/** The whole mix's tempo when it has one (clamped), else null: each song then plays at its own. */
function fixedTempoOf(opts: MixOptions): number | null {
  const wanted = opts.mixTempo;
  if (typeof wanted !== 'number' || !Number.isFinite(wanted)) return null;
  return Math.min(MAX_FIXED_BPM, Math.max(MIN_FIXED_BPM, wanted));
}

/**
 * Puts every song on the grid its beats are counted at: its own tempo, or half/double of it when that matches the
 * song before better (follow mode), or the fixed mix tempo. Songs without a steady beat are noted in `warnings`.
 */
function gridSongsFor(ordered: readonly MixTrackInput[], fixedTempo: number | null, warnings: string[]): GridSong[] {
  const songs: GridSong[] = [];
  for (const track of ordered) {
    const nativeBpm = hasGrid(track.analysis) ? track.analysis.grid!.bpm : null;
    const previous = songs[songs.length - 1];
    if (nativeBpm === null) {
      songs.push(toGridSong(track, fixedTempo ?? previous?.bpm ?? FALLBACK_BPM, 1));
      warnings.push(`“${track.title}” has no steady beat to match: it is cut in and out at its own speed.`);
      continue;
    }
    if (fixedTempo !== null) {
      const match = tempoMatch(fixedTempo, nativeBpm, Infinity);
      const bpm = nativeBpm * match.factor;
      songs.push(toGridSong(track, bpm, match.factor));
      const deviation = fixedTempo / bpm - 1;
      if (Math.abs(deviation) > TEMPO_LIMIT) {
        warnings.push(`“${track.title}” plays ${percent(Math.abs(deviation))} ${deviation > 0 ? 'faster' : 'slower'} than recorded at ${fixedTempo} BPM.`);
      }
      continue;
    }
    if (!previous || !previous.isBeatMatched) {
      songs.push(toGridSong(track, nativeBpm, 1));
      continue;
    }
    const match = tempoMatch(previous.bpm, nativeBpm);
    const factor = match.deviation <= TEMPO_LIMIT ? match.factor : 1;
    const countedBpm = nativeBpm * factor;
    const isReadable = countedBpm >= MIN_READABLE_BPM && countedBpm <= MAX_READABLE_BPM;
    const usedFactor = isReadable ? factor : 1;
    songs.push(toGridSong(track, roundBpm(nativeBpm * usedFactor), usedFactor));
  }
  return songs;
}

/** A layout with the tempo it makes and how long it plays. */
interface Candidate {
  layout: Layout;
  /** The song's tempo map as steps (what the project's tempo does). */
  tempoSteps: TempoPoint[];
  tempoCurve: MixPlan['tempoCurve'];
  totalTicks: Tick;
  seconds: number;
}

/** What layout needs besides the songs: how many phrases to take off each, and the tempo mode. */
interface LayoutSettings {
  songs: GridSong[];
  decisions: Decision[];
  shrink: number[];
  fixedTempo: number | null;
  keyLock: boolean;
}

function buildCandidate(settings: LayoutSettings): Candidate {
  const { songs, decisions, shrink, fixedTempo, keyLock } = settings;
  const layout = layoutSongs(songs, decisions, shrink);
  const tempo =
    fixedTempo !== null
      ? { curve: [{ tick: 0, bpm: fixedTempo, ramp: false }], steps: [{ tick: 0, bpm: fixedTempo }] }
      : tempoPlan(layout, keyLock);
  const endBeat = layout.placements[songs.length - 1]! + layout.lastEndBeat;
  const totalTicks = ticksOf(endBeat);
  return { layout, tempoSteps: tempo.steps, tempoCurve: tempo.curve, totalTicks, seconds: durationOfTempo(tempo.steps, totalTicks) };
}

/** The song that has the most music between its entry and its exit that can lose a phrase, or -1 when none can. */
function songToShorten(songs: GridSong[], candidate: Candidate): number {
  const { layout } = candidate;
  let pick = -1;
  let mostRoom = 0;
  for (let i = 0; i < songs.length; i++) {
    const song = songs[i]!;
    const entry = i === 0 ? Math.max(0, song.mixInBeat) : song.mixInBeat;
    const previousOverlap = i > 0 ? layout.overlapBeats[i - 1]! : 0;
    const exit = i < songs.length - 1 ? layout.exitBeats[i]! : layout.lastEndBeat;
    const room = exit - (entry + previousOverlap) - PHRASE_BEATS;
    if (room >= PHRASE_BEATS && room > mostRoom) {
      mostRoom = room;
      pick = i;
    }
  }
  return pick;
}

/** Lays the songs out; with a length target takes phrases off the longest songs until it fits (or can't get closer). */
function fitLayout(settings: LayoutSettings, lengthTargetMin: number | undefined, warnings: string[]): Candidate {
  const { songs, shrink } = settings;
  let current = buildCandidate(settings);
  if (!lengthTargetMin || lengthTargetMin <= 0) return current;
  const targetSec = lengthTargetMin * 60;
  for (let attempt = 0; attempt < MAX_SHRINK_ATTEMPTS && current.seconds > targetSec; attempt++) {
    const pick = songToShorten(songs, current);
    if (pick < 0) break;
    shrink[pick]!++;
    const next = buildCandidate(settings);
    if (next.totalTicks >= current.totalTicks) {
      shrink[pick]!--;
      break;
    }
    current = next;
  }
  const minutes = Math.round(current.seconds / 60);
  if (current.seconds > targetSec + TOO_LONG_TOLERANCE_SEC) {
    warnings.push(`The mix is ${minutes} min: it can't get closer to ${lengthTargetMin} min without cutting songs too short.`);
  }
  if (current.seconds < targetSec - TOO_SHORT_TOLERANCE_SEC) {
    warnings.push(`The songs make ${minutes} min of music; add songs for a ${lengthTargetMin} min mix.`);
  }
  return current;
}

/** Songs and their clips: where each sits on the playlist, how it follows the tempo, its level match and fade. */
function plannedSongsOf(
  songs: GridSong[],
  layout: Layout,
  tempoMap: TempoMap,
  tempoSteps: TempoPoint[],
  settings: { fixedTempo: number | null; keyLock: boolean },
): PlannedSong[] {
  const count = songs.length;
  const loudness = songs.map((s) => s.input.analysis.lufs).filter((v) => Number.isFinite(v));
  const referenceLoudness = median(loudness);
  const tempoChangeTicks = tempoSteps.map((t) => t.tick);
  return songs.map((song, i) => {
    const entryBeat = i === 0 ? song.startBeat : song.mixInBeat;
    const exitBeat = i < count - 1 ? layout.exitBeats[i]! + layout.overlapBeats[i]! : layout.lastEndBeat;
    // Rounded up, so the first piece never starts before the file (its trim stays on the grid).
    const start = Math.max(0, Math.ceil((layout.placements[i]! + entryBeat) * TICKS_PER_BEAT - 1e-6));
    const end = ticksOf(layout.placements[i]! + exitBeat);
    const sourceSecAt = (tick: Tick) => Math.max(0, song.firstDownbeatSec + (tick / TICKS_PER_BEAT - layout.placements[i]!) * song.beatSec);
    // Stretched pieces play at one tempo each: split where it changes (turntable-style needs no split).
    const follow: PlannedSong['follow'] = !song.isBeatMatched ? 'off' : settings.keyLock || settings.fixedTempo !== null ? 'stretch' : 'resample';
    const cuts = [start, ...(follow === 'stretch' ? tempoChangeTicks.filter((tick) => tick > start && tick < end) : []), end];
    const clips: PlannedClip[] = [];
    for (let k = 0; k < cuts.length - 1; k++) {
      const from = cuts[k]!;
      const to = cuts[k + 1]!;
      if (to > from) clips.push({ start: from, length: to - from, offsetSec: sourceSecAt(from) });
    }
    const ownLoudness = song.input.analysis.lufs;
    const canMatchLevel = Number.isFinite(ownLoudness) && loudness.length > 1;
    const gain = canMatchLevel ? Math.max(-MAX_LEVEL_MATCH_DB, Math.min(MAX_LEVEL_MATCH_DB, referenceLoudness - ownLoudness)) : 0;
    const planned: PlannedSong = {
      id: song.input.id,
      title: song.input.title,
      index: i,
      deck: i % 2 === 0 ? 'A' : 'B',
      bpm: roundBpm(song.bpm),
      nativeBpm: song.nativeBpm,
      factor: song.factor,
      beatMatched: song.isBeatMatched,
      follow,
      start,
      end,
      sourceIn: sourceSecAt(start),
      sourceOut: Math.min(song.input.analysis.durationSec, sourceSecAt(end)),
      clips,
      tempoStart: tempoMap.bpmAt(start),
      tempoEnd: tempoMap.bpmAt(Math.max(start, end - 1)),
      gainDb: Math.round(gain * 10) / 10,
      key: song.input.analysis.key?.camelot ?? null,
      energy: song.energy,
    };
    if (i === count - 1 && layout.lastFades) {
      planned.fadeOutSec = Math.min(MAX_FADE_OUT_SEC, (FADE_OUT_BARS * BEATS_PER_BAR * 60) / tempoMap.bpmAt(end - 1));
    }
    return planned;
  });
}

/** The riser into a swap: 2 or 4 bars (whichever is closer to 6 s), never before the song comes in (cuts: the bar before). Null when there is no room. */
function riserFor(index: number, decision: Decision, start: Tick, swap: Tick, tempoMap: TempoMap): PlannedRiser | null {
  const bpm = tempoMap.bpmAt(Math.max(0, swap - 1));
  const shortIsCloser = Math.abs((SHORT_RISER_BEATS * 60) / bpm - RISER_TARGET_SEC) <= Math.abs((LONG_RISER_BEATS * 60) / bpm - RISER_TARGET_SEC);
  const beats = shortIsCloser ? SHORT_RISER_BEATS : LONG_RISER_BEATS;
  const roomBeats = decision.recipe === 'cut' ? MAX_CUT_RISER_BEATS : Math.max(MIN_RISER_BEATS, (swap - start) / TICKS_PER_BEAT);
  const length = Math.min(beats, roomBeats);
  const riserStart = swap - length * TICKS_PER_BEAT;
  if (length < MIN_RISER_BEATS || riserStart < 0) return null;
  return { transition: index, start: riserStart, beats: length, bpm: roundBpm(tempoMap.bpmAt(riserStart)) };
}

/** Transitions, their curves and risers. */
function plannedTransitionsOf(
  layout: Layout,
  planned: PlannedSong[],
  tempoMap: TempoMap,
): { transitions: PlannedTransition[]; automation: DjAutomation[]; risers: PlannedRiser[] } {
  const transitions: PlannedTransition[] = [];
  const automation: DjAutomation[] = [];
  const risers: PlannedRiser[] = [];
  for (let i = 0; i < planned.length - 1; i++) {
    const decision = layout.decisions[i]!;
    const outgoing = planned[i]!;
    const incoming = planned[i + 1]!;
    const start = ticksOf(layout.placements[i]! + layout.exitBeats[i]!);
    const overlap = layout.overlapBeats[i]! * TICKS_PER_BEAT;
    const midpoint = decision.recipe === 'echo' ? start + overlap : start + Math.floor(decision.bars / 2) * BEATS_PER_BAR * TICKS_PER_BEAT;
    const swap = decision.recipe === 'cut' ? start : midpoint;
    const words = decision.why.length ? decision.why : [decision.recipe === 'bass-swap' ? 'a bass swap at the phrase midpoint' : decision.recipe];
    transitions.push({
      index: i,
      from: outgoing.id,
      to: incoming.id,
      fromDeck: outgoing.deck,
      toDeck: incoming.deck,
      start,
      length: overlap,
      bars: decision.bars,
      recipe: decision.recipe,
      riser: decision.riser,
      swap,
      move: decision.move,
      tempoChange: decision.tempoChange,
      why: words.join('; '),
    });
    automation.push(...transitionCurves(i, decision.recipe, outgoing.deck, incoming.deck, start, overlap, midpoint));
    const riser = decision.riser ? riserFor(i, decision, start, swap, tempoMap) : null;
    if (riser) risers.push(riser);
  }
  return { transitions, automation, risers };
}

/** Plans a mix. Songs without analysis data still play (cut in and out); an empty list gives an empty plan. */
export function planMix(tracks: readonly MixTrackInput[], options: Partial<MixOptions> = {}): MixPlan {
  const opts: MixOptions = { ...DEFAULT_MIX_OPTIONS, ...options };
  const warnings: string[] = [];
  if (tracks.length === 0) return emptyPlan(warnings);

  // 1. Order.
  const order =
    opts.order === 'auto' ? autoOrder(tracks.map((t) => ({ analysis: t.analysis, pinned: !!t.pinned })), opts.energy) : tracks.map((_, i) => i);
  const ordered = order.map((i) => tracks[i]!);

  // 2. The tempo each song's beats are counted at.
  const keyLock = !!opts.keyLock;
  const fixedTempo = fixedTempoOf(opts);
  const songs = gridSongsFor(ordered, fixedTempo, warnings);

  // 3. What each transition does.
  const decisions: Decision[] = [];
  for (let i = 0; i < songs.length - 1; i++) decisions.push(decide(songs[i]!, songs[i + 1]!, opts, fixedTempo !== null));

  // 4. Lay out; with a length target take phrases off the longest songs until it fits.
  const shrink = new Array<number>(songs.length).fill(0);
  const fitted = fitLayout({ songs, decisions, shrink, fixedTempo, keyLock }, opts.lengthTargetMin, warnings);
  const { layout, tempoSteps, tempoCurve, totalTicks } = fitted;
  const tempoMap = steppedTempo(tempoSteps);

  // 5. Songs and their clips.
  const planned = plannedSongsOf(songs, layout, tempoMap, tempoSteps, { fixedTempo, keyLock });

  // 6. Transitions, their curves and risers.
  const { transitions, automation, risers } = plannedTransitionsOf(layout, planned, tempoMap);
  const barTicks = BEATS_PER_BAR * TICKS_PER_BEAT;
  const markers = planned.map((song, i) => ({
    tick: i === 0 ? Math.floor(song.start / barTicks) * barTicks : transitions[i - 1]!.start,
    name: song.title,
    song: song.id,
  }));
  return {
    songs: planned,
    transitions,
    automation,
    risers,
    markers,
    tempo: tempoSteps,
    tempoCurve,
    fixedTempo,
    totalTicks,
    durationSec: durationOfTempo(tempoSteps, totalTicks),
    warnings,
  };
}
