import { EDM_LOOP, edmTracks, isEdmStyle } from '../local-edm';
import type { BeatNote, BeatSpec, BeatTrack } from '../spec';
import { STEPS_PER_BAR } from '../spec';
import { GROOVE, STYLE_LABELS, TEMPO, type Style } from '../style';
import { bassKey, chords } from '../theory';
import { eightOhEight, offbeatBass, subUnderKick } from './bass';
import { LOOP_BARS, accent, addKickPickup, drumTracks, extraBeatboxTracks, type PerformedDrums } from './drums';
import { decideRole, tonalNotes } from './performance';
import { parsePrompt } from './prompt';
import { PROGRESSIONS } from './progressions';
import type { LocalBeatInput, PerformanceRole, PerformedEvent, PromptInfo } from './types';

/** The longest loop the generator writes (bars). */
const MAX_LOOP_BARS = 4;
/** Styles that default to a major key (the rest default to minor). */
const MAJOR_BY_DEFAULT: readonly Style[] = ['house', 'afro', 'reggaeton', 'pop', 'futurebass'];
/** Styles with no kick pickup into the turnaround. */
const NO_PICKUP_STYLES: readonly Style[] = ['house', 'edm', 'reggaeton'];
/** The 808 follows a hummed line this high above its root (a 5th), and glides between notes. */
const PERFORMED_808_ABOVE_ROOT = 7;
/** A hummed melody is placed around this key (G4), with this fallback above the root for unpitched events. */
const MELODY_CENTER = 67;
const MELODY_FALLBACK_BASE = 60;

/** The key's root for a style when the request names none: F for the heavy styles, E♭ for future bass, A for the rest. */
function defaultRoot(style: Style): number {
  if (style === 'trap' || style === 'drill' || style === 'dubstep' || style === 'melodicdub') return 5;
  if (style === 'futurebass') return 3;
  return 9;
}

/** Everything decided before any track is written. */
interface BeatPlan {
  info: PromptInfo;
  style: Style;
  perf: NonNullable<LocalBeatInput['performance']> | undefined;
  /** What the performance stands for, null without one. */
  role: Exclude<PerformanceRole, 'auto'> | null;
  bars: number;
  /** Loop length in 1/16 steps. */
  total: number;
  minor: boolean;
  /** The key's root pitch class. */
  root: number;
  /** The 808's root (C1-based octave) and a synth bass's root (its sub oscillator plays an octave lower). */
  root808: number;
  rootBass: number;
}

function planOf(input: LocalBeatInput): BeatPlan {
  const info = parsePrompt(input.prompt);
  const style: Style = info.style ?? (info.wants808 ? 'trap' : 'boombap');
  const perf = input.performance && input.performance.events.length > 0 ? input.performance : undefined;
  const styleBars = isEdmStyle(style) ? EDM_LOOP[style] : LOOP_BARS[style];
  const bars = Math.max(1, Math.min(MAX_LOOP_BARS, perf?.bars ?? styleBars));
  const root = info.key?.root ?? defaultRoot(style);
  return {
    info,
    style,
    perf,
    role: perf ? decideRole(perf.role, perf.events, info) : null,
    bars,
    total: bars * STEPS_PER_BAR,
    minor: info.key?.minor ?? !MAJOR_BY_DEFAULT.includes(style),
    root,
    root808: 24 + root,
    rootBass: 36 + root,
  };
}

/** The drum tracks: the style's grid with the user's beatboxing in place of what it replaces, a pickup kick, the style's accents. */
function drumsOf(plan: BeatPlan): BeatTrack[] {
  const { perf, role, info, style, bars } = plan;
  const performed: PerformedDrums = (kind) =>
    role === 'drums' && perf ? perf.events.filter((e: PerformedEvent) => e.kind === kind) : [];
  const tracks = drumTracks({ style, bars, info, performed });
  if (role === 'drums' && perf) extraBeatboxTracks(tracks, performed);
  if (bars >= 2 && role !== 'drums' && !NO_PICKUP_STYLES.includes(style) && !isEdmStyle(style)) {
    addKickPickup(tracks, bars);
  }
  // The style's accents for every drum hit that has no velocity yet.
  for (const t of tracks) accent(t, style);
  return tracks;
}

/** The bass part: a hummed 808, the EDM pack's own parts, an 808 on the kick, a sub under it, or an offbeat bass. */
function bassTracks(plan: BeatPlan, kick: readonly BeatNote[], prompt: string): BeatTrack[] {
  const { info, style, perf, role, bars, total, minor, root, root808, rootBass } = plan;
  const scale = minor ? 'minor' : 'major';
  if (role === '808' && perf) {
    const notes = tonalNotes(perf.events, root808 + PERFORMED_808_ABOVE_ROOT, info.key, root808, total, true);
    return [{ name: '808', sound: '808', notes, params: { glide: 0.09, decay: 2.2 } }];
  }
  if (isEdmStyle(style)) {
    // The EDM pack's own parts: bass, chords and hooks per style (local-edm.ts).
    const neuro = /\bneuro(funk)?\b|\breese\b|\bdark\b/.test(prompt.toLowerCase());
    return edmTracks(style, { bars, root, minor, kick, neuro });
  }
  if (info.wants808 || style === 'trap' || style === 'drill' || style === 'reggaeton') {
    // Every bar of a drill loop slides; trap and reggaeton slide into the loop's restart.
    return [{ name: '808', sound: '808', notes: eightOhEight(kick, bars, root808, minor, style === 'drill') }];
  }
  if (style === 'boombap' || style === 'afro' || style === 'pop') {
    // A sub bass under the kick (boom bap moves to the iv in bar 2; pop follows its chords).
    const roots = style === 'pop' ? PROGRESSIONS.anthem[scale].map(([d]) => d) : style === 'boombap' ? [0, 5] : [0];
    return [{ name: 'Bass', sound: 'bass', notes: subUnderKick(kick, bars, rootBass, roots) }];
  }
  if (style === 'house' || style === 'edm') {
    // Offbeat bass (EDM: on its chords' roots).
    const roots: readonly number[] = style === 'edm' ? PROGRESSIONS.anthem[scale].map(([d]) => d) : [0];
    return [{ name: 'Bass', sound: 'bass', notes: offbeatBass(bars, rootBass, roots) }];
  }
  return [];
}

/** Lo-fi: four bars of 7th chords on mellow keys (held, then a lazy re-strike), and a soft bass on their roots. */
function lofiTracks(plan: BeatPlan): BeatTrack[] {
  const { minor, root, bars, rootBass } = plan;
  const prog = PROGRESSIONS.sevenths[minor ? 'minor' : 'major'];
  const keys: BeatTrack = {
    name: 'Keys',
    sound: 'keys',
    notes: chords(prog, root, bars, [
      [0, 10, 0.72],
      [10, 6, 0.58],
    ]),
  };
  const bass: BeatNote[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const key = bassKey(rootBass + prog[bar % prog.length]![0]);
    bass.push({ step: bar * STEPS_PER_BAR, len: 7.5, key, vel: 0.8 });
    bass.push({ step: bar * STEPS_PER_BAR + 10, len: 5.5, key, vel: 0.7 });
  }
  return [keys, { name: 'Bass', sound: 'bass', notes: bass }];
}

/** Chords on top: lo-fi keys with a bass, an EDM pad, pop keys; and a hummed melody when that was the role. */
function harmonyTracks(plan: BeatPlan): BeatTrack[] {
  const { style, role, perf, minor, root, bars, total, info } = plan;
  const progression = PROGRESSIONS.anthem[minor ? 'minor' : 'major'];
  const tracks: BeatTrack[] = [];
  if (style === 'lofi' && role !== '808') {
    tracks.push(...lofiTracks(plan));
  } else if (style === 'edm') {
    tracks.push({ name: 'Pad', sound: 'pad', notes: chords(progression, root, bars, [[0, 16, 0.7]], 53) });
  } else if (style === 'pop') {
    tracks.push({
      name: 'Keys',
      sound: 'keys',
      notes: chords(progression, root, bars, [
        [0, 7, 0.75],
        [8, 7, 0.65],
      ]),
    });
  }
  if (role === 'melody' && perf) {
    const notes = tonalNotes(perf.events, MELODY_CENTER, info.key, MELODY_FALLBACK_BASE + root, total, false);
    tracks.push({ name: 'Melody', sound: 'pluck', notes });
  }
  return tracks;
}

/** The name the beat goes by in its title and message ("boom bap", "trance", "808"). */
function labelOf(plan: BeatPlan): string {
  const { style, info, role } = plan;
  if (isEdmStyle(style)) return STYLE_LABELS[style].toLowerCase();
  const name = info.style || role !== '808' ? style : '808';
  return name.replace('boombap', 'boom bap');
}

/** The sentence that says what was made and what it followed. */
function messageOf(plan: BeatPlan, label: string, tracks: readonly BeatTrack[]): string {
  const { bars, role } = plan;
  const parts = tracks.map((t) => t.name.toLowerCase()).join(', ');
  let followed = '.';
  if (role === 'drums') followed = ', following your beatbox for the drums.';
  else if (role) followed = `, following your humming for the ${role}.`;
  return `Made a ${bars}-bar ${label} pattern (${parts})${followed}`;
}

/**
 * Writes a beat from a request (and what the user performed), offline: the style's drums, then its
 * bass and chords. Deterministic for the same input.
 */
export function generateLocalBeat(input: LocalBeatInput): BeatSpec {
  const plan = planOf(input);
  const { info, style, bars } = plan;
  const tracks = drumsOf(plan);
  if (!info.drumsOnly) {
    const kick = tracks.find((t) => t.sound === 'kick')?.notes ?? [];
    tracks.push(...bassTracks(plan, kick, input.prompt), ...harmonyTracks(plan));
  }
  const label = labelOf(plan);
  const spec: BeatSpec = {
    title: `${label[0]?.toUpperCase()}${label.slice(1)} beat`,
    bars,
    tracks,
    style,
    message: messageOf(plan, label, tracks),
  };
  const bpm = info.bpm ?? (info.style ? TEMPO[style].default : undefined);
  if (bpm !== undefined && bpm !== input.bpm) spec.bpm = bpm;
  // The style's swing (straight for a named straight style too).
  if (info.style || GROOVE[style].swing > 0) spec.swing = GROOVE[style].swing;
  return spec;
}
