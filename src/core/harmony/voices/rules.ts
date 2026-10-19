/**
 * The harmony rules in words: the named intervals the dialog and the AI offer, how a rule reads aloud, and how loose input
 * (a saved project, the AI) becomes a valid rule or record.
 */
import type { GuideNote, HarmonyHumanize, HarmonyRule, HarmonyVoiceRecord } from '../../model/types';
import { clampHumanize, DEFAULT_HUMANIZE } from './humanize';
import { MAX_FORMANT_CENTS } from './render';

/** A diatonic interval the dialog offers by name. */
export interface NamedInterval {
  id: string;
  label: string;
  /** Scale steps from the lead (+2 = a third above). */
  steps: number;
}

/** The diatonic intervals, nearest first. */
export const NAMED_INTERVALS: readonly NamedInterval[] = [
  { id: 'third_above', label: '3rd above', steps: 2 },
  { id: 'third_below', label: '3rd below', steps: -2 },
  { id: 'fifth_above', label: '5th above', steps: 4 },
  { id: 'fifth_below', label: '5th below', steps: -4 },
  { id: 'sixth_above', label: '6th above', steps: 5 },
  { id: 'sixth_below', label: '6th below', steps: -5 },
  { id: 'octave_above', label: 'Octave above', steps: 7 },
  { id: 'octave_below', label: 'Octave below', steps: -7 },
];

/** The largest number of scale steps a rule moves (an octave). */
export const MAX_INTERVAL_STEPS = 7;
/** The most guide notes a rule keeps. */
export const MAX_GUIDE_NOTES = 4096;
/** The most voices one run makes. */
export const MAX_HARMONY_VOICES = 4;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The rule in words ("3rd above", "chord tone above", "+7 semitones", "guide melody"). */
export function describeRule(rule: HarmonyRule): string {
  switch (rule.kind) {
    case 'interval': {
      const named = NAMED_INTERVALS.find((n) => n.steps === rule.steps);
      if (named) return named.label;
      const size = Math.abs(rule.steps) + 1;
      return `${size}${ordinalSuffix(size)} ${rule.steps >= 0 ? 'above' : 'below'}`;
    }
    case 'semitones':
      return `${rule.semitones >= 0 ? '+' : '−'}${Math.abs(rule.semitones)} semitones`;
    case 'chord':
      return `chord tone ${rule.side}`;
    case 'midi':
      return 'guide melody';
  }
}

function ordinalSuffix(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return 'th';
  return ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
}

/** A rule from loose data, or null when it is not one (steps and semitones are rounded and held to an octave). */
export function sanitizeRule(v: unknown): HarmonyRule | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  switch (r.kind) {
    case 'interval':
      return finite(r.steps) && Math.round(r.steps) !== 0 ? { kind: 'interval', steps: clamp(Math.round(r.steps), -MAX_INTERVAL_STEPS, MAX_INTERVAL_STEPS) } : null;
    case 'semitones':
      return finite(r.semitones) ? { kind: 'semitones', semitones: clamp(Math.round(r.semitones * 100) / 100, -12, 12) } : null;
    case 'chord':
      return r.side === 'above' || r.side === 'below' ? { kind: 'chord', side: r.side } : null;
    case 'midi':
      return Array.isArray(r.notes) ? { kind: 'midi', notes: sanitizeGuide(r.notes) } : null;
    default:
      return null;
  }
}

function sanitizeGuide(list: readonly unknown[]): GuideNote[] {
  const notes: GuideNote[] = [];
  for (const item of list.slice(0, MAX_GUIDE_NOTES)) {
    if (typeof item !== 'object' || item === null) continue;
    const n = item as Record<string, unknown>;
    if (!finite(n.tick) || !finite(n.length) || !finite(n.pitch) || n.length <= 0 || n.tick < 0) continue;
    notes.push({ tick: Math.round(n.tick), length: Math.max(1, Math.round(n.length)), pitch: clamp(n.pitch, 0, 127) });
  }
  return notes;
}

function sanitizeHumanize(v: unknown): HarmonyHumanize {
  if (typeof v !== 'object' || v === null) return { ...DEFAULT_HUMANIZE };
  const h = v as Record<string, unknown>;
  return clampHumanize({
    timingMs: finite(h.timingMs) ? h.timingMs : DEFAULT_HUMANIZE.timingMs,
    driftCents: finite(h.driftCents) ? h.driftCents : DEFAULT_HUMANIZE.driftCents,
    vibrato: finite(h.vibrato) ? h.vibrato : DEFAULT_HUMANIZE.vibrato,
  });
}

/** A harmony record from loose data (a saved project), or null when it is not usable (no lead, no valid rule). */
export function sanitizeHarmonyRecord(v: unknown): HarmonyVoiceRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const rule = sanitizeRule(r.rule);
  if (!rule || typeof r.source !== 'string' || !r.source || typeof r.group !== 'string') return null;
  const record: HarmonyVoiceRecord = {
    group: r.group,
    voice: finite(r.voice) ? Math.max(0, Math.round(r.voice)) : 0,
    source: r.source as HarmonyVoiceRecord['source'],
    rule,
    formantCents: finite(r.formantCents) ? clamp(r.formantCents, -MAX_FORMANT_CENTS, MAX_FORMANT_CENTS) : 0,
    humanize: sanitizeHumanize(r.humanize),
    seed: finite(r.seed) ? Math.round(r.seed) >>> 0 : 0,
  };
  if (typeof r.renderedFor === 'string') record.renderedFor = r.renderedFor;
  return record;
}
