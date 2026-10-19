/**
 * What "Make harmonies…" is asked for: the voices (each a rule, a level, a pan and a formant move) and the humanize settings.
 * `parseVoiceSpec` reads the loose form the AI and MCP send; the dialog builds the same objects.
 */
import { DEFAULT_HUMANIZE, MAX_HARMONY_VOICES, NAMED_INTERVALS, clampHumanize, sanitizeRule } from '@core/harmony/voices';
import type { GuideNote, HarmonyHumanize, HarmonyRule } from '@core/model/types';

/** One voice to make. */
export interface VoiceSpec {
  rule: HarmonyRule;
  /** Level of the voice's channel against the lead, dB (−24…+6). */
  levelDb: number;
  /** −1 (left) … 1 (right). */
  pan: number;
  /** Moves the formants, cents (−300…300). */
  formantCents: number;
}

/** A whole "Make harmonies" request. */
export interface HarmonySpec {
  voices: VoiceSpec[];
  humanize: HarmonyHumanize;
  /** Makes the take repeatable; absent = a new random one. */
  seed?: number;
}

/** Said in plain words when a request is not understood. */
export class HarmonySpecError extends Error {}

/** The level a voice starts at: behind the lead, and quieter the more voices there are. */
export function defaultLevelDb(voiceCount: number): number {
  return voiceCount <= 1 ? -6 : -9;
}

/** Spreads voices across the stereo field: the first near the middle, the others alternating outwards. */
export function defaultPan(voice: number, voiceCount: number): number {
  if (voiceCount <= 1) return 0;
  const side = voice % 2 === 0 ? -1 : 1;
  const ring = Math.floor(voice / 2) + 1;
  return side * Math.min(0.8, 0.3 * ring + (voiceCount > 2 ? 0.1 : 0));
}

/** A voice with the usual settings for its place in a stack of `voiceCount`. */
export function defaultVoice(rule: HarmonyRule, voice: number, voiceCount: number): VoiceSpec {
  return { rule, levelDb: defaultLevelDb(voiceCount), pan: defaultPan(voice, voiceCount), formantCents: 0 };
}

/** A starting request: a third above and a fifth below, both quiet and to the sides. */
export function defaultSpec(): HarmonySpec {
  return {
    voices: [
      defaultVoice({ kind: 'interval', steps: 2 }, 0, 2),
      defaultVoice({ kind: 'interval', steps: -4 }, 1, 2),
    ],
    humanize: { ...DEFAULT_HUMANIZE },
  };
}

const number = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;

/** "3rd above", "fifth below", "6th", "octave above", "+2" → signed scale steps (a bare size counts as above), or null. */
export function parseInterval(text: unknown): number | null {
  const n = number(text);
  if (n !== null) return Math.round(n);
  if (typeof text !== 'string') return null;
  const lower = text.toLowerCase().trim();
  const named = NAMED_INTERVALS.find((i) => i.id === lower.replace(/[\s-]+/g, '_') || i.label.toLowerCase() === lower);
  if (named) return named.steps;
  const size = /(\d+)(?:st|nd|rd|th)?|\b(unison|second|third|fourth|fifth|sixth|seventh|octave)\b/.exec(lower);
  if (!size) return null;
  const words = ['unison', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'octave'];
  const count = size[1] !== undefined ? Number(size[1]) : words.indexOf(size[2] as string) + 1;
  if (count < 2 || count > 8) return null;
  return (count - 1) * (/below|under|down|lower/.test(lower) ? -1 : 1);
}

/** The guide notes of a rule given as a list of {tick, length, pitch}. */
function guideNotesOf(v: unknown): GuideNote[] {
  const rule = sanitizeRule({ kind: 'midi', notes: v });
  return rule?.kind === 'midi' ? rule.notes : [];
}

/** One voice from loose input: `{ rule, interval?, level, pan, formant }` (see the AI action `make_harmonies`). */
function parseVoice(raw: unknown, index: number, count: number, readers: SpecReaders): VoiceSpec {
  if (typeof raw !== 'object' || raw === null) throw new HarmonySpecError(`Voice ${index + 1} is not understood.`);
  const v = raw as Record<string, unknown>;
  const rule = parseRule(v, index, readers);
  const levelDb = number(v.level) ?? number(v.level_db) ?? defaultLevelDb(count);
  const pan = number(v.pan) ?? defaultPan(index, count);
  const formant = number(v.formant) ?? number(v.formant_cents) ?? 0;
  return { rule, levelDb: Math.max(-24, Math.min(6, levelDb)), pan: Math.max(-1, Math.min(1, pan)), formantCents: Math.max(-300, Math.min(300, formant)) };
}

/** The rule of a loose voice: a named interval, `diatonic` + interval, `chord_above`/`chord_below`, `fixed` + semitones, or `guide` + notes. */
function parseRule(v: Record<string, unknown>, index: number, readers: SpecReaders): HarmonyRule {
  const name = typeof v.rule === 'string' ? v.rule.toLowerCase().trim().replace(/[\s-]+/g, '_') : '';
  const where = `Voice ${index + 1}`;
  const named = NAMED_INTERVALS.find((i) => i.id === name);
  if (named) return { kind: 'interval', steps: named.steps };
  switch (name) {
    case 'diatonic':
    case 'interval':
    case 'key': {
      const steps = parseInterval(v.interval);
      if (steps === null || steps === 0) throw new HarmonySpecError(`${where}: say the interval, e.g. "3rd above" or "5th below".`);
      return { kind: 'interval', steps: Math.max(-7, Math.min(7, steps)) };
    }
    case 'chord_above':
    case 'chord_below':
      return { kind: 'chord', side: name === 'chord_above' ? 'above' : 'below' };
    case 'chord':
      return { kind: 'chord', side: /below|down|under/.test(String(v.interval ?? v.side ?? '')) ? 'below' : 'above' };
    case 'fixed':
    case 'semitones': {
      const semitones = number(v.interval) ?? number(v.semitones);
      if (semitones === null) throw new HarmonySpecError(`${where}: a fixed interval needs interval in semitones (e.g. 4 or -7).`);
      return { kind: 'semitones', semitones: Math.max(-12, Math.min(12, semitones)) };
    }
    case 'guide':
    case 'midi': {
      const notes = Array.isArray(v.notes) ? guideNotesOf(v.notes) : typeof v.channel === 'string' ? readers.guide(v.channel) : [];
      if (notes.length === 0) throw new HarmonySpecError(`${where}: a guide melody needs notes (a list of {tick, length, pitch}) or channel (an instrument channel that plays them).`);
      return { kind: 'midi', notes };
    }
    default:
      throw new HarmonySpecError(`${where}: unknown rule "${String(v.rule)}" (a named interval like third_above, diatonic, chord_above, chord_below, fixed, guide).`);
  }
}

/** What reading a request needs from the project: the notes a channel plays (for a guide melody). */
export interface SpecReaders {
  /** The notes of the channel named (id or name); empty when there is no such channel or it plays nothing. */
  guide(channel: string): GuideNote[];
}

const NO_READERS: SpecReaders = { guide: () => [] };

/** A request from loose input: `{ voices: [...], humanize?: { timing_ms, drift_cents, vibrato }, seed? }`. */
export function parseVoiceSpec(raw: { voices?: unknown; humanize?: unknown; seed?: unknown }, readers: SpecReaders = NO_READERS): HarmonySpec {
  if (!Array.isArray(raw.voices) || raw.voices.length === 0) throw new HarmonySpecError('Say which voices to make (1–4), e.g. a third above and a fifth below.');
  if (raw.voices.length > MAX_HARMONY_VOICES) throw new HarmonySpecError(`At most ${MAX_HARMONY_VOICES} voices at a time.`);
  const voices = raw.voices.map((v, i, all) => parseVoice(v, i, all.length, readers));
  const h = typeof raw.humanize === 'object' && raw.humanize !== null ? (raw.humanize as Record<string, unknown>) : {};
  const humanize = clampHumanize({
    timingMs: number(h.timing_ms) ?? number(h.timingMs) ?? DEFAULT_HUMANIZE.timingMs,
    driftCents: number(h.drift_cents) ?? number(h.driftCents) ?? DEFAULT_HUMANIZE.driftCents,
    vibrato: number(h.vibrato) ?? DEFAULT_HUMANIZE.vibrato,
  });
  const seed = number(raw.seed);
  return { voices, humanize, ...(seed !== null ? { seed: Math.round(seed) >>> 0 } : {}) };
}
