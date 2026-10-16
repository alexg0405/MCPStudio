/**
 * A controller mapping: which physical control (a MIDI note, CC, 14-bit CC pair or pitch bend on a
 * channel) drives which DJ target, which buttons are shift keys, and which LEDs mirror which state.
 * Mappings are plain JSON (saved per device, exported and imported as files).
 */
import { REL_ENCODINGS, type RelEncoding } from './relative';
import { isTargetId } from './targets';

export type InputSpec =
  | { type: 'note'; channel: number; note: number }
  | { type: 'cc'; channel: number; cc: number }
  /** Coarse byte on `cc` (0–31), fine byte on `cc + 32`. */
  | { type: 'cc14'; channel: number; cc: number }
  | { type: 'rel'; channel: number; cc: number; encoding: RelEncoding }
  | { type: 'bend'; channel: number };

export type InputType = InputSpec['type'];

export interface Binding {
  input: InputSpec;
  target: string;
  /** The shift key (an id from `shifts`) that must be held; none = the normal layer. */
  layer?: string;
  /** Reverse the direction (a fader that sends high when pushed down). */
  invert?: boolean;
  /** Multiplies relative steps (a jog wheel that is too slow or too fast). */
  scale?: number;
}

export interface ShiftKey {
  id: string;
  input: InputSpec;
}

/** Where an LED lives: a note (velocity = brightness) or a CC (value = brightness). */
export interface OutputSpec {
  type: 'note' | 'cc';
  channel: number;
  number: number;
  /** Value sent when the state is on (default 127) and off (default 0). */
  on?: number;
  off?: number;
}

export interface LedBinding {
  /** The target whose state it shows ("A.play" lit while deck A plays). */
  state: string;
  out: OutputSpec;
}

export interface ControllerMapping {
  version: 1;
  /** What the musician sees (a device name or "My controller"). */
  name: string;
  /** The preset this came from, if any. */
  preset?: string;
  shifts: ShiftKey[];
  bindings: Binding[];
  leds: LedBinding[];
  /**
   * Also light a button's LED at the button's own address (most controllers listen on the note the
   * button sends). Explicit `leds` win over this.
   */
  ledFromButtons: boolean;
  /** Faders and knobs wait until the hardware reaches the software value. */
  softTakeover: boolean;
}

export const emptyMapping = (name: string): ControllerMapping => ({
  version: 1,
  name,
  shifts: [],
  bindings: [],
  leds: [],
  ledFromButtons: true,
  softTakeover: true,
});

/** "Ch 2 note 36", "Ch 1 CC 7 (14-bit)", "Ch 1 jog CC 33"… */
export function describeInput(i: InputSpec): string {
  const ch = `Ch ${i.channel + 1}`;
  switch (i.type) {
    case 'note':
      return `${ch} note ${i.note}`;
    case 'cc':
      return `${ch} CC ${i.cc}`;
    case 'cc14':
      return `${ch} CC ${i.cc}+${i.cc + 32} (14-bit)`;
    case 'rel':
      return `${ch} CC ${i.cc} (endless, ${i.encoding === 'twos' ? 'two’s complement' : i.encoding === 'signmag' ? 'sign-magnitude' : 'centred on 64'})`;
    case 'bend':
      return `${ch} pitch bend`;
  }
}

/** The hardware address of an input, ignoring how it is read (so a CC and a 14-bit pair on it collide). */
export function inputKey(i: InputSpec): string {
  switch (i.type) {
    case 'note':
      return `n:${i.channel}:${i.note}`;
    case 'cc':
    case 'rel':
      return `c:${i.channel}:${i.cc}`;
    case 'cc14':
      return `c:${i.channel}:${i.cc}`;
    case 'bend':
      return `b:${i.channel}`;
  }
}

const int = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null;

export function sanitizeInput(raw: unknown): InputSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const channel = int(o.channel, 0, 15);
  if (channel === null) return null;
  switch (o.type) {
    case 'note': {
      const note = int(o.note, 0, 127);
      return note === null ? null : { type: 'note', channel, note };
    }
    case 'cc': {
      const cc = int(o.cc, 0, 127);
      return cc === null ? null : { type: 'cc', channel, cc };
    }
    case 'cc14': {
      const cc = int(o.cc, 0, 31);
      return cc === null ? null : { type: 'cc14', channel, cc };
    }
    case 'rel': {
      const cc = int(o.cc, 0, 127);
      const encoding = REL_ENCODINGS.find((e) => e === o.encoding);
      return cc === null || !encoding ? null : { type: 'rel', channel, cc, encoding };
    }
    case 'bend':
      return { type: 'bend', channel };
    default:
      return null;
  }
}

function sanitizeOutput(raw: unknown): OutputSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const channel = int(o.channel, 0, 15);
  const number = int(o.number, 0, 127);
  if (channel === null || number === null || (o.type !== 'note' && o.type !== 'cc')) return null;
  const on = int(o.on, 0, 127);
  const off = int(o.off, 0, 127);
  return { type: o.type, channel, number, ...(on !== null ? { on } : {}), ...(off !== null ? { off } : {}) };
}

/**
 * Reads a mapping from untrusted JSON (a file the musician imported, or something saved by an older
 * version). Unknown targets and malformed entries are dropped; the count of dropped ones is returned.
 */
export function sanitizeMapping(raw: unknown, fallbackName = 'Imported controller'): { mapping: ControllerMapping; dropped: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.bindings)) return null;
  let dropped = 0;
  const shifts: ShiftKey[] = [];
  for (const s of Array.isArray(o.shifts) ? o.shifts : []) {
    const input = sanitizeInput((s as { input?: unknown })?.input);
    const id = (s as { id?: unknown })?.id;
    if (input && typeof id === 'string' && id) shifts.push({ id, input });
    else dropped++;
  }
  const layers = new Set(shifts.map((s) => s.id));
  const bindings: Binding[] = [];
  for (const b of o.bindings as unknown[]) {
    const x = b as Record<string, unknown> | null;
    const input = sanitizeInput(x?.input);
    const layer = typeof x?.layer === 'string' && x.layer ? x.layer : undefined;
    if (!x || !input || !isTargetId(x.target) || (layer !== undefined && !layers.has(layer))) {
      dropped++;
      continue;
    }
    const scale = typeof x.scale === 'number' && Number.isFinite(x.scale) && x.scale > 0 ? Math.min(20, x.scale) : undefined;
    bindings.push({
      input,
      target: x.target,
      ...(layer ? { layer } : {}),
      ...(x.invert === true ? { invert: true } : {}),
      ...(scale !== undefined && scale !== 1 ? { scale } : {}),
    });
  }
  const leds: LedBinding[] = [];
  for (const l of Array.isArray(o.leds) ? o.leds : []) {
    const x = l as Record<string, unknown> | null;
    const out = sanitizeOutput(x?.out);
    if (x && out && isTargetId(x.state)) leds.push({ state: x.state, out });
    else dropped++;
  }
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 80) : fallbackName;
  return {
    dropped,
    mapping: {
      version: 1,
      name,
      ...(typeof o.preset === 'string' ? { preset: o.preset } : {}),
      shifts,
      bindings,
      leds,
      ledFromButtons: o.ledFromButtons !== false,
      softTakeover: o.softTakeover !== false,
    },
  };
}

export function mappingToJson(m: ControllerMapping): string {
  return JSON.stringify({ format: 'agstudio-controller-mapping', ...m }, null, 2);
}

export function mappingFromJson(text: string): { mapping: ControllerMapping; dropped: number } | null {
  try {
    return sanitizeMapping(JSON.parse(text));
  } catch {
    return null;
  }
}
