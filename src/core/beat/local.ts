import { applyAccents } from './groove';
import { EDM_DRUMS, EDM_LOOP, edmTracks, isEdmStyle, type EdmStyle } from './local-edm';
import type { BeatNote, BeatSpec, BeatTrack } from './spec';
import { STEPS_PER_BAR } from './spec';
import { GROOVE, STYLE_LABELS, TEMPO, type Style } from './style';
import { bassKey, chords, type Quality } from './theory';

export type { Style } from './style';

/**
 * The assistant's offline brain: reads a description ("dark trap 808s at 140 in F minor") and the
 * user's performance (hits and hummed notes on the grid) and writes a beat with style templates:
 * the style's drum grid with its accents and swing, an 808 that follows the kick and slides (trap,
 * drill), a sub bass under the kick (boom bap), 7th-chord keys (lo-fi), offbeat bass (house, EDM)
 * and chords (EDM, pop). No network, deterministic for the same input, used when no AI is set up.
 */

/** What a performed sound became on the grid (structurally a voice-analysis GridEvent). */
export interface PerformedEvent {
  step: number;
  lengthSteps: number;
  kind: 'kick' | 'snare' | 'hat' | 'tonal';
  strength: number;
  pitch: number | null;
  pitchEnd: number | null;
}

/** What the user's noises stand for. */
export type PerformanceRole = 'auto' | 'drums' | '808' | 'melody';

export interface PromptInfo {
  bpm?: number;
  style?: Style;
  /** Pitch class 0–11 of the key's root and whether it's minor. */
  key?: { root: number; minor: boolean };
  /** −1 simpler … +1 busier. */
  density: number;
  wants808: boolean;
  wantsMelody: boolean;
  /** Mentions of drum parts the user wants ('only drums', 'no hats' are handled too). */
  noHats: boolean;
  drumsOnly: boolean;
}

const NOTE_NAMES: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

const STYLE_WORDS: [RegExp, Style][] = [
  [/\bdrill\b/, 'drill'],
  [/\btrap\b|\brage\b/, 'trap'],
  [/boom\s*-?\s*bap|\b90s\b|\bhip\s*-?\s*hop\b/, 'boombap'],
  [/\blo\s*-?\s*fi\b|\bchill\b/, 'lofi'],
  [/\bmelodic\s*-?\s*dub(step)?\b/, 'melodicdub'],
  [/\bdubstep\b|\briddim\b|\bbrostep\b|\bgrowl\b/, 'dubstep'],
  [/\bfuture\s*-?\s*bass\b/, 'futurebass'],
  [/\bbig\s*-?\s*room\b/, 'bigroom'],
  [/\bprogressive\b|\bprog\s*-?\s*house\b/, 'proghouse'],
  [/\btech\s*-?\s*house\b/, 'techhouse'],
  [/\btrance\b/, 'trance'],
  [/\bdrum\s*(?:&|and|n|'n')\s*bass\b|\bdnb\b|\bd\s*&\s*b\b|\bjungle\b|\bliquid\b|\bneuro(funk)?\b|\breese\b/, 'dnb'],
  [/\bedm\b|\bfestival\b|\belectro\b|\bdance\b/, 'edm'],
  [/\bhouse\b|\btechno\b|four on the floor|\bdisco\b/, 'house'],
  [/\breggaeton\b|\bdembow\b|\blatin\b/, 'reggaeton'],
  [/\bafro\s*-?\s*beats?\b|\bamapiano\b|\bafro\b/, 'afro'],
  [/\bpop\b|\bradio\b/, 'pop'],
];

export function parsePrompt(prompt: string): PromptInfo {
  const text = prompt.toLowerCase();
  const info: PromptInfo = {
    density: 0,
    wants808: /\b808s?\b|\bsub\b/.test(text),
    wantsMelody: /\bmelod|\blead\b|\bpluck|\bchords?\b|\bkeys\b|\bpiano\b/.test(text),
    noHats: /\bno (hi-?)?hats?\b|\bwithout (hi-?)?hats?\b/.test(text),
    drumsOnly: /\b(only|just) drums\b|\bdrums only\b/.test(text),
  };
  const bpm = text.match(/(\d{2,3})\s*(?:bpm|beats per minute)/) ?? text.match(/\bat (\d{2,3})\b/);
  if (bpm) {
    const v = Number(bpm[1]);
    if (v >= 50 && v <= 220) info.bpm = v;
  }
  for (const [re, style] of STYLE_WORDS) {
    if (re.test(text)) {
      info.style = style;
      break;
    }
  }
  const key = text.match(/\b(?:in\s+)?([a-g])\s*(#|♯|b|♭|sharp|flat)?\s*(m(?:in(?:or)?)?|maj(?:or)?)?\b(?=\s|$|[,.!])/);
  const keyIn = text.match(/\bin\s+([a-g])\s*(#|♯|b|♭|sharp|flat)?\s*(m(?:in(?:or)?)?|maj(?:or)?)?\b/);
  const k = keyIn ?? (key && (key[2] || key[3]) ? key : null);
  if (k) {
    let root = NOTE_NAMES[k[1] as string] as number;
    if (k[2] === '#' || k[2] === '♯' || k[2] === 'sharp') root += 1;
    if (k[2] === 'b' || k[2] === '♭' || k[2] === 'flat') root -= 1;
    info.key = { root: (root + 12) % 12, minor: !k[3]?.startsWith('maj') };
  }
  if (/\bbusy\b|\bbusier\b|\bmore\b|\bcrazy\b|\bhard(er)?\b|\baggressive\b|\benergetic\b|\bfast(er)? hats\b/.test(text))
    info.density += 1;
  if (/\bsimple\b|\bsimpler\b|\bminimal\b|\bsparse\b|\bless\b|\bchill\b|\bcalm\b/.test(text)) info.density -= 1;
  info.density = Math.max(-1, Math.min(1, info.density));
  return info;
}

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

const DRUM_SOUND: Record<string, BeatTrack['sound']> = {
  kick: 'kick',
  snare: 'snare',
  clap: 'clap',
  hat: 'hat',
  'open-hat': 'open-hat',
  rim: 'rim',
};

const NAMES: Record<string, string> = {
  kick: 'Kick',
  snare: 'Snare',
  clap: 'Clap',
  hat: 'Hat',
  'open-hat': 'Open hat',
  rim: 'Rim',
};

/** Notes of a grid; plain hits have no velocity yet (the style's accents fill them in). */
function fromGrid(grid: string, bars: number, style: Style): BeatNote[] {
  const notes: BeatNote[] = [];
  for (let bar = 0; bar < bars; bar++) {
    for (let i = 0; i < grid.length; i++) {
      const c = grid[i];
      if (c === '.' || c === undefined) continue;
      const note: BeatNote = { step: bar * STEPS_PER_BAR + i, len: 1 };
      if (c === 'X') note.vel = 1;
      else if (c === 'o') note.vel = GROOVE[style].ghost * 0.8;
      notes.push(note);
    }
  }
  return notes;
}

/** Fills in the velocities a track's notes don't have yet with the style's accents. */
function accent(track: BeatTrack, style: Style): BeatTrack {
  applyAccents(
    track,
    track.notes.map((n) => n.vel === undefined),
    style,
  );
  for (const n of track.notes) n.vel ??= 0.8;
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
      for (let s = from; s < to - 1e-9; s += 1 / div)
        out.push({ step: base + Math.round(s * 6) / 6, len: 1 / div, vel: 0.55 + 0.35 * ((s - from) / (to - from)) });
    };
    if (bar % 2 === 1 || bars === 1) roll(14, 16, triplet ? 3 : 2);
    roll(6, 8, 2);
  }
  return out.sort((a, b) => a.step - b.step);
}

const MINOR = [0, 2, 3, 5, 7, 8, 10];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];

function snapToScale(key: number, root: number, minor: boolean): number {
  const scale = minor ? MINOR : MAJOR;
  for (let d = 0; d <= 6; d++) {
    for (const k of [key - d, key + d]) if (scale.includes((((k - root) % 12) + 12) % 12)) return k;
  }
  return key;
}

/** The highest key an 808 slides to (C3): above it the 808 stops sounding like a bass. */
const MAX_808 = 48;

/**
 * An 808 line that follows the kick (roots, the ♭7 or 5th on the last hit of every second bar),
 * every hit ringing until the next one. Slides: the last note of the loop (after the pickup kick),
 * and with `everyBar` the last note of every bar, glides into a new pitch for its last step; it is
 * stretched half a step into the new note, so the 808 slides instead of hitting again.
 */
function eightOhEight(
  kick: readonly BeatNote[],
  bars: number,
  root808: number,
  minor: boolean,
  everyBar: boolean,
): BeatNote[] {
  const total = bars * STEPS_PER_BAR;
  const hits = [...new Set(kick.map((n) => n.step))].sort((a, b) => a - b);
  const notes: BeatNote[] = [];
  hits.forEach((step, i) => {
    const next = hits[i + 1] ?? total;
    const bar = Math.floor(step / STEPS_PER_BAR);
    const lastInBar = (hits[i + 1] ?? Infinity) >= (bar + 1) * STEPS_PER_BAR;
    const key = bar % 2 === 1 && lastInBar ? root808 + (minor ? -2 : 7) : root808;
    notes.push({ step, len: Math.max(1, next - step), key, vel: 0.9 });
  });
  for (let bar = everyBar ? 0 : bars - 1; bar < bars; bar++) {
    const last = notes.filter((n) => n.step >= bar * STEPS_PER_BAR && n.step < (bar + 1) * STEPS_PER_BAR).at(-1);
    const len = last?.len ?? 0;
    if (!last || len < 1.5) continue;
    const at = last.step + Math.max(0.5, len - 1);
    const from = last.key ?? root808;
    // Up an octave into the loop's restart; a 5th up (or the octave below) inside the loop.
    const interval = bar === bars - 1 ? 12 : 7;
    const key = from + interval <= MAX_808 ? from + interval : from - 12;
    notes.push({ step: at, len: last.step + len - at, key, vel: 0.85 });
    last.len = at - last.step + 0.5;
  }
  return notes.sort((a, b) => a.step - b.step);
}

/** A sub bass under the kick: the root on each hit, short of the next one (boom bap, afro, pop). */
function subUnderKick(kick: readonly BeatNote[], bars: number, rootBass: number, roots?: readonly number[]): BeatNote[] {
  const total = bars * STEPS_PER_BAR;
  const hits = [...new Set(kick.map((n) => n.step))].sort((a, b) => a - b);
  return hits.map((step, i) => {
    const next = hits[i + 1] ?? total;
    const bar = Math.floor(step / STEPS_PER_BAR);
    const shift = roots ? (roots[bar % roots.length] ?? 0) : 0;
    return { step, len: Math.max(0.5, Math.min(6, next - step - 0.25)), key: bassKey(rootBass + shift), vel: 0.85 };
  });
}

/** Four-bar progressions: chord roots in semitones above the key's root, and their qualities. */
const PROGRESSIONS = {
  // Lo-fi: i7 – iv7 – ♭VII7 – ♭IIImaj7 (minor), ii7 – V7 – Imaj7 – vi7 (major).
  sevenths: {
    minor: [
      [0, 'm7'],
      [5, 'm7'],
      [10, '7'],
      [3, 'maj7'],
    ],
    major: [
      [2, 'm7'],
      [7, '7'],
      [0, 'maj7'],
      [9, 'm7'],
    ],
  },
  // EDM and pop: i – ♭VI – ♭III – ♭VII (minor), I – V – vi – IV (major).
  anthem: {
    minor: [
      [0, 'min'],
      [8, 'maj'],
      [3, 'maj'],
      [10, 'maj'],
    ],
    major: [
      [0, 'maj'],
      [7, 'maj'],
      [9, 'min'],
      [5, 'maj'],
    ],
  },
} as const satisfies Record<string, Record<'minor' | 'major', readonly (readonly [number, Quality])[]>>;

/** Moves hummed pitches into a register, keeping their shape (and the key, when one was asked for). */
function placePitches(
  events: readonly PerformedEvent[],
  targetCenter: number,
  key: PromptInfo['key'],
  fallback: number,
): number[] {
  const pitched = events.filter((e) => e.pitch !== null).map((e) => e.pitch as number);
  if (pitched.length === 0) return events.map(() => fallback);
  const sorted = [...pitched].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] as number;
  let shift = Math.round((targetCenter - median) / 12) * 12;
  if (key) {
    // The most-held pitch class becomes the key's root.
    const weight = new Array<number>(12).fill(0);
    events.forEach((e) => {
      if (e.pitch === null) return;
      const pc = ((Math.round(e.pitch) % 12) + 12) % 12;
      weight[pc] = (weight[pc] ?? 0) + e.lengthSteps;
    });
    const tonic = weight.indexOf(Math.max(...weight));
    let t = key.root - tonic;
    if (t > 6) t -= 12;
    if (t < -6) t += 12;
    shift = Math.round((targetCenter - (median + t)) / 12) * 12 + t;
  }
  return events.map((e) => {
    if (e.pitch === null) return fallback;
    const k = Math.round(e.pitch + shift);
    return key ? snapToScale(k, key.root, key.minor) : k;
  });
}

/** The performance as notes for an 808 (or melody) track; connected notes overlap so they glide. */
function tonalNotes(
  events: readonly PerformedEvent[],
  center: number,
  key: PromptInfo['key'],
  fallback: number,
  total: number,
  glide: boolean,
): BeatNote[] {
  const sorted = [...events].sort((a, b) => a.step - b.step);
  const keys = placePitches(sorted, center, key, fallback);
  const notes: BeatNote[] = [];
  sorted.forEach((e, i) => {
    const next = sorted[i + 1];
    let len = Math.max(0.5, e.lengthSteps);
    if (next && glide && next.step - (e.step + len) <= 0.5 && keys[i + 1] !== keys[i]) len = next.step - e.step + 0.5;
    if (next && !glide) len = Math.min(len, next.step - e.step);
    len = Math.min(len, total - e.step);
    notes.push({ step: e.step, len, key: keys[i], vel: Math.max(0.4, Math.min(1, 0.5 + e.strength / 2)) });
    if (glide && e.pitchEnd !== null && e.pitch !== null && Math.abs(e.pitchEnd - e.pitch) >= 1 && len >= 1.5) {
      // A slide within one hummed note: a second, overlapping note at the end pitch.
      const end = (keys[i] as number) + Math.round(e.pitchEnd - e.pitch);
      notes.push({ step: e.step + len / 2, len: len / 2, key: end, vel: 0.8 });
    }
  });
  return notes;
}

function decideRole(
  role: PerformanceRole,
  events: readonly PerformedEvent[],
  info: PromptInfo,
): Exclude<PerformanceRole, 'auto'> {
  if (role !== 'auto') return role;
  const tonal = events.filter((e) => e.kind === 'tonal').length;
  if (tonal >= events.length / 2 && tonal > 0) return info.wantsMelody && !info.wants808 ? 'melody' : '808';
  return 'drums';
}

export interface LocalBeatInput {
  prompt: string;
  /** The project's tempo (used unless the prompt names one). */
  bpm: number;
  performance?: { events: readonly PerformedEvent[]; role: PerformanceRole; bars: number };
}

/** Loop length per style in bars: chords take four; trap, drill and boom bap two (a pickup, slides). */
const LOOP_BARS: Record<Exclude<Style, EdmStyle>, number> = {
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

export function generateLocalBeat(input: LocalBeatInput): BeatSpec {
  const info = parsePrompt(input.prompt);
  const style: Style = info.style ?? (info.wants808 ? 'trap' : 'boombap');
  const perf = input.performance && input.performance.events.length > 0 ? input.performance : undefined;
  const bars = Math.max(1, Math.min(4, perf?.bars ?? (isEdmStyle(style) ? EDM_LOOP[style] : LOOP_BARS[style])));
  const total = bars * STEPS_PER_BAR;
  const minor = info.key?.minor ?? !['house', 'afro', 'reggaeton', 'pop', 'futurebass'].includes(style);
  // F for trap, drill and the half-time bass styles (low, heavy sub), A for the rest (futurebass: E♭ major).
  const root =
    info.key?.root ??
    (style === 'trap' || style === 'drill' || style === 'dubstep' || style === 'melodicdub' ? 5 : style === 'futurebass' ? 3 : 9);
  const root808 = 24 + root; // C1-based octave
  /** A synth bass's root (its sub oscillator plays an octave lower). */
  const rootBass = 36 + root;
  const tracks: BeatTrack[] = [];
  const role = perf ? decideRole(perf.role, perf.events, info) : null;

  // Drums: the style's grid, replaced part by part by what the user beatboxed.
  const drumGrid = isEdmStyle(style) ? EDM_DRUMS[style] : DRUMS[style];
  const performed = (kind: PerformedEvent['kind']) =>
    role === 'drums' && perf ? perf.events.filter((e) => e.kind === kind) : [];
  for (const [part, grid] of Object.entries(drumGrid)) {
    if ((part === 'hat' || part === 'open-hat') && info.noHats) continue;
    let notes = fromGrid(grid, bars, style);
    const own = performed(part === 'clap' || part === 'rim' ? 'snare' : (part as PerformedEvent['kind']));
    if (own.length > 0)
      notes = own.map((e) => ({
        step: e.step,
        len: Math.max(0.5, Math.min(e.lengthSteps, 4)),
        vel: Math.max(0.3, e.strength),
      }));
    else if (part === 'hat') {
      if (style === 'trap' || style === 'drill')
        notes = info.density >= 0 ? addRolls(notes, bars, style === 'drill') : notes;
      if (info.density < 0) notes = notes.filter((n) => n.step % 4 === 0);
      if (info.density > 0 && style !== 'trap' && style !== 'drill')
        notes = [...notes, ...notes.map((n) => ({ ...n, step: n.step + 1, vel: 0.45 }))].filter((n) => n.step < total);
    } else if (part === 'kick' && info.density > 0) {
      notes = [...notes, { step: total - 3, len: 1, vel: 0.7 }];
    }
    // No volumes: the beat writer gives each drum its level.
    tracks.push({ name: NAMES[part] ?? part, sound: DRUM_SOUND[part] ?? 'snare', notes });
  }
  if (role === 'drums' && perf) {
    // Beatboxed sounds the style has no part for still get a track.
    for (const kind of ['kick', 'snare', 'hat'] as const) {
      const own = performed(kind);
      if (
        own.length > 0 &&
        !tracks.some((t) => t.sound === kind || (kind === 'snare' && (t.sound === 'clap' || t.sound === 'rim')))
      )
        tracks.push({
          name: NAMES[kind] as string,
          sound: kind,
          notes: own.map((e) => ({ step: e.step, len: 1, vel: Math.max(0.3, e.strength) })),
        });
    }
  }

  // Movement in longer loops: a kick pickup into the turnaround (the 808 follows it).
  const kickTrack = tracks.find((t) => t.sound === 'kick');
  if (bars >= 2 && kickTrack && role !== 'drums' && !['house', 'edm', 'reggaeton'].includes(style) && !isEdmStyle(style)) {
    const pickup = (bars - 1) * STEPS_PER_BAR + 14;
    if (!kickTrack.notes.some((n) => n.step === pickup)) {
      kickTrack.notes.push({ step: pickup, len: 1, vel: 0.7 });
      kickTrack.notes.sort((a, b) => a.step - b.step);
    }
  }
  // The style's accents for every drum hit that has no velocity yet.
  for (const t of tracks) accent(t, style);

  if (!info.drumsOnly) {
    const kick = tracks.find((t) => t.sound === 'kick')?.notes ?? [];
    const scale = minor ? 'minor' : 'major';
    if (role === '808' && perf) {
      tracks.push({
        name: '808',
        sound: '808',
        notes: tonalNotes(perf.events, root808 + 7, info.key, root808, total, true),
        params: { glide: 0.09, decay: 2.2 },
      });
    } else if (isEdmStyle(style)) {
      // The EDM pack's own parts: bass, chords and hooks per style (local-edm.ts).
      tracks.push(...edmTracks(style, { bars, root, minor, kick, neuro: /\bneuro(funk)?\b|\breese\b|\bdark\b/.test(input.prompt.toLowerCase()) }));
    } else if (info.wants808 || style === 'trap' || style === 'drill' || style === 'reggaeton') {
      // Every bar of a drill loop slides; trap and reggaeton slide into the loop's restart.
      tracks.push({ name: '808', sound: '808', notes: eightOhEight(kick, bars, root808, minor, style === 'drill') });
    } else if (style === 'boombap' || style === 'afro' || style === 'pop') {
      // A sub bass under the kick (boom bap moves to the iv in bar 2; pop follows its chords).
      const roots =
        style === 'pop' ? PROGRESSIONS.anthem[scale].map(([d]) => d) : style === 'boombap' ? [0, 5] : [0];
      tracks.push({ name: 'Bass', sound: 'bass', notes: subUnderKick(kick, bars, rootBass, roots) });
    } else if (style === 'house' || style === 'edm') {
      // Offbeat bass (EDM: on its chords' roots).
      const roots: readonly number[] = style === 'edm' ? PROGRESSIONS.anthem[scale].map(([d]) => d) : [0];
      const notes = Array.from({ length: bars * 4 }, (_, i) => ({
        step: i * 4 + 2,
        len: 1.5,
        key: bassKey(rootBass + (roots[Math.floor(i / 4) % roots.length] ?? 0)),
        vel: 0.8,
      }));
      tracks.push({ name: 'Bass', sound: 'bass', notes });
    }
    if (style === 'lofi' && role !== '808') {
      // Four bars of 7th chords on mellow keys (held, then a lazy re-strike), and a soft bass on their roots.
      const prog = PROGRESSIONS.sevenths[scale];
      tracks.push({ name: 'Keys', sound: 'keys', notes: chords(prog, root, bars, [[0, 10, 0.72], [10, 6, 0.58]]) });
      const bass: BeatNote[] = [];
      for (let bar = 0; bar < bars; bar++) {
        const key = bassKey(rootBass + prog[bar % prog.length]![0]);
        bass.push({ step: bar * STEPS_PER_BAR, len: 7.5, key, vel: 0.8 });
        bass.push({ step: bar * STEPS_PER_BAR + 10, len: 5.5, key, vel: 0.7 });
      }
      tracks.push({ name: 'Bass', sound: 'bass', notes: bass });
    } else if (style === 'edm') {
      tracks.push({ name: 'Pad', sound: 'pad', notes: chords(PROGRESSIONS.anthem[scale], root, bars, [[0, 16, 0.7]], 53) });
    } else if (style === 'pop') {
      tracks.push({
        name: 'Keys',
        sound: 'keys',
        notes: chords(PROGRESSIONS.anthem[scale], root, bars, [[0, 7, 0.75], [8, 7, 0.65]]),
      });
    }
    if (role === 'melody' && perf) {
      tracks.push({
        name: 'Melody',
        sound: 'pluck',
        notes: tonalNotes(perf.events, 67, info.key, 60 + root, total, false),
      });
    }
  }

  const label = isEdmStyle(style)
    ? STYLE_LABELS[style].toLowerCase()
    : (info.style ? style : role === '808' ? '808' : style).replace('boombap', 'boom bap');
  const title = `${label[0]?.toUpperCase()}${label.slice(1)} beat`;
  const parts = tracks.map((t) => t.name.toLowerCase()).join(', ');
  const spec: BeatSpec = {
    title,
    bars,
    tracks,
    style,
    message:
      `Made a ${bars}-bar ${label} pattern (${parts})` +
      (role
        ? `, following your ${role === 'drums' ? 'beatbox' : 'humming'} for the ${role === 'drums' ? 'drums' : role}.`
        : '.'),
  };
  const bpm = info.bpm ?? (info.style ? TEMPO[style].default : undefined);
  if (bpm !== undefined && bpm !== input.bpm) spec.bpm = bpm;
  // The style's swing (straight for a named straight style too).
  if (info.style || GROOVE[style].swing > 0) spec.swing = GROOVE[style].swing;
  return spec;
}
