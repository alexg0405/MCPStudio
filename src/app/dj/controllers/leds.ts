/**
 * LED feedback: the controller's buttons light up with the state of the decks (play lit while the deck
 * plays, a hot cue pad lit when that cue is set…). `ledStates` reads the deck state; `LedFeedback`
 * sends only what changed, and everything again when a controller connects.
 */
import { ccBytes, noteOnBytes } from '@core/midi-map/message';
import { AUTO_LOOP_BEATS, isLaunchTarget, targetInfo } from '@core/midi-map/targets';
import type { ControllerMapping, LedBinding } from '@core/midi-map/types';
import { DECK_IDS, HOT_CUES, type DecksState } from '../decks-api';
import { loopBeats } from './dispatch';

/** Paused within this many seconds of the cue point = "at the cue point" (the cue LED is lit). */
const AT_CUE_SEC = 0.02;

/** On/off for every target that has an LED ("A.play", "B.hotcue:3", "record"…). */
export function ledStates(state: DecksState): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const id of DECK_IDS) {
    const d = state.decks[id];
    out.set(`${id}.play`, d.playing);
    out.set(`${id}.cue`, !!d.song && !d.playing && Math.abs(d.positionSec - d.cuePoint) < AT_CUE_SEC);
    out.set(`${id}.sync`, d.synced);
    out.set(`${id}.keylock`, d.keyLock);
    out.set(`${id}.pfl`, d.cueListen);
    out.set(`${id}.loopExit`, !!d.loop?.active);
    for (let i = 1; i <= HOT_CUES; i++) out.set(`${id}.hotcue:${i}`, d.hotCues[i - 1] != null);
    const beats = d.loop?.active ? loopBeats(d) : 0;
    for (const b of AUTO_LOOP_BEATS) out.set(`${id}.autoLoop:${b}`, beats === b);
  }
  out.set('record', !!state.recording);
  return out;
}

/** The LEDs of a mapping: the explicit ones, plus (if on) one at each LED-capable button's own note. */
export function ledBindings(mapping: ControllerMapping): LedBinding[] {
  // The clip launcher's pads have their own lights (app/launcher/leds.ts): they are not on/off deck lights.
  const out = mapping.leds.filter((l) => !isLaunchTarget(l.state));
  if (!mapping.ledFromButtons) return out;
  const explicit = new Set(mapping.leds.map((l) => l.state));
  const seen = new Set<string>();
  for (const b of mapping.bindings) {
    if (b.input.type !== 'note' || explicit.has(b.target) || isLaunchTarget(b.target) || !targetInfo(b.target)?.led) continue;
    const key = `${b.target}:${b.input.channel}:${b.input.note}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ state: b.target, out: { type: 'note', channel: b.input.channel, number: b.input.note } });
  }
  return out;
}

const addressOf = (l: LedBinding) => `${l.out.type}:${l.out.channel}:${l.out.number}`;

/** Lights a controller's LEDs to follow the decks, sending only what changed. */
export class LedFeedback {
  private leds: LedBinding[] = [];
  private readonly last = new Map<string, number>();

  constructor(private readonly send: (bytes: number[]) => void) {}

  setMapping(mapping: ControllerMapping): void {
    this.leds = ledBindings(mapping);
    this.last.clear();
  }

  /** Forget what was sent: the next `update` sends every LED (a controller connected). */
  reset(): void {
    this.last.clear();
  }

  /** Sends the LEDs whose value changed since the last update; returns how many messages went out. */
  update(state: DecksState): number {
    if (!this.leds.length) return 0;
    const states = ledStates(state);
    let sent = 0;
    for (const led of this.leds) {
      const on = states.get(led.state) === true;
      const value = on ? (led.out.on ?? 127) : (led.out.off ?? 0);
      const key = addressOf(led);
      if (this.last.get(key) === value) continue;
      this.last.set(key, value);
      this.send(led.out.type === 'note' ? noteOnBytes(led.out.channel, led.out.number, value) : ccBytes(led.out.channel, led.out.number, value));
      sent++;
    }
    return sent;
  }

  /** Turns every LED off (the controller is being let go). */
  clear(): void {
    for (const led of this.leds) {
      const value = led.out.off ?? 0;
      this.send(led.out.type === 'note' ? noteOnBytes(led.out.channel, led.out.number, value) : ccBytes(led.out.channel, led.out.number, value));
    }
    this.last.clear();
  }
}
