import type { BeatNote, BeatSpec, BeatTrack } from './spec';
import { STEPS_PER_BAR } from './spec';

/**
 * The assistant's offline brain: reads a description ("dark trap 808s at 140 in F minor") and the
 * user's performance (hits and hummed notes on the grid) and writes a beat with style templates.
 * No network, deterministic for the same input, and used when no AI is configured.
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

export type Style = 'trap' | 'drill' | 'boombap' | 'lofi' | 'house' | 'reggaeton' | 'afro';

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
  [/\bhouse\b|\btechno\b|four on the floor|\bedm\b|\bdisco\b/, 'house'],
  [/\breggaeton\b|\bdembow\b|\blatin\b/, 'reggaeton'],
  [/\bafro\s*-?\s*beats?\b|\bamapiano\b|\bafro\b/, 'afro'],
];

const DEFAULT_BPM: Record<Style, number> = {
  trap: 140,
  drill: 142,
  boombap: 90,
  lofi: 80,
  house: 124,
  reggaeton: 95,
  afro: 104,
};

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

/** Drum grids per style: one bar, 16 steps; X = accent, x = hit, o = ghost. */
const DRUMS: Record<Style, Record<string, string>> = {
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
    kick: 'X.......x.x.....',
    snare: '....X.......X...',
    hat: 'x.x.x.x.x.x.x.x.',
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
};

const DRUM_SOUND: Record<string, BeatTrack['sound']> = {
  kick: 'kick',
  snare: 'snare',
  clap: 'clap',
  hat: 'hat',
  rim: 'rim',
};

const NAMES: Record<string, string> = { kick: 'Kick', snare: 'Snare', clap: 'Clap', hat: 'Hat', rim: 'Rim' };

function fromGrid(grid: string, bars: number): BeatNote[] {
  const notes: BeatNote[] = [];
  for (let bar = 0; bar < bars; bar++) {
    for (let i = 0; i < grid.length; i++) {
      const c = grid[i];
      if (c === '.' || c === undefined) continue;
      notes.push({ step: bar * STEPS_PER_BAR + i, len: 1, vel: c === 'X' ? 1 : c === 'o' ? 0.35 : 0.8 });
    }
  }
  return notes;
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

/** An 808 line that follows the kick: roots, with a slide to the 5th / ♭7 at the end of each bar. */
function eightOhEight(kick: readonly BeatNote[], bars: number, root808: number, minor: boolean): BeatNote[] {
  const hits = kick.map((n) => n.step);
  const notes: BeatNote[] = [];
  hits.forEach((step, i) => {
    const next = hits[i + 1] ?? bars * STEPS_PER_BAR;
    const bar = Math.floor(step / STEPS_PER_BAR);
    const lastInBar = (hits[i + 1] ?? Infinity) >= (bar + 1) * STEPS_PER_BAR;
    const key = bar % 2 === 1 && lastInBar ? root808 + (minor ? -2 : 7) : root808;
    notes.push({ step, len: Math.max(1, next - step), key, vel: 0.9 });
  });
  // Glide: the last note of every other bar slides up an octave into the next bar.
  for (let bar = 1; bar < bars; bar += 2) {
    const last = [...notes].reverse().find((n) => n.step < (bar + 1) * STEPS_PER_BAR && n.step >= bar * STEPS_PER_BAR);
    if (last && (last.len ?? 1) >= 3) {
      const at = last.step + (last.len ?? 1) - 2;
      notes.push({ step: at, len: 2, key: (last.key ?? root808) + 12, vel: 0.85 });
    }
  }
  return notes.sort((a, b) => a.step - b.step);
}

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

export function generateLocalBeat(input: LocalBeatInput): BeatSpec {
  const info = parsePrompt(input.prompt);
  const style: Style = info.style ?? (info.wants808 ? 'trap' : 'boombap');
  const perf = input.performance && input.performance.events.length > 0 ? input.performance : undefined;
  const bars = Math.max(1, Math.min(4, perf?.bars ?? (style === 'trap' || style === 'drill' ? 2 : 1)));
  const total = bars * STEPS_PER_BAR;
  const minor = info.key?.minor ?? (style !== 'house' && style !== 'afro' && style !== 'reggaeton');
  const root = info.key?.root ?? (style === 'trap' || style === 'drill' ? 5 : 9); // F or A
  const root808 = 24 + root; // C1-based octave
  const tracks: BeatTrack[] = [];
  const role = perf ? decideRole(perf.role, perf.events, info) : null;

  // Drums: the style's grid, replaced part by part by what the user beatboxed.
  const drumGrid = DRUMS[style];
  const performed = (kind: PerformedEvent['kind']) =>
    role === 'drums' && perf ? perf.events.filter((e) => e.kind === kind) : [];
  for (const [part, grid] of Object.entries(drumGrid)) {
    if (part === 'hat' && info.noHats) continue;
    let notes = fromGrid(grid, bars);
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
    tracks.push({
      name: NAMES[part] ?? part,
      sound: DRUM_SOUND[part] ?? 'snare',
      notes,
      volume: part === 'hat' ? 0.6 : 0.8,
    });
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
  if (bars >= 2 && kickTrack && role !== 'drums' && style !== 'house' && style !== 'reggaeton') {
    const pickup = (bars - 1) * STEPS_PER_BAR + 14;
    if (!kickTrack.notes.some((n) => n.step === pickup)) {
      kickTrack.notes.push({ step: pickup, len: 1, vel: 0.7 });
      kickTrack.notes.sort((a, b) => a.step - b.step);
    }
  }

  if (!info.drumsOnly) {
    const kick = tracks.find((t) => t.sound === 'kick')?.notes ?? [];
    if (role === '808' && perf) {
      tracks.push({
        name: '808',
        sound: '808',
        notes: tonalNotes(perf.events, root808 + 7, info.key, root808, total, true),
        params: { glide: 0.09, decay: 2.2 },
      });
    } else if (info.wants808 || style === 'trap' || style === 'drill') {
      tracks.push({
        name: '808',
        sound: '808',
        notes: eightOhEight(kick, bars, root808, minor),
        params: { glide: 0.1 },
      });
    } else if (style === 'house') {
      const notes = Array.from({ length: bars * 4 }, (_, i) => ({
        step: i * 4 + 2,
        len: 1.5,
        key: 36 + root,
        vel: 0.8,
      }));
      tracks.push({ name: 'Bass', sound: 'bass', notes });
    }
    if (role === 'melody' && perf) {
      tracks.push({
        name: 'Melody',
        sound: 'pluck',
        notes: tonalNotes(perf.events, 67, info.key, 60 + root, total, false),
        volume: 0.7,
      });
    }
  }

  const label = (info.style ? style : role === '808' ? '808' : style).replace('boombap', 'boom bap');
  const title = `${label[0]?.toUpperCase()}${label.slice(1)} beat`;
  const parts = tracks.map((t) => t.name.toLowerCase()).join(', ');
  const spec: BeatSpec = {
    title,
    bars,
    tracks,
    message:
      `Made a ${bars}-bar ${label} pattern (${parts})` +
      (role
        ? `, following your ${role === 'drums' ? 'beatbox' : 'humming'} for the ${role === 'drums' ? 'drums' : role}.`
        : '.'),
  };
  const bpm = info.bpm ?? (info.style ? DEFAULT_BPM[style] : undefined);
  if (bpm !== undefined && bpm !== input.bpm) spec.bpm = bpm;
  if (style === 'boombap' || style === 'lofi') spec.swing = style === 'lofi' ? 0.3 : 0.15;
  return spec;
}
