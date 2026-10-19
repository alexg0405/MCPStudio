import { applyAccents } from '../groove';
import { EDM_DRUMS, isEdmStyle, type EdmStyle } from '../local-edm';
import type { BeatNote, BeatTrack } from '../spec';
import { STEPS_PER_BAR } from '../spec';
import { GROOVE, type Style } from '../style';
import type { PerformedEvent, PromptInfo } from './types';

/**
 * Drum grids per style: one bar, 16 steps; X = accent, x = hit (the style's accent for that spot),
 * o = ghost. Boom bap and lo-fi hats hit odd 1/16s (the ones the swing pushes late).
 */
const DRUMS: Record<Exclude<Style, EdmStyle>, Record<string, string>> = {
  trap: {
    kick: 'x......x..x.....',
    clap: '........X.......',
    hat: 'x.x.x.x.x.x.x.x.',
  },
  drill: {
    kick: 'x.....x...x..x..',
    snare: '........X....o..',
    hat: 'x..x..x.x..x..x.',
  },
  boombap: {
    kick: 'X......x..x.....',
    snare: '....X....o..X..o',
    hat: 'x.xox.x.x.xox.xx',
  },
  lofi: {
    kick: 'x.......x..x....',
    snare: '....x.......x...',
    hat: 'x.xox.x.x.xox.x.',
  },
  house: {
    kick: 'X...X...X...X...',
    clap: '....x.......x...',
    hat: '..x...x...x...x.',
  },
  edm: {
    kick: 'X...X...X...X...',
    clap: '....X.......X...',
    hat: 'x.x.x.x.x.x.x.x.',
    'open-hat': '..x...x...x...x.',
  },
  reggaeton: {
    kick: 'X...X...X...X...',
    snare: '...x..x....x..x.',
    hat: 'x.x.x.x.x.x.x.x.',
  },
  afro: {
    kick: 'x..x..x...x..x..',
    rim: '..x...x...x.x...',
    hat: 'x.xxx.x.x.xxx.x.',
  },
  pop: {
    kick: 'X.....x.X.......',
    clap: '....X.......X...',
    hat: 'x.x.x.x.x.x.x.x.',
  },
};

/** Loop length per style in bars: chords take four; trap, drill and boom bap two (a pickup, slides). */
export const LOOP_BARS: Record<Exclude<Style, EdmStyle>, number> = {
  trap: 2,
  drill: 2,
  boombap: 2,
  lofi: 4,
  house: 1,
  edm: 4,
  reggaeton: 1,
  afro: 1,
  pop: 4,
};

const DRUM_SOUND: Record<string, BeatTrack['sound']> = {
  kick: 'kick',
  snare: 'snare',
  clap: 'clap',
  hat: 'hat',
  'open-hat': 'open-hat',
  rim: 'rim',
};

/** The track names the generator gives each drum part. */
const NAMES: Record<string, string> = {
  kick: 'Kick',
  snare: 'Snare',
  clap: 'Clap',
  hat: 'Hat',
  'open-hat': 'Open hat',
  rim: 'Rim',
};

/** A ghost note plays at this share of the style's ghost velocity. */
const GHOST_SHARE = 0.8;
/** A drum note's velocity when nothing else sets one. */
const DEFAULT_DRUM_VELOCITY = 0.8;
/** The pickup kick that leads a long loop back to its start: velocity and the step in the last bar. */
const PICKUP_VELOCITY = 0.7;
const PICKUP_STEP_IN_BAR = 14;
/** The kick the "busier" request adds, this many steps before the loop's end. */
const BUSY_KICK_STEPS_FROM_END = 3;

/** The parts of a style's drum grid, in the order the tracks are made. */
export function drumGridOf(style: Style): Record<string, string> {
  return isEdmStyle(style) ? EDM_DRUMS[style] : DRUMS[style];
}

/** Notes of a grid; plain hits have no velocity yet (the style's accents fill them in). */
function fromGrid(grid: string, bars: number, style: Style): BeatNote[] {
  const notes: BeatNote[] = [];
  for (let bar = 0; bar < bars; bar++) {
    for (let i = 0; i < grid.length; i++) {
      const c = grid[i];
      if (c === '.' || c === undefined) continue;
      const note: BeatNote = { step: bar * STEPS_PER_BAR + i, len: 1 };
      if (c === 'X') note.vel = 1;
      else if (c === 'o') note.vel = GROOVE[style].ghost * GHOST_SHARE;
      notes.push(note);
    }
  }
  return notes;
}

/** Fills in the velocities a track's notes don't have yet with the style's accents. */
export function accent(track: BeatTrack, style: Style): BeatTrack {
  applyAccents(
    track,
    track.notes.map((n) => n.vel === undefined),
    style,
  );
  for (const n of track.notes) n.vel ??= DEFAULT_DRUM_VELOCITY;
  return track;
}

/** Trap/drill hat rolls: 1/32 (or triplet) bursts before the snare and at the end of the bar. */
function addRolls(notes: BeatNote[], bars: number, triplet: boolean): BeatNote[] {
  const out = notes.filter((n) => {
    const s = n.step % STEPS_PER_BAR;
    return !(s >= 6 && s < 8) && !(s >= 14);
  });
  for (let bar = 0; bar < bars; bar++) {
    const base = bar * STEPS_PER_BAR;
    const roll = (from: number, to: number, div: number) => {
      for (let s = from; s < to - 1e-9; s += 1 / div) {
        out.push({ step: base + Math.round(s * 6) / 6, len: 1 / div, vel: 0.55 + 0.35 * ((s - from) / (to - from)) });
      }
    };
    if (bar % 2 === 1 || bars === 1) roll(14, 16, triplet ? 3 : 2);
    roll(6, 8, 2);
  }
  return out.sort((a, b) => a.step - b.step);
}

/** The performed events of one kind (only when the performance is drums). */
export type PerformedDrums = (kind: PerformedEvent['kind']) => readonly PerformedEvent[];

/** What shapes the drum tracks: the style, loop length, the request and what the user beatboxed. */
export interface DrumPlan {
  style: Style;
  bars: number;
  info: PromptInfo;
  /** What the user beatboxed, by kind (nothing unless the performance is drums). */
  performed: PerformedDrums;
}

/** One part of the grid, after the request's changes: hat rolls, simpler or busier hats, an extra kick. */
function gridNotesFor(part: string, grid: string, plan: DrumPlan): BeatNote[] {
  const { style, bars, info } = plan;
  const total = bars * STEPS_PER_BAR;
  let notes = fromGrid(grid, bars, style);
  if (part === 'hat') {
    if (style === 'trap' || style === 'drill')
      notes = info.density >= 0 ? addRolls(notes, bars, style === 'drill') : notes;
    if (info.density < 0) notes = notes.filter((n) => n.step % 4 === 0);
    if (info.density > 0 && style !== 'trap' && style !== 'drill') {
      notes = [...notes, ...notes.map((n) => ({ ...n, step: n.step + 1, vel: 0.45 }))].filter((n) => n.step < total);
    }
  } else if (part === 'kick' && info.density > 0) {
    notes = [...notes, { step: total - BUSY_KICK_STEPS_FROM_END, len: 1, vel: 0.7 }];
  }
  return notes;
}

/** The style's drum grid, replaced part by part by what the user beatboxed. No volumes: the beat writer gives each drum its level. */
export function drumTracks(plan: DrumPlan): BeatTrack[] {
  const tracks: BeatTrack[] = [];
  for (const [part, grid] of Object.entries(drumGridOf(plan.style))) {
    if ((part === 'hat' || part === 'open-hat') && plan.info.noHats) continue;
    const beatboxedKind = part === 'clap' || part === 'rim' ? 'snare' : (part as PerformedEvent['kind']);
    const own = plan.performed(beatboxedKind);
    const notes =
      own.length > 0
        ? own.map((e) => ({
            step: e.step,
            len: Math.max(0.5, Math.min(e.lengthSteps, 4)),
            vel: Math.max(0.3, e.strength),
          }))
        : gridNotesFor(part, grid, plan);
    tracks.push({ name: NAMES[part] ?? part, sound: DRUM_SOUND[part] ?? 'snare', notes });
  }
  return tracks;
}

/** Beatboxed sounds the style has no part for still get a track. */
export function extraBeatboxTracks(tracks: BeatTrack[], performed: PerformedDrums): void {
  for (const kind of ['kick', 'snare', 'hat'] as const) {
    const own = performed(kind);
    const hasPart = tracks.some(
      (t) => t.sound === kind || (kind === 'snare' && (t.sound === 'clap' || t.sound === 'rim')),
    );
    if (own.length === 0 || hasPart) continue;
    tracks.push({
      name: NAMES[kind] as string,
      sound: kind,
      notes: own.map((e) => ({ step: e.step, len: 1, vel: Math.max(0.3, e.strength) })),
    });
  }
}

/** Movement in longer loops: a kick pickup into the turnaround (the 808 follows it). */
export function addKickPickup(tracks: BeatTrack[], bars: number): void {
  const kickTrack = tracks.find((t) => t.sound === 'kick');
  if (!kickTrack) return;
  const pickup = (bars - 1) * STEPS_PER_BAR + PICKUP_STEP_IN_BAR;
  if (kickTrack.notes.some((n) => n.step === pickup)) return;
  kickTrack.notes.push({ step: pickup, len: 1, vel: PICKUP_VELOCITY });
  kickTrack.notes.sort((a, b) => a.step - b.step);
}
