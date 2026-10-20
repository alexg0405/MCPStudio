/**
 * The drums of a song's patterns: each style's own grid (`drumGridOf`) at four strengths. A verse plays the groove plain,
 * a build adds sixteenth hats that rise, a chorus adds the style's fills (hat rolls, an open hat, a syncopated kick), the
 * last chorus adds more. The notes are placed with a seeded hand, so another seed moves the extra kick hits.
 */
import { FOUR_FLOOR, GROOVE, type Style } from '../beat/style';
import { drumGridOf, accent } from '../beat/local/drums';
import type { BeatNote, BeatTrack } from '../beat/spec';
import { PATTERN_BARS, PATTERN_STEPS, STEPS_PER_BAR } from './harmony';
import { streamFor, type Rng } from './rng';

/** How much drum a pattern has: a plain groove, the lead-in to a chorus, a full chorus, the biggest chorus. */
export type DrumTier = 'light' | 'build' | 'full' | 'peak';

/** The kick hits a style never adds on top of its grid: its drums are the groove (four on the floor, dembow). */
const FIXED_KICK_STYLES: ReadonlySet<Style> = new Set<Style>([...FOUR_FLOOR, 'reggaeton']);
/** Styles where the beat's last bar leads back with a kick just before the loop restarts. */
const PICKUP_STYLES: ReadonlySet<Style> = new Set<Style>(['trap', 'drill', 'boombap', 'lofi', 'afro', 'pop']);
/** The steps of a bar an extra kick may land on (the "and" and "a" of the beats): never on the backbeat. */
const EXTRA_KICK_STEPS = [3, 6, 10, 11, 14] as const;
/** How likely a bar of the pattern's second half gets an extra kick, per tier. */
const EXTRA_KICK_CHANCE: Record<DrumTier, number> = { light: 0.25, build: 0, full: 0.6, peak: 0.9 };
/** The velocity of an added kick and of the pickup kick. */
const EXTRA_KICK_VELOCITY = 0.7;
/** Hats of a build rise from this velocity to the next over the pattern's four bars. */
const BUILD_HAT_START = 0.3;
const BUILD_HAT_END = 0.9;
/** The sounds an extra kick keeps clear of (a kick right next to the snare muddies the backbeat). */
const BACKBEAT_SOUNDS: ReadonlySet<string> = new Set(['snare', 'clap', 'rim']);
/** Parts a plain groove leaves out: the open hat and rim fill in the busier tiers. */
const LIGHT_LEAVES_OUT: ReadonlySet<string> = new Set(['open-hat', 'rim']);

/** Notes of a one-bar grid played every bar: X is a full hit, o a ghost, x a hit the style's accent fills in. */
function tiledGrid(grid: string, style: Style): BeatNote[] {
  const notes: BeatNote[] = [];
  for (let bar = 0; bar < PATTERN_BARS; bar++) {
    for (let i = 0; i < grid.length; i++) {
      const mark = grid[i];
      if (mark === undefined || mark === '.') continue;
      const note: BeatNote = { step: bar * STEPS_PER_BAR + i, len: 1 };
      if (mark === 'X') note.vel = 1;
      if (mark === 'o') note.vel = GROOVE[style].ghost * 0.8;
      notes.push(note);
    }
  }
  return notes;
}

const trackOf = (name: string, sound: BeatTrack['sound'], notes: BeatNote[]): BeatTrack => ({ name, sound, notes });

/** The steps of a bar (0 to 15) that already have a hit on `tracks`. */
function occupiedSteps(tracks: readonly BeatTrack[]): Set<number> {
  const taken = new Set<number>();
  for (const track of tracks) for (const note of track.notes) taken.add(Math.round(note.step) % STEPS_PER_BAR);
  return taken;
}

/** Extra kick hits in the second and fourth bar, off the backbeat, so the groove keeps moving. */
function addExtraKicks(kick: BeatTrack, others: readonly BeatTrack[], tier: DrumTier, random: Rng): void {
  const taken = occupiedSteps(others);
  for (const bar of [1, 3]) {
    if (!random.chance(EXTRA_KICK_CHANCE[tier])) continue;
    const free = EXTRA_KICK_STEPS.filter((step) => !taken.has(step) && !taken.has(step - 1) && !taken.has(step + 1));
    const barKicks = kick.notes.filter((note) => Math.floor(note.step / STEPS_PER_BAR) === bar).map((note) => note.step % STEPS_PER_BAR);
    const choices = free.filter((step) => !barKicks.includes(step));
    if (choices.length === 0) continue;
    kick.notes.push({ step: bar * STEPS_PER_BAR + random.pick(choices), len: 1, vel: EXTRA_KICK_VELOCITY });
  }
  kick.notes.sort((a, b) => a.step - b.step);
}

/** A rolled burst of hat notes from `from` to `to` (steps), `perStep` notes to the step, rising in velocity. */
function hatRoll(from: number, to: number, perStep: 2 | 3): BeatNote[] {
  const notes: BeatNote[] = [];
  const count = Math.round((to - from) * perStep);
  for (let i = 0; i < count; i++) {
    const step = Math.round((from + i / perStep) * 6) / 6;
    notes.push({ step, len: 1 / perStep, vel: 0.5 + (0.4 * i) / Math.max(1, count - 1) });
  }
  return notes;
}

/** Trap-style hat rolls: the last half beat of the fourth bar, at the peak also of the second bar and before the snare. */
function addHatRolls(hat: BeatTrack, style: Style, tier: DrumTier): void {
  const perStep = GROOVE[style].roll === 24 ? 3 : 2;
  const rolls: [number, number][] = [[PATTERN_STEPS - 2, PATTERN_STEPS]];
  if (tier === 'peak') rolls.push([STEPS_PER_BAR * 2 - 2, STEPS_PER_BAR * 2], [STEPS_PER_BAR * 2 + 6, STEPS_PER_BAR * 2 + 8]);
  for (const [from, to] of rolls) {
    hat.notes = hat.notes.filter((note) => note.step < from || note.step >= to);
    hat.notes.push(...hatRoll(from, to, perStep));
  }
  hat.notes.sort((a, b) => a.step - b.step);
}

/** A build's hats: sixteenths that rise in velocity across the pattern. */
function buildHats(): BeatNote[] {
  return Array.from({ length: PATTERN_STEPS }, (_, step) => ({
    step,
    len: 1,
    vel: BUILD_HAT_START + ((BUILD_HAT_END - BUILD_HAT_START) * step) / (PATTERN_STEPS - 1),
  }));
}

/** An open hat on the last offbeat of the second and fourth bars (for styles without an open-hat part). */
function addOpenHats(tracks: BeatTrack[]): void {
  if (tracks.some((track) => track.sound === 'open-hat')) return;
  const notes = [1, 3].map((bar) => ({ step: bar * STEPS_PER_BAR + 14, len: 2, vel: 0.7 }));
  tracks.push(trackOf('Open hat', 'open-hat', notes));
}

/** What a request that names no hats leaves out. */
const HAT_SOUNDS: ReadonlySet<string> = new Set(['hat', 'open-hat']);

/** How a request's wish for busier or simpler drums changes the tier. */
function tierFor(tier: DrumTier, density: number): DrumTier {
  if (density > 0 && tier === 'full') return 'peak';
  if (density < 0 && tier === 'peak') return 'full';
  if (density < 0 && tier === 'full') return 'light';
  return tier;
}

/** Everything that shapes one pattern's drums. */
export interface DrumOptions {
  style: Style;
  tier: DrumTier;
  seed: number;
  /** A name for this pattern's own random stream ("verse"), so two patterns do not get the same extra kicks. */
  label: string;
  /** −1 simpler … +1 busier. */
  density: number;
  noHats: boolean;
}

/** The drum tracks of a four-bar pattern, with the style's accents; no volumes (the writer gives each drum its level). */
export function songDrums(options: DrumOptions): BeatTrack[] {
  const { style, seed, label, noHats } = options;
  const tier = tierFor(options.tier, options.density);
  const random = streamFor(seed, `drums:${label}`);
  const names: Record<string, [string, BeatTrack['sound']]> = {
    kick: ['Kick', 'kick'],
    snare: ['Snare', 'snare'],
    clap: ['Clap', 'clap'],
    hat: ['Hat', 'hat'],
    'open-hat': ['Open hat', 'open-hat'],
    rim: ['Rim', 'rim'],
  };
  const tracks: BeatTrack[] = [];
  for (const [part, grid] of Object.entries(drumGridOf(style))) {
    const [name, sound] = names[part] ?? [part, 'snare'];
    if ((tier === 'light' || tier === 'build') && LIGHT_LEAVES_OUT.has(part)) continue;
    let notes = tiledGrid(grid, style);
    if (tier === 'light' || tier === 'build') notes = notes.filter((note) => note.vel === undefined || note.vel >= 0.5);
    tracks.push(trackOf(name, sound, notes));
  }
  const kick = tracks.find((track) => track.sound === 'kick');
  const hat = tracks.find((track) => track.sound === 'hat');
  const backbeat = tracks.filter((track) => BACKBEAT_SOUNDS.has(track.sound));
  if (kick && !FIXED_KICK_STYLES.has(style) && tier !== 'build') addExtraKicks(kick, backbeat, tier, random);
  if (hat && tier === 'build') hat.notes = buildHats();
  if (hat && (tier === 'full' || tier === 'peak') && (style === 'trap' || style === 'drill')) addHatRolls(hat, style, tier);
  if (tier === 'peak') addOpenHats(tracks);
  if (kick && PICKUP_STYLES.has(style) && tier !== 'build') {
    const pickup = PATTERN_STEPS - 2;
    if (!kick.notes.some((note) => note.step === pickup)) kick.notes.push({ step: pickup, len: 1, vel: EXTRA_KICK_VELOCITY });
    kick.notes.sort((a, b) => a.step - b.step);
  }
  const kept = tracks.filter((track) => !(noHats && HAT_SOUNDS.has(track.sound)));
  for (const track of kept) accent(track, style);
  return kept;
}
