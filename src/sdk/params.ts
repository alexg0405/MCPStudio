/**
 * Declarative plugin parameters. Imported by the main thread, by core and by audio-thread code,
 * so this file must not use DOM or AudioWorklet globals.
 *
 * Value conventions (stored in the project document, owned by the host):
 * - float/int: plain numbers in the declared unit. Unit '%' means a 0–1 value displayed as a percentage.
 * - enum: the option string. bool: boolean.
 */

export type Unit = '' | 'Hz' | 'dB' | 'ms' | 's' | '%' | 'st' | 'ct' | 'x' | 'beats';

interface Common<T> {
  label?: string;
  default: T;
  /** Shown in the hint bar. */
  hint?: string;
  /** Groups knobs into sections in the auto-generated panel. */
  group?: string;
  /** Defaults to true for float/int params. */
  automatable?: boolean;
}

export interface FloatSpec extends Common<number> {
  type: 'float';
  min: number;
  max: number;
  /** How knobs map their travel: 'log' needs min > 0. 'db' is linear in decibels. */
  scale?: 'linear' | 'log' | 'db';
  unit?: Unit;
  /** Smoothing time constant in seconds for live changes (default 0.008). */
  smoothing?: number;
}

export interface IntSpec extends Common<number> {
  type: 'int';
  min: number;
  max: number;
  unit?: Unit;
}

export interface EnumSpec<O extends string = string> extends Common<O> {
  type: 'enum';
  options: readonly O[];
  /** Display labels per option (defaults to the option id). */
  labels?: Partial<Record<O, string>>;
}

export interface BoolSpec extends Common<boolean> {
  type: 'bool';
}

export type ParamSpec = FloatSpec | IntSpec | EnumSpec | BoolSpec;
export type ParamSpecs = Record<string, ParamSpec>;
export type ParamValue = number | boolean | string;
export type ValueOf<S> = S extends EnumSpec<infer O> ? O : S extends BoolSpec ? boolean : number;
export type ParamValues<P extends ParamSpecs> = { [K in keyof P]: ValueOf<P[K]> };

/** Shorthand constructors: `p.float(20, 20000, 1000, { scale: 'log', unit: 'Hz' })`. */
export const p = {
  float: (min: number, max: number, def: number, o: Partial<Omit<FloatSpec, 'type'>> = {}): FloatSpec => ({
    type: 'float',
    min,
    max,
    default: def,
    ...o,
  }),
  int: (min: number, max: number, def: number, o: Partial<Omit<IntSpec, 'type'>> = {}): IntSpec => ({
    type: 'int',
    min,
    max,
    default: def,
    ...o,
  }),
  enum: <const O extends readonly string[]>(
    options: O,
    def: O[number],
    o: Partial<Omit<EnumSpec<O[number]>, 'type' | 'options'>> = {},
  ): EnumSpec<O[number]> => ({ type: 'enum', options, default: def, ...o }),
  bool: (def: boolean, o: Partial<Omit<BoolSpec, 'type'>> = {}): BoolSpec => ({ type: 'bool', default: def, ...o }),
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Clamps/rounds/validates a value; falls back to the default for the wrong type. */
export function sanitize(spec: ParamSpec, value: unknown): ParamValue {
  switch (spec.type) {
    case 'float':
      return typeof value === 'number' && Number.isFinite(value) ? clamp(value, spec.min, spec.max) : spec.default;
    case 'int':
      return typeof value === 'number' && Number.isFinite(value)
        ? clamp(Math.round(value), spec.min, spec.max)
        : spec.default;
    case 'enum':
      return typeof value === 'string' && spec.options.includes(value) ? value : spec.default;
    case 'bool':
      return typeof value === 'boolean' ? value : spec.default;
  }
}

/** Complete, sanitized values for every declared param (stored values may be partial or outdated). */
export function resolveValues<P extends ParamSpecs>(
  specs: P,
  stored: Readonly<Record<string, unknown>> | undefined,
): ParamValues<P> {
  const out: Record<string, ParamValue> = {};
  for (const key of Object.keys(specs)) {
    const spec = specs[key] as ParamSpec;
    out[key] = sanitize(spec, stored?.[key]);
  }
  return out as ParamValues<P>;
}

export function defaultValues(specs: ParamSpecs): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const [key, spec] of Object.entries(specs)) out[key] = spec.default;
  return out;
}

/** Maps a value to knob travel 0–1. */
export function toNormalized(spec: ParamSpec, value: ParamValue): number {
  switch (spec.type) {
    case 'float': {
      const v = clamp(Number(value), spec.min, spec.max);
      if (spec.max === spec.min) return 0;
      if (spec.scale === 'log' && spec.min > 0) return Math.log(v / spec.min) / Math.log(spec.max / spec.min);
      return (v - spec.min) / (spec.max - spec.min);
    }
    case 'int':
      return spec.max === spec.min ? 0 : (clamp(Number(value), spec.min, spec.max) - spec.min) / (spec.max - spec.min);
    case 'enum': {
      const i = Math.max(0, spec.options.indexOf(String(value)));
      return spec.options.length > 1 ? i / (spec.options.length - 1) : 0;
    }
    case 'bool':
      return value ? 1 : 0;
  }
}

/** Inverse of toNormalized. */
export function fromNormalized(spec: ParamSpec, n: number): ParamValue {
  const t = clamp(n, 0, 1);
  switch (spec.type) {
    case 'float':
      if (spec.scale === 'log' && spec.min > 0) return spec.min * Math.pow(spec.max / spec.min, t);
      return spec.min + t * (spec.max - spec.min);
    case 'int':
      return Math.round(spec.min + t * (spec.max - spec.min));
    case 'enum':
      return spec.options[Math.round(t * (spec.options.length - 1))] ?? spec.default;
    case 'bool':
      return t >= 0.5;
  }
}

/** Whether automation and controller links may drive the param (floats and ints unless they opt out). */
export function isAutomatable(spec: ParamSpec): boolean {
  return spec.automatable ?? (spec.type === 'float' || spec.type === 'int');
}

/** Numeric encoding used for AudioParams: enum → index, bool → 0/1. */
export function encode(spec: ParamSpec, value: ParamValue): number {
  switch (spec.type) {
    case 'enum':
      return Math.max(0, spec.options.indexOf(String(value)));
    case 'bool':
      return value ? 1 : 0;
    default:
      return Number(value);
  }
}

export function decode(spec: ParamSpec, n: number): ParamValue {
  switch (spec.type) {
    case 'enum':
      return spec.options[clamp(Math.round(n), 0, spec.options.length - 1)] ?? spec.default;
    case 'bool':
      return n >= 0.5;
    case 'int':
      return Math.round(n);
    default:
      return n;
  }
}

/** Subset of AudioParamDescriptor (not available in the ES lib). */
export interface ParamDescriptorLike {
  name: string;
  defaultValue: number;
  minValue: number;
  maxValue: number;
  automationRate: 'a-rate' | 'k-rate';
}

/**
 * AudioParam descriptors for an AudioWorkletProcessor: the params automation can drive (floats
 * a-rate, ints k-rate). Enums, switches and `automatable: false` params reach the kernel as events
 * instead (see messageParamNames): every AudioParam costs the browser time each block.
 */
export function descriptors(specs: ParamSpecs): ParamDescriptorLike[] {
  return Object.entries(specs)
    .filter(([, spec]) => isAutomatable(spec))
    .map(([name, spec]) => {
    switch (spec.type) {
      case 'float':
        return { name, defaultValue: spec.default, minValue: spec.min, maxValue: spec.max, automationRate: 'a-rate' };
      case 'int':
        return { name, defaultValue: spec.default, minValue: spec.min, maxValue: spec.max, automationRate: 'k-rate' };
      case 'enum':
        return {
          name,
          defaultValue: encode(spec, spec.default),
          minValue: 0,
          maxValue: Math.max(0, spec.options.length - 1),
          automationRate: 'k-rate',
        };
      case 'bool':
        return { name, defaultValue: spec.default ? 1 : 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' };
    }
  });
}

/** The params a worklet kernel gets as events, not AudioParams (their order is the event index). */
export function messageParamNames(specs: ParamSpecs): string[] {
  return Object.entries(specs)
    .filter(([, spec]) => !isAutomatable(spec))
    .map(([name]) => name);
}

function trimNumber(v: number, digits: number): string {
  return v.toFixed(digits);
}

/** Display text for a value, e.g. "1.20 kHz", "-6.0 dB", "120 ms", "50%". */
export function formatValue(spec: ParamSpec, value: ParamValue): string {
  if (spec.type === 'bool') return value ? 'On' : 'Off';
  if (spec.type === 'enum') {
    const key = String(value);
    return (spec.labels as Record<string, string | undefined> | undefined)?.[key] ?? key;
  }
  const v = Number(value);
  const isInt = spec.type === 'int';
  switch (spec.unit) {
    case 'Hz':
      return v >= 1000 ? `${trimNumber(v / 1000, v >= 10000 ? 1 : 2)} kHz` : `${trimNumber(v, v < 100 ? 1 : 0)} Hz`;
    case 'dB':
      if (spec.type === 'float' && v <= spec.min && spec.min <= -60) return '-∞ dB';
      return `${v > 0 ? '+' : ''}${trimNumber(v, 1)} dB`;
    case 'ms':
      return `${trimNumber(v, v < 10 && !isInt ? 1 : 0)} ms`;
    case 's':
      return v < 1 ? `${trimNumber(v * 1000, 0)} ms` : `${trimNumber(v, 2)} s`;
    case '%':
      return `${trimNumber(v * 100, 0)}%`;
    case 'st':
      return `${v > 0 ? '+' : ''}${trimNumber(v, isInt ? 0 : 2)} st`;
    case 'ct':
      return `${v > 0 ? '+' : ''}${trimNumber(v, 0)} ct`;
    case 'x':
      return `${trimNumber(v, 2)}x`;
    case 'beats':
      return `${trimNumber(v, isInt ? 0 : 2)} beats`;
    default:
      return isInt ? String(Math.round(v)) : trimNumber(v, Math.abs(v) < 10 ? 2 : 1);
  }
}
