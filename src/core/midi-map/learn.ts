/**
 * MIDI learn: works out what kind of control the musician is touching from the messages it sends.
 *
 *  - a note → a button (or a touch sensor);
 *  - pitch bend → a 14-bit fader;
 *  - a CC and the CC 32 higher, together → a 14-bit pair (coarse + fine byte);
 *  - one CC whose values sweep through the range → an absolute fader or knob;
 *  - one CC whose values stay in the "few steps either way" patterns → an endless dial, and which of
 *    the three encodings (two's complement, sign-magnitude, centred on 64) from the values it sends
 *    turning one way and the other.
 *
 * What the target needs (`expect`) breaks ties: a fader slot treats a slowly moving CC as a fader, a
 * jog slot treats it as an endless dial.
 */
import type { MidiMessage } from './message';
import type { RelEncoding } from './relative';
import type { TargetKind } from './targets';
import type { InputSpec } from './types';

export type LearnOutcome =
  | { status: 'waiting' }
  | { status: 'progress'; message: string }
  | { status: 'done'; input: InputSpec; certain: boolean };

export type CcAnalysis = { type: 'abs' } | { type: 'rel'; encoding: RelEncoding; certain: boolean };

const inRange = (v: number, lo: number, hi: number) => v >= lo && v <= hi;

/** Is this stream of one CC's values an endless dial (and which encoding), or a fader/knob? */
export function analyzeCcValues(values: readonly number[], expect: TargetKind | 'any' = 'any'): CcAnalysis {
  if (!values.length) return { type: 'abs' };
  const any = (lo: number, hi: number) => values.some((v) => inRange(v, lo, hi));
  const all = (fn: (v: number) => boolean) => values.every(fn);
  // Endless dials never send 0 (0 = no movement).
  if (any(0, 0)) return { type: 'abs' };
  const lo = any(1, 40);
  const offLo = any(41, 63);
  const mid = any(65, 87);
  const hi = any(88, 127);
  // Both directions seen: the pattern tells the encoding.
  if (!lo && !hi && offLo && mid && all((v) => inRange(v, 33, 95))) return { type: 'rel', encoding: 'offset64', certain: true };
  if (lo && hi && !offLo && !mid && all((v) => inRange(v, 1, 31) || inRange(v, 97, 127))) return { type: 'rel', encoding: 'twos', certain: true };
  if (lo && mid && !offLo && !hi && all((v) => inRange(v, 1, 31) || inRange(v, 65, 95))) return { type: 'rel', encoding: 'signmag', certain: true };
  const buckets = [lo, offLo, mid, hi].filter(Boolean).length;
  if (buckets > 1) return { type: 'abs' };
  // One direction only: the same encodings look alike; a steady sweep of different values is a fader.
  if (expect === 'abs') return { type: 'abs' };
  if (expect !== 'rel' && looksLikeSweep(values)) return { type: 'abs' };
  if (offLo) return { type: 'rel', encoding: 'offset64', certain: false };
  if (mid) return { type: 'rel', encoding: all((v) => v <= 80) ? 'offset64' : 'signmag', certain: false };
  return { type: 'rel', encoding: 'twos', certain: false };
}

/** Many different values in one steady direction: a fader pushed slowly, not a dial (which repeats its small steps). */
function looksLikeSweep(values: readonly number[]): boolean {
  if (values.length < 4) return false;
  const distinct = new Set(values).size;
  if (distinct / values.length < 0.75) return false;
  let up = 0;
  let down = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i]! > values[i - 1]!) up++;
    else if (values[i]! < values[i - 1]!) down++;
  }
  return (up === 0 || down === 0) && Math.max(...values) - Math.min(...values) >= 3;
}

export class LearnDetector {
  private group: { channel: number; base: number } | null = null;
  private readonly byCc = new Map<number, number[]>();
  private first = -1;

  /** `expect`: the kind of control the target needs (a hint for ambiguous streams). */
  constructor(private readonly expect: TargetKind | 'any' = 'any') {}

  feed(msg: MidiMessage): LearnOutcome {
    if (msg.kind === 'noteOff') return { status: 'waiting' };
    if (msg.kind === 'noteOn') return done({ type: 'note', channel: msg.channel, note: msg.note }, true);
    if (msg.kind === 'bend') return done({ type: 'bend', channel: msg.channel }, true);
    const { channel, cc, value } = msg;
    // Channel mode messages and the sustain pedal are not controls to learn.
    if (cc === 64 || (cc >= 120 && cc <= 127)) return { status: 'waiting' };
    if (this.expect === 'button') {
      return value >= 64 ? done({ type: 'cc', channel, cc }, true) : { status: 'waiting' };
    }
    const base = cc >= 32 && cc < 64 ? cc - 32 : cc;
    if (!this.group) {
      this.group = { channel, base };
      this.first = cc;
    }
    // Only the control that was touched first counts (and its fine-byte partner).
    if (channel !== this.group.channel || (cc !== this.group.base && cc !== this.group.base + 32 && cc !== this.first)) return { status: 'waiting' };
    this.byCc.set(cc, [...(this.byCc.get(cc) ?? []), value]);
    const g = this.group;
    if (g.base < 32 && this.byCc.has(g.base) && this.byCc.has(g.base + 32)) {
      return done({ type: 'cc14', channel: g.channel, cc: g.base }, true);
    }
    const values = this.byCc.get(this.first) ?? [];
    return this.decide(values, false);
  }

  /** Use what has been seen so far, even if not certain (the "that's enough" button). */
  guess(): InputSpec | null {
    if (!this.group) return null;
    const r = this.decide(this.byCc.get(this.first) ?? [], true);
    return r.status === 'done' ? r.input : null;
  }

  private decide(values: readonly number[], force: boolean): LearnOutcome {
    const g = this.group!;
    const n = values.length;
    if (!n) return { status: 'waiting' };
    const a = analyzeCcValues(values, this.expect);
    const minimum = this.expect === 'abs' ? 3 : 4;
    if (!force && n < minimum) return { status: 'progress', message: 'Keep moving it…' };
    if (a.type === 'abs') {
      // A fader: wait for a few messages so the fine byte of a 14-bit pair can show up.
      if (!force && n < (this.expect === 'abs' ? 3 : 6) && g.base < 32) return { status: 'progress', message: 'Keep moving it…' };
      return done({ type: 'cc', channel: g.channel, cc: this.first }, true);
    }
    if (a.certain || force || n >= 14)
      return done({ type: 'rel', channel: g.channel, cc: this.first, encoding: a.encoding }, a.certain);
    return { status: 'progress', message: 'Keep turning it, then turn it the other way too…' };
  }
}

const done = (input: InputSpec, certain: boolean): LearnOutcome => ({ status: 'done', input, certain });
