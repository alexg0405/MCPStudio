/**
 * A beat as the assistant describes it: a few tracks of notes on a 1/16-step grid. The AI (and the
 * offline generator) write this; the app turns it into channels and a pattern. Everything that
 * comes in is validated and clamped, so a sloppy or hostile model output can't break the project.
 */
import { applyAccents, chokeOpenHats, styleOfBeat } from './groove';
import { isStyle, STYLES, type Style } from './style';

/** Sounds the assistant can ask for. Kit pieces are samplers; the rest are instruments. */
export const BEAT_SOUNDS = [
  'kick',
  'snare',
  'clap',
  'hat',
  'open-hat',
  'tom-low',
  'tom-mid',
  'tom-high',
  'rim',
  'cowbell',
  'crash',
  '808',
  'bass',
  'lead',
  'pad',
  'pluck',
  'keys',
  'bell',
  'strings',
] as const;
export type BeatSound = (typeof BEAT_SOUNDS)[number];

export const DRUM_SOUNDS: ReadonlySet<BeatSound> = new Set([
  'kick',
  'snare',
  'clap',
  'hat',
  'open-hat',
  'tom-low',
  'tom-mid',
  'tom-high',
  'rim',
  'cowbell',
  'crash',
]);

export interface BeatNote {
  /** Position in 1/16 steps from the start of the pattern; fractions allowed (0.5 = 1/32). */
  step: number;
  /** Length in steps (default 1). Overlapping 808 notes glide. */
  len?: number;
  /** MIDI note (60 = C4). Drums ignore it. */
  key?: number;
  /** 0..1. Left out: the style's accent for that spot (0.8 when the style isn't known). */
  vel?: number;
}

export interface BeatTrack {
  name: string;
  sound: BeatSound;
  notes: BeatNote[];
  /**
   * Channel volume as a linear gain, 0..1.25 (+1.9 dB). The AI may send `volume_db` instead (a
   * negative `volume` is read as dB too). Left out: the sound's own level.
   */
  volume?: number;
  /** −1..1. */
  pan?: number;
  /** A preset of the track's instrument by name (any instrument's: the writer picks the instrument that has it). */
  preset?: string;
  /** Instrument settings by param id (pitched sounds; unknown ids are ignored). */
  params?: Record<string, number>;
}

export interface BeatSpec {
  /** Short pattern name, e.g. "Dark trap". */
  title: string;
  /** What the assistant did, in a sentence or two, for the user. */
  message?: string;
  bpm?: number;
  /** 0..1. */
  swing?: number;
  bars: number;
  tracks: BeatTrack[];
  /** The style it's written in: its accents, the sounds of new tracks and the drum kit. */
  style?: Style;
}

export const STEPS_PER_BAR = 16;
export const MAX_BARS = 4;
export const MAX_TRACKS = 12;
export const MAX_NOTES_PER_TRACK = 256;
/** Steps snap to 1/6 step (40 ticks): covers 1/32 notes and 1/24 triplet rolls. */
const STEP_GRID = 6;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const snapStep = (v: number) => Math.round(v * STEP_GRID) / STEP_GRID;

function cleanName(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
  return s || fallback;
}

export interface BeatCheckOptions {
  /** The style to accent with when the beat doesn't name one. */
  style?: Style;
  /** Without a style: guess it from the beat at this tempo and swing (the project's, unless the beat sets them). */
  project?: { bpm: number; swing: number };
}

export type BeatCheck = { spec: BeatSpec; warnings: string[]; style: Style | null } | { error: string };

/** Linear gain from dB as the beat writer takes it (−100 dB or less is silence, at most +1.9 dB). */
const gainOf = (db: number) => (db <= -100 ? 0 : Math.min(1.25, Math.pow(10, Math.min(1.9, db) / 20)));

/**
 * Checks and normalizes a beat from an untrusted source. Bad notes and tracks are dropped (with a
 * warning) rather than failing the whole beat; an unusable beat gives an error. With a style (the
 * beat's own, `opts.style`, or one guessed from `opts.project`), notes without a velocity get the
 * style's accents and open hats stop at the next closed hat.
 */
export function validateBeatSpec(raw: unknown, opts: BeatCheckOptions = {}): BeatCheck {
  if (!isObj(raw)) return { error: 'The beat is not an object.' };
  const warnings: string[] = [];
  const bars = clamp(Math.round(num(raw.bars) ?? 1), 1, MAX_BARS);
  if (num(raw.bars) !== undefined && num(raw.bars) !== bars) warnings.push(`Bars set to ${bars}.`);
  const total = bars * STEPS_PER_BAR;
  const tracks: BeatTrack[] = [];
  /** Per track: which notes came without a velocity. */
  const missingVel: boolean[][] = [];
  /** Open-hat notes: whether the AI gave their length. */
  const explicitLen = new Map<BeatNote, boolean>();
  const rawTracks = Array.isArray(raw.tracks) ? raw.tracks : [];
  const names = new Set<string>();
  for (const t of rawTracks.slice(0, MAX_TRACKS)) {
    if (!isObj(t)) continue;
    const sound = t.sound as BeatSound;
    if (!BEAT_SOUNDS.includes(sound)) {
      warnings.push(`Skipped a track with unknown sound "${String(t.sound)}".`);
      continue;
    }
    let name = cleanName(t.name, sound);
    for (let i = 2; names.has(name.toLowerCase()); i++) name = `${cleanName(t.name, sound)} ${i}`;
    names.add(name.toLowerCase());
    const drum = DRUM_SOUNDS.has(sound);
    const notes: { note: BeatNote; missing: boolean }[] = [];
    const seen = new Set<string>();
    for (const n of Array.isArray(t.notes) ? t.notes.slice(0, MAX_NOTES_PER_TRACK) : []) {
      if (!isObj(n)) continue;
      const stepRaw = num(n.step);
      if (stepRaw === undefined) continue;
      const step = snapStep(stepRaw);
      if (step < 0 || step >= total) continue;
      const len = clamp(snapStep(num(n.len) ?? 1) || 1 / STEP_GRID, 1 / STEP_GRID, total - step);
      const velRaw = num(n.vel);
      const vel = clamp(velRaw ?? 0.8, 0.05, 1);
      const note: BeatNote = { step, len, vel };
      if (!drum) {
        const key = num(n.key);
        if (key === undefined) continue;
        note.key = clamp(Math.round(key), 0, 127);
      }
      // A drum hit twice on the same step (or the same pitch twice) is one note.
      const id = drum ? `${step}` : `${step}:${note.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      notes.push({ note, missing: velRaw === undefined });
      if (sound === 'open-hat') explicitLen.set(note, num(n.len) !== undefined);
    }
    notes.sort((a, b) => a.note.step - b.note.step || (a.note.key ?? 0) - (b.note.key ?? 0));
    const track: BeatTrack = { name, sound, notes: notes.map((x) => x.note) };
    const volumeDb = num(t.volume_db);
    const volume = num(t.volume);
    if (volumeDb !== undefined) track.volume = gainOf(volumeDb);
    // A negative volume can only be meant as dB, and 2–100 as a percentage.
    else if (volume !== undefined)
      track.volume = volume < 0 ? gainOf(volume) : volume > 1.5 && volume <= 100 ? volume / 100 : clamp(volume, 0, 1);
    const pan = num(t.pan);
    if (pan !== undefined) track.pan = clamp(pan, -1, 1);
    if (typeof t.preset === 'string' && t.preset.trim()) track.preset = t.preset.trim().slice(0, 60);
    if (isObj(t.params)) {
      const params: Record<string, number> = {};
      for (const [k, v] of Object.entries(t.params).slice(0, 24)) {
        const x = num(v);
        if (x !== undefined && /^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(k)) params[k] = x;
      }
      if (Object.keys(params).length > 0) track.params = params;
    }
    tracks.push(track);
    missingVel.push(notes.map((x) => x.missing));
  }
  if (rawTracks.length > MAX_TRACKS) warnings.push(`Only the first ${MAX_TRACKS} tracks were used.`);
  if (tracks.length === 0) return { error: 'The beat has no usable tracks.' };
  const spec: BeatSpec = { title: cleanName(raw.title, 'Assistant beat'), bars, tracks };
  if (typeof raw.message === 'string' && raw.message.trim()) spec.message = raw.message.trim().slice(0, 600);
  const bpm = num(raw.bpm);
  if (bpm !== undefined) spec.bpm = clamp(Math.round(bpm), 50, 220);
  const swing = num(raw.swing);
  if (swing !== undefined) spec.swing = clamp(swing, 0, 1);
  if (isStyle(raw.style)) spec.style = raw.style;
  else if (raw.style !== undefined)
    warnings.push(`Unknown style "${String(raw.style)}" (the styles are ${STYLES.join(', ')}).`);
  const style =
    spec.style ??
    opts.style ??
    (opts.project ? styleOfBeat(tracks, bars, spec.bpm ?? opts.project.bpm, spec.swing ?? opts.project.swing) : null);
  if (style) {
    spec.style = style;
    tracks.forEach((t, i) => applyAccents(t, missingVel[i] ?? [], style));
    chokeOpenHats(tracks, explicitLen, total);
  }
  return { spec, warnings, style };
}

/**
 * The JSON schema of a beat for Claude's structured outputs (`output_config.format`). Structured
 * outputs require `additionalProperties: false` on every object and don't take numeric or array
 * bounds, so ranges are stated in descriptions and enforced by `validateBeatSpec`.
 */
export const BEAT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'Short pattern name (2–4 words), e.g. "Dark trap 808s".' },
    message: {
      type: 'string',
      description: 'One or two plain sentences for the musician: what you made and how it follows their request.',
    },
    bpm: { type: 'number', description: 'Tempo (50–220). Omit to keep the project tempo.' },
    swing: {
      type: 'number',
      description: '0..1: the second 1/16 of every 8th plays late by swing × half a step (0 = straight). Omit to keep it.',
    },
    style: {
      type: 'string',
      enum: [...STYLES],
      description: 'The style: picks the drum kit, the sounds of new tracks and the accents of notes without a velocity.',
    },
    bars: { type: 'integer', description: `Pattern length in 4/4 bars, 1 to ${MAX_BARS}.` },
    tracks: {
      type: 'array',
      description: `Up to ${MAX_TRACKS} tracks.`,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'Channel name, e.g. "808", "Kick", "Hat".' },
          sound: { type: 'string', enum: [...BEAT_SOUNDS] },
          volume_db: {
            type: 'number',
            description: 'Channel volume in dB (−60…+1.9). Omit it: every sound starts at a level that sits in the mix.',
          },
          volume: { type: 'number', description: 'Channel volume as 0..1 instead of dB (prefer volume_db).' },
          pan: { type: 'number', description: '-1 (left) .. 1 (right).' },
          preset: {
            type: 'string',
            description:
              'Optional, pitched tracks: a preset name from the catalog (e.g. "Glassy pluck", "Marimba"); the track plays on the instrument that has it. Omit it for the style’s own sound.',
          },
          params: {
            type: 'object',
            additionalProperties: false,
            description: 'Optional sound settings, only for sound "808".',
            properties: {
              decay: { type: 'number', description: 'Seconds the 808 rings, 0.1–8.' },
              glide: { type: 'number', description: 'Slide time in seconds, 0–0.6.' },
              punch: { type: 'number', description: 'Attack pitch drop in semitones, 0–24.' },
              drive: { type: 'number', description: 'Saturation 0–1.' },
              tone: { type: 'number', description: 'Low-pass in Hz, 150–8000.' },
            },
          },
          notes: {
            type: 'array',
            description: `Up to ${MAX_NOTES_PER_TRACK} notes.`,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                step: {
                  type: 'number',
                  description:
                    '1/16 step from the start: bar b, beat q (1-based) starts at (b-1)*16 + (q-1)*4. Fractions for rolls: 0.5 = 1/32, thirds for triplets.',
                },
                len: {
                  type: 'number',
                  description:
                    'Length in steps (default 1). For 808/bass, start the next note before this one ends to glide.',
                },
                key: {
                  type: 'integer',
                  description:
                    'MIDI note (C1 = 24, C2 = 36, C4 = 60). Required for 808, bass, lead, pad, pluck, keys, bell, strings; omit for drums.',
                },
                vel: {
                  type: 'number',
                  description:
                    'Velocity 0..1. Omit it to get the style’s accents (strong downbeats, accented hats, soft ghost snares, rising rolls).',
                },
              },
              required: ['step'],
            },
          },
        },
        required: ['name', 'sound', 'notes'],
      },
    },
  },
  required: ['title', 'message', 'bars', 'tracks'],
} as const;
