/** Reading the AI's loosely typed values: strings, numbers, keys, plugin params, levels. */
import { MAX_INSERT_VOLUME } from '@core/model/fader';
import { KIT } from '@core/model/kit';
import { SCALES } from '@agstudio/sdk/notes';
import { dbToGain, type ParamSpec, type ParamSpecs, type ParamValue } from '@agstudio/sdk';

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
export const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
export const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
export const lower = (x: string) => x.trim().toLowerCase();
export const r2 = (v: number) => Math.round(v * 100) / 100;

const NOTE_NAMES: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

const SCALE_ALIASES: Record<string, string> = {
  '': 'major',
  m: 'minor',
  min: 'minor',
  maj: 'major',
  ionian: 'major',
  aeolian: 'minor',
  'natural-minor': 'minor',
  'pentatonic-minor': 'minor-pentatonic',
  'pentatonic-major': 'major-pentatonic',
  pentatonic: 'major-pentatonic',
  'minor-blues': 'blues',
  'blues-major': 'major-blues',
};

/** "F# minor" → { root: 6, scale: 'minor' }; "none" → null; undefined if unreadable. Scales are the SDK's ids. */
export function parseKey(text: string): { root: number; scale: string } | null | undefined {
  const t = lower(text);
  if (t === 'none' || t === 'no key' || t === '') return null;
  const m = /^([a-g])\s*(#|♯|b|♭)?\s*(.*)$/.exec(t);
  if (!m) return undefined;
  let root = NOTE_NAMES[m[1]!]!;
  if (m[2] === '#' || m[2] === '♯') root += 1;
  if (m[2] === 'b' || m[2] === '♭') root -= 1;
  const words = (m[3] ?? '').replace(/\b(scale|mode|key)\b/g, '').trim().replace(/\s+/g, '-');
  const scale =
    SCALE_ALIASES[words] ??
    SCALES.find((sc) => sc.id === words || lower(sc.label).replace(/\s+/g, '-') === words)?.id;
  return scale ? { root: ((root % 12) + 12) % 12, scale } : undefined;
}

/** A value the AI wrote, turned into a valid value of the param (null when it can't be). */
export function coerceParam(spec: ParamSpec, raw: unknown): ParamValue | null {
  switch (spec.type) {
    case 'float':
    case 'int': {
      let n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseFloat(raw) : Number.NaN;
      if (typeof raw === 'boolean') n = raw ? spec.max : spec.min;
      if (!Number.isFinite(n)) return null;
      // "50" for 50 % → 0.5.
      if (spec.unit === '%' && spec.max <= 1 && n > 1 && n <= 100) n /= 100;
      n = Math.min(spec.max, Math.max(spec.min, n));
      return spec.type === 'int' ? Math.round(n) : n;
    }
    case 'enum': {
      const t = lower(String(raw));
      const labels = spec.labels as Record<string, string | undefined> | undefined;
      const hit =
        spec.options.find((o) => lower(o) === t) ?? spec.options.find((o) => labels?.[o] && lower(labels[o]!) === t);
      if (hit) return hit;
      if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < spec.options.length)
        return spec.options[raw]!;
      return null;
    }
    case 'bool': {
      if (typeof raw === 'boolean') return raw;
      if (typeof raw === 'number') return raw >= 0.5;
      const t = lower(String(raw));
      if (['on', 'true', 'yes', '1'].includes(t)) return true;
      if (['off', 'false', 'no', '0'].includes(t)) return false;
      return null;
    }
  }
}

export function findParamId(specs: ParamSpecs, name: string): string | undefined {
  if (specs[name]) return name;
  const t = lower(name);
  return Object.keys(specs).find((id) => lower(id) === t || lower((specs[id] as ParamSpec).label ?? '') === t);
}

export const channelGain = (dbv: number) => Math.min(1.25, dbv <= -100 ? 0 : dbToGain(dbv));
export const insertGain = (dbv: number) => Math.min(MAX_INSERT_VOLUME, dbv <= -100 ? 0 : dbToGain(dbv));

/** A built-in kit sound for a Sampler, from the AI's word or the channel's name. */
export const kitSample = (raw: unknown, fallbackName: string): string | undefined => {
  const want = lower(str(raw) ?? fallbackName);
  const alias: Record<string, string> = {
    kick: 'kit/kick',
    snare: 'kit/snare',
    clap: 'kit/clap',
    hat: 'kit/hat-closed',
    'closed hat': 'kit/hat-closed',
    hihat: 'kit/hat-closed',
    'hi-hat': 'kit/hat-closed',
    'open-hat': 'kit/hat-open',
    'open hat': 'kit/hat-open',
    'tom-low': 'kit/tom-low',
    'tom-mid': 'kit/tom-mid',
    'tom-high': 'kit/tom-high',
    rim: 'kit/rim',
    cowbell: 'kit/cowbell',
    crash: 'kit/crash',
  };
  if (alias[want]) return alias[want];
  const piece = KIT.find((k) => lower(k.name) === want || want.includes(lower(k.short)));
  return piece?.generator;
};
