/**
 * The middle of the auto-mix planner: songs on their beat grids, what each transition does (`decide`), and where
 * every song sits in the mix (`layoutSongs`). Everything here counts in beats: a song's *local* beats count from its
 * first downbeat; *mix* beats count from the start of the playlist (960 ticks each).
 */
import { PPQ } from '../time/ppq';
import type { MixOptions, MixTrackInput, TransitionRecipe, TransitionTweak } from './plan-types';
import type { TrackAnalysis } from './types';
import { harmonicMove, TEMPO_LIMIT, trackEnergy, type HarmonicMove } from './wheel';

/** Ticks per beat. */
export const TICKS_PER_BEAT = PPQ;
/** Beats per playlist bar (the mix is in 4/4). */
export const BEATS_PER_BAR = 4;

/** Beats to ticks, rounded. */
export const ticksOf = (beats: number): number => Math.round(beats * TICKS_PER_BEAT);

/** Rounds a tempo to the thousandth of a BPM (what the tempo curve is written in). */
export const roundBpm = (bpm: number): number => Math.round(bpm * 1000) / 1000;

/** "12 %" for a share of 0.12. */
export const percent = (share: number): string => `${Math.round(share * 100)} %`;

/** A grid is trusted when the analysis found a tempo and is at least this sure of it. */
const MIN_GRID_CONFIDENCE = 0.25;

/** The most a transition's overlap can be given by hand (bars). */
const MAX_TWEAK_BARS = 64;
/** A tweaked overlap is rounded to whole phrases of this many bars. */
const TWEAK_BAR_STEP = 4;

/** An energy gap bigger than this (0–1) between two songs is a drop or a rise worth a recipe or riser. */
const ENERGY_JUMP = 0.12;

/** A transition that is not a cut but came out with no overlap gets this many bars. */
const MIN_OVERLAP_BARS = 8;

/** When a song's mix-out is too early it moves later by this many beats (8 bars: a phrase). */
const LATE_SHIFT_BEATS = 8 * BEATS_PER_BAR;
/** A length target takes this many beats (16 bars) off a song per step. */
const SHRINK_STEP_BEATS = 16 * BEATS_PER_BAR;
/** The shortest overlap the layout shrinks to before giving up and cutting (bars). */
const SHORTEST_OVERLAP_BARS = 4;
/** Overlaps longer than this halve when they don't fit; shorter ones lose 4 bars at a time. */
const HALVING_THRESHOLD_BARS = 16;
/** A last song cut short by a length target keeps at least this much after its entry (beats). */
const LAST_SONG_MIN_BEATS = 16 * BEATS_PER_BAR;

/** A song placed on its effective grid: local beats (from the first downbeat) of its landmarks. */
export interface GridSong {
  input: MixTrackInput;
  /** The song has a steady beat to match (otherwise it plays at its own speed and is cut in and out). */
  isBeatMatched: boolean;
  nativeBpm: number | null;
  /** The tempo its beats are counted at: its own, or half/double. */
  bpm: number;
  factor: 0.5 | 1 | 2;
  /** Seconds of the file where its first downbeat is. */
  firstDownbeatSec: number;
  beatsPerBar: number;
  beatSec: number;
  /** File start and end in local beats. */
  startBeat: number;
  endBeat: number;
  /** Bar-aligned mix-in and mix-out points (local beats). */
  mixInBeat: number;
  mixOutBeat: number;
  energy: number;
}

/** Whether the analysis found a beat grid to trust. */
export const hasGrid = (analysis: TrackAnalysis): boolean =>
  !!analysis.grid && analysis.grid.bpm > 0 && analysis.grid.confidence >= MIN_GRID_CONFIDENCE;

/** Puts a song on a grid counted at `bpm` (its own tempo, or half/double of it), with its bar-aligned mix points. */
export function toGridSong(input: MixTrackInput, bpm: number, factor: 0.5 | 1 | 2): GridSong {
  const analysis = input.analysis;
  const isBeatMatched = hasGrid(analysis);
  const firstDownbeatSec = isBeatMatched ? Math.max(0, analysis.grid!.firstDownbeat) : 0;
  const beatsPerBar = isBeatMatched ? Math.max(1, Math.round(analysis.grid!.beatsPerBar || 4)) : 4;
  const beatSec = 60 / bpm;
  const beatOf = (sec: number) => (sec - firstDownbeatSec) / beatSec;
  const startBeat = beatOf(0);
  const endBeat = beatOf(Math.max(0, analysis.durationSec));
  const firstBar = Math.ceil(startBeat / beatsPerBar - 1e-9) * beatsPerBar;
  const lastBar = Math.floor(endBeat / beatsPerBar + 1e-9) * beatsPerBar;
  const nearestBar = (beat: number) => Math.round(beat / beatsPerBar) * beatsPerBar;
  const mixInBeat = Math.min(Math.max(firstBar, nearestBar(beatOf(analysis.mixIn))), Math.max(firstBar, lastBar - beatsPerBar));
  let mixOutBeat = Math.min(nearestBar(beatOf(analysis.mixOut)), lastBar - beatsPerBar);
  if (!(mixOutBeat > mixInBeat)) mixOutBeat = Math.max(mixInBeat, lastBar - beatsPerBar);
  return {
    input,
    isBeatMatched,
    nativeBpm: isBeatMatched ? analysis.grid!.bpm : null,
    bpm,
    factor,
    firstDownbeatSec,
    beatsPerBar,
    beatSec,
    startBeat,
    endBeat,
    mixInBeat,
    mixOutBeat,
    energy: trackEnergy(analysis),
  };
}

/** What happens between two songs. */
export interface Decision {
  /** Overlap in bars (0 for a cut). */
  bars: number;
  recipe: TransitionRecipe;
  riser: boolean;
  /** Tempos close enough to ramp between (both beat-matched). */
  rampable: boolean;
  move: HarmonicMove;
  tempoChange: number;
  /** Plain-words reasons, joined for the transitions list. */
  why: string[];
}

/** The overlap a transition style asks for before anything about the songs is known (bars). */
function styleOverlapBars(opts: MixOptions): number {
  switch (opts.transition) {
    case 'smooth':
      return 32;
    case 'quick':
      return 8;
    case 'cut':
      return 0;
    case 'auto':
      return opts.energy === 'chill' ? 32 : 16;
  }
}

/** The choices a transition is made of, before the musician's tweak is applied. */
interface Choice {
  bars: number;
  recipe: TransitionRecipe;
  riser: boolean;
}

/** Applies the musician's tweak of one transition to what was chosen (a tweak never makes tempos that can't blend blend). */
function applyTweak(choice: Choice, tweak: TransitionTweak, rampable: boolean, why: string[]): void {
  if (tweak.recipe) {
    if (tweak.recipe !== 'cut' && !rampable) why.push('kept as a cut (the tempos are too far apart to blend)');
    else choice.recipe = tweak.recipe;
  }
  if (tweak.bars !== undefined && Number.isFinite(tweak.bars)) {
    const bars = Math.max(0, Math.min(MAX_TWEAK_BARS, Math.round(tweak.bars / TWEAK_BAR_STEP) * TWEAK_BAR_STEP));
    if (bars === 0) {
      choice.recipe = 'cut';
    } else if (rampable) {
      choice.bars = bars;
      if (choice.recipe === 'cut' && !tweak.recipe) choice.recipe = 'bass-swap';
    }
  }
  if (tweak.riser !== undefined) choice.riser = tweak.riser;
}

/** Decides how song `outgoing` hands over to song `incoming`: overlap, recipe, riser, and why. */
export function decide(outgoing: GridSong, incoming: GridSong, opts: MixOptions, isFixedTempo: boolean): Decision {
  const move = harmonicMove(outgoing.input.analysis.key, incoming.input.analysis.key);
  const tempoChange = isFixedTempo ? 0 : incoming.bpm / outgoing.bpm - 1;
  // Neither song may move further than the limit from its own tempo.
  const tempoGap = Math.max(incoming.bpm / outgoing.bpm, outgoing.bpm / incoming.bpm) - 1;
  const rampable = outgoing.isBeatMatched && incoming.isBeatMatched && (isFixedTempo || tempoGap <= TEMPO_LIMIT + 1e-9);
  const why: string[] = [];
  const choice: Choice = { bars: styleOverlapBars(opts), recipe: 'bass-swap', riser: false };
  const isDrop = incoming.energy < outgoing.energy - ENERGY_JUMP;
  const isRise = incoming.energy > outgoing.energy + ENERGY_JUMP;
  if (!rampable) {
    choice.recipe = 'cut';
    const reason = !outgoing.isBeatMatched || !incoming.isBeatMatched ? 'no steady beat to match' : `tempos ${percent(Math.abs(tempoChange))} apart: a cut`;
    why.push(reason);
  } else if (opts.transition === 'cut') {
    choice.recipe = 'cut';
  } else if (move === 'clash') {
    choice.recipe = 'echo';
    choice.bars = Math.min(choice.bars, 8);
    why.push('keys clash: a short overlap that echoes out');
  } else if (isDrop) {
    choice.recipe = 'filter';
    why.push('energy drops: the outgoing song filters out');
  }
  choice.riser = rampable && isRise && opts.energy !== 'chill' && opts.transition !== 'cut';
  if (choice.riser) why.push('energy rises: a riser into the swap');
  const tweak = opts.tweaks?.[incoming.input.id];
  if (tweak) applyTweak(choice, tweak, rampable, why);
  if (choice.recipe === 'cut') choice.bars = 0;
  else if (choice.bars === 0) choice.bars = MIN_OVERLAP_BARS;
  return { bars: choice.bars, recipe: choice.recipe, riser: choice.riser, rampable, move, tempoChange, why };
}

/** Where the songs sit in the mix. */
export interface Layout {
  songs: GridSong[];
  decisions: Decision[];
  /** Exit start (local beat) per song (all but the last), the overlap (beats) of each transition, the last song's end. */
  exitBeats: number[];
  overlapBeats: number[];
  lastEndBeat: number;
  /** The last song is cut short by a length target and fades out. */
  lastFades: boolean;
  /** The mix beat where each song's local beat 0 sits: placing a song is choosing this. */
  placements: number[];
}

/** Whether both songs have audio for a whole overlap (the incoming one also needs a bar after it). */
function overlapFits(outgoing: GridSong, incoming: GridSong, exitBeat: number, overlapBars: number): boolean {
  const outgoingAudioEnd = Math.floor(outgoing.endBeat + 1e-9);
  const incomingAudioEnd = Math.floor(incoming.endBeat + 1e-9);
  return (
    exitBeat + overlapBars * BEATS_PER_BAR <= outgoingAudioEnd &&
    incoming.mixInBeat + overlapBars * BEATS_PER_BAR + BEATS_PER_BAR <= incomingAudioEnd
  );
}

/**
 * Where song `outgoing` exits into `incoming`, and how long they overlap. Moves the exit and shortens the overlap until
 * both songs have the audio for it; settles on a cut (and says so in `decision`) when nothing fits.
 */
function placeExit(
  outgoing: GridSong,
  incoming: GridSong,
  decision: Decision,
  options: { shrinkSteps: number; earliestExit: number },
): { exitBeat: number; bars: number } {
  const { earliestExit } = options;
  const audioEnd = Math.floor(outgoing.endBeat + 1e-9);
  // The analysis's mix-out point, moved later by phrases (8 bars) when it comes too early, and
  // earlier by 16 bars per shrink step (never before the earliest exit).
  let exitBeat = outgoing.mixOutBeat;
  if (exitBeat < earliestExit) {
    exitBeat = earliestExit + ((((outgoing.mixOutBeat - earliestExit) % LATE_SHIFT_BEATS) + LATE_SHIFT_BEATS) % LATE_SHIFT_BEATS);
  }
  const shrinkSteps = Math.min(options.shrinkSteps, Math.floor((exitBeat - earliestExit) / SHRINK_STEP_BEATS));
  exitBeat -= shrinkSteps * SHRINK_STEP_BEATS;
  let bars = decision.bars;
  // Both songs need audio for the whole overlap (the incoming one also needs a bar after it).
  while (bars > SHORTEST_OVERLAP_BARS && !overlapFits(outgoing, incoming, exitBeat, bars)) {
    bars = bars > HALVING_THRESHOLD_BARS ? bars / 2 : bars - 4;
  }
  while (bars > 0 && !overlapFits(outgoing, incoming, exitBeat, bars) && exitBeat - LATE_SHIFT_BEATS >= earliestExit) {
    exitBeat -= LATE_SHIFT_BEATS;
  }
  if (bars > 0 && !overlapFits(outgoing, incoming, exitBeat, bars)) {
    bars = 0;
    decision.recipe = 'cut';
    decision.why.push('too little music left for an overlap: a cut');
  }
  if (bars === 0 && exitBeat > audioEnd) exitBeat = Math.max(earliestExit, Math.floor(audioEnd / outgoing.beatsPerBar) * outgoing.beatsPerBar);
  return { exitBeat, bars };
}

/** Places the songs with `shrink[i]` phrases (16 bars) taken off song i's mix-out point. */
export function layoutSongs(songs: GridSong[], decisions: Decision[], shrink: readonly number[]): Layout {
  const count = songs.length;
  const exitBeats: number[] = [];
  const overlapBeats: number[] = [];
  const copiedDecisions = decisions.map((decision) => ({ ...decision, why: decision.why.slice() }));
  let previousOverlap = 0;
  for (let i = 0; i < count - 1; i++) {
    const outgoing = songs[i]!;
    const incoming = songs[i + 1]!;
    const decision = copiedDecisions[i]!;
    const entry = i === 0 ? Math.max(0, Math.ceil(outgoing.startBeat / outgoing.beatsPerBar - 1e-9) * outgoing.beatsPerBar) : outgoing.mixInBeat;
    // Earliest exit: after the previous transition (and a bar of its own).
    const earliestExit = entry + previousOverlap + (i === 0 ? 0 : BEATS_PER_BAR);
    const placed = placeExit(outgoing, incoming, decision, { shrinkSteps: shrink[i] ?? 0, earliestExit });
    if (placed.bars !== decision.bars && placed.bars > 0) decision.why.push(`${placed.bars} bars (the songs are too short for ${decision.bars})`);
    decision.bars = placed.bars;
    if (placed.bars === 0) decision.recipe = 'cut';
    exitBeats.push(placed.exitBeat);
    overlapBeats.push(placed.bars * BEATS_PER_BAR);
    previousOverlap = placed.bars * BEATS_PER_BAR;
  }
  const { lastEndBeat, lastFades } = placeLastSong(songs, shrink, previousOverlap);
  // Placement: the first song from the file's start (its first downbeat on a bar line).
  const placements: number[] = [];
  const first = songs[0]!;
  placements.push(count === 0 ? 0 : Math.max(0, Math.ceil(-first.startBeat / BEATS_PER_BAR - 1e-9) * BEATS_PER_BAR));
  for (let i = 0; i < count - 1; i++) placements.push(placements[i]! + exitBeats[i]! - songs[i + 1]!.mixInBeat);
  return { songs, decisions: copiedDecisions, exitBeats, overlapBeats, lastEndBeat, lastFades, placements };
}

/** The last song plays to its end, or mixes out by phrases to meet a length target (with a fade). */
function placeLastSong(songs: GridSong[], shrink: readonly number[], previousOverlap: number): { lastEndBeat: number; lastFades: boolean } {
  const count = songs.length;
  const last = songs[count - 1]!;
  const lastShrink = shrink[count - 1] ?? 0;
  const earliestEnd = (count === 1 ? Math.max(0, last.mixInBeat) : last.mixInBeat + previousOverlap) + LAST_SONG_MIN_BEATS;
  if (lastShrink <= 0) return { lastEndBeat: last.endBeat, lastFades: false };
  const lastEndBeat = Math.max(
    Math.min(last.endBeat, earliestEnd),
    Math.floor(last.endBeat / BEATS_PER_BAR) * BEATS_PER_BAR - lastShrink * SHRINK_STEP_BEATS,
  );
  return { lastEndBeat, lastFades: lastEndBeat < last.endBeat - 1e-6 };
}
