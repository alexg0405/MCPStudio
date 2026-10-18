/**
 * Turns the raw messages of one controller into control events for DJ targets, following its mapping:
 * buttons (notes, or CCs used as buttons), faders and knobs (7-bit, 14-bit pairs, pitch bend), endless
 * dials (the three relative encodings) and shift layers. No soft takeover here (that needs the
 * current value of the target: `app/dj/controllers`) and no decks: events are plain data.
 */
import { Cc14Assembler, norm14 } from './cc14';
import type { MidiMessage } from './message';
import { decodeRelative } from './relative';
import { targetInfo } from './targets';
import type { Binding, ControllerMapping, InputSpec } from './types';

/** What a mapped control did: a button went down or up, a fader or knob moved to a value, or a dial turned by some steps. */
export type ControlEvent =
  | { target: string; kind: 'button'; down: boolean; velocity: number }
  | { target: string; kind: 'abs'; value: number; layer?: string }
  | { target: string; kind: 'rel'; delta: number };

/** Turns the MIDI messages of a device into control events through its mapping (shift layers, 14-bit pairs, dial encodings). */
export class MappingInterpreter {
  private mapping!: ControllerMapping;
  private notes = new Map<string, Binding[]>();
  private ccs = new Map<string, Binding[]>();
  private cc14s = new Map<string, Binding[]>();
  private bends = new Map<number, Binding[]>();
  private shiftNotes = new Map<string, string[]>();
  private shiftCcs = new Map<string, string[]>();
  private readonly held = new Set<string>();
  private readonly pressed = new Map<string, Binding>();
  private readonly ccDown = new Map<string, boolean>();
  private readonly assembler = new Cc14Assembler();

  constructor(mapping: ControllerMapping) {
    this.setMapping(mapping);
  }

  setMapping(mapping: ControllerMapping): void {
    this.mapping = mapping;
    this.notes = new Map();
    this.ccs = new Map();
    this.cc14s = new Map();
    this.bends = new Map();
    this.shiftNotes = new Map();
    this.shiftCcs = new Map();
    this.held.clear();
    this.pressed.clear();
    this.ccDown.clear();
    this.assembler.reset();
    const add = <K>(m: Map<K, Binding[]>, k: K, b: Binding) => m.set(k, [...(m.get(k) ?? []), b]);
    for (const b of mapping.bindings) {
      const i = b.input;
      if (i.type === 'note') add(this.notes, `${i.channel}:${i.note}`, b);
      else if (i.type === 'cc' || i.type === 'rel') add(this.ccs, `${i.channel}:${i.cc}`, b);
      else if (i.type === 'cc14') add(this.cc14s, `${i.channel}:${i.cc}`, b);
      else add(this.bends, i.channel, b);
    }
    for (const s of mapping.shifts) {
      const i = s.input;
      const map = i.type === 'note' ? this.shiftNotes : this.shiftCcs;
      const key = i.type === 'note' ? `${i.channel}:${i.note}` : i.type === 'cc' ? `${i.channel}:${i.cc}` : null;
      if (key) map.set(key, [...(map.get(key) ?? []), s.id]);
    }
  }

  /** The shift keys held right now. */
  get layers(): ReadonlySet<string> {
    return this.held;
  }

  /** Forget held keys (the controller was unplugged or re-mapped). */
  reset(): void {
    this.held.clear();
    this.pressed.clear();
    this.ccDown.clear();
    this.assembler.reset();
  }

  private pick(bindings: readonly Binding[] | undefined): Binding | null {
    if (!bindings) return null;
    for (const b of bindings) if (b.layer && this.held.has(b.layer)) return b;
    for (const b of bindings) if (!b.layer) return b;
    return null;
  }

  process(msg: MidiMessage): ControlEvent[] {
    const out: ControlEvent[] = [];
    switch (msg.kind) {
      case 'noteOn':
      case 'noteOff': {
        const down = msg.kind === 'noteOn';
        const key = `${msg.channel}:${msg.note}`;
        for (const id of this.shiftNotes.get(key) ?? []) {
          if (down) this.held.add(id);
          else this.held.delete(id);
        }
        if (down) {
          const b = this.pick(this.notes.get(key));
          if (!b) break;
          if (targetInfo(b.target)?.kind !== 'button') break;
          this.pressed.set(key, b);
          out.push({ target: b.target, kind: 'button', down: true, velocity: msg.velocity / 127 });
        } else {
          const b = this.pressed.get(key);
          if (!b) break;
          this.pressed.delete(key);
          out.push({ target: b.target, kind: 'button', down: false, velocity: 0 });
        }
        break;
      }
      case 'cc':
        this.cc(msg.channel, msg.cc, msg.value, out);
        break;
      case 'bend': {
        const b = this.pick(this.bends.get(msg.channel));
        if (b && targetInfo(b.target)?.kind === 'abs') out.push(this.abs(b, msg.value / 16383));
        break;
      }
    }
    return out;
  }

  private abs(b: Binding, v: number): ControlEvent {
    return { target: b.target, kind: 'abs', value: b.invert ? 1 - v : v, ...(b.layer ? { layer: b.layer } : {}) };
  }

  private cc(channel: number, cc: number, value: number, out: ControlEvent[]): void {
    // Shift keys that are CCs (held while the value is high).
    for (const id of this.shiftCcs.get(`${channel}:${cc}`) ?? []) {
      if (value >= 64) this.held.add(id);
      else this.held.delete(id);
    }
    // A plain or relative control on this CC.
    const b = this.pick(this.ccs.get(`${channel}:${cc}`));
    if (b) {
      const kind = targetInfo(b.target)?.kind;
      const i: InputSpec = b.input;
      if (i.type === 'rel') {
        if (kind === 'rel') {
          const steps = decodeRelative(value, i.encoding);
          if (steps !== 0) out.push({ target: b.target, kind: 'rel', delta: steps * (b.scale ?? 1) * (b.invert ? -1 : 1) });
        }
      } else if (kind === 'abs') {
        out.push(this.abs(b, value / 127));
      } else if (kind === 'button') {
        const key = `${channel}:${cc}`;
        const down = value >= 64;
        if (this.ccDown.get(key) !== down) {
          this.ccDown.set(key, down);
          out.push({ target: b.target, kind: 'button', down, velocity: value / 127 });
        }
      }
    }
    // A 14-bit pair: CC n (0–31) is the coarse byte, n+32 the fine byte.
    const isLsb = cc >= 32 && cc < 64;
    const msb = isLsb ? cc - 32 : cc;
    if (msb < 32) {
      const bindings = this.cc14s.get(`${channel}:${msb}`);
      if (bindings) {
        const v = this.assembler.feed(channel, msb, isLsb, value);
        const b14 = this.pick(bindings);
        if (v !== null && b14 && targetInfo(b14.target)?.kind === 'abs') out.push(this.abs(b14, norm14(v)));
      }
    }
  }
}
