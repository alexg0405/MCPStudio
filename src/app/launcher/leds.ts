/**
 * Pad lights for the clip launcher: each pad a controller has linked to a slot (or scene button) shows the slot's
 * state in the colour its mapping's palette gives it (empty, loaded, queued, playing). Pads are lit at the note
 * they send (a CC for a CC control) unless the mapping lists its own lights. Only changes are sent; everything is
 * sent again when a controller connects.
 */
import { ccBytes, noteOnBytes } from '@core/midi-map/message';
import { isLaunchTarget, parseLaunchTarget, type LaunchTarget } from '@core/midi-map/targets';
import { DEFAULT_PAD_PALETTE, type ControllerMapping, type OutputSpec, type PadPalette } from '@core/midi-map/types';
import type { PadState } from './session';

/** What the lights read: the state of a pad, a scene button (0-based positions on the page the pads are on). */
export interface PadSource {
  padState(track: number, scene: number): PadState;
  sceneState(scene: number): PadState;
}

interface Led {
  target: LaunchTarget;
  out: OutputSpec;
}

const addressOf = (o: OutputSpec) => `${o.type}:${o.channel}:${o.number}`;

/** The lights of a mapping: the explicit ones for launcher targets, plus one at each linked pad's own address. */
export function launcherLeds(mapping: ControllerMapping): Led[] {
  const out: Led[] = [];
  const explicit = new Set<string>();
  for (const l of mapping.leds) {
    const target = isLaunchTarget(l.state) ? parseLaunchTarget(l.state) : null;
    if (!target || (target.kind !== 'slot' && target.kind !== 'scene')) continue;
    explicit.add(l.state);
    out.push({ target, out: l.out });
  }
  if (!mapping.ledFromButtons) return out;
  const seen = new Set<string>();
  for (const b of mapping.bindings) {
    const target = parseLaunchTarget(b.target);
    if (!target || (target.kind !== 'slot' && target.kind !== 'scene') || explicit.has(b.target)) continue;
    const spec: OutputSpec | null =
      b.input.type === 'note' ? { type: 'note', channel: b.input.channel, number: b.input.note } : b.input.type === 'cc' ? { type: 'cc', channel: b.input.channel, number: b.input.cc } : null;
    if (!spec || seen.has(`${b.target}:${addressOf(spec)}`)) continue;
    seen.add(`${b.target}:${addressOf(spec)}`);
    out.push({ target, out: spec });
  }
  return out;
}

export class LauncherLeds {
  private leds: Led[] = [];
  private palette: PadPalette = DEFAULT_PAD_PALETTE;
  private readonly last = new Map<string, number>();

  constructor(private readonly send: (bytes: number[]) => void) {}

  setMapping(mapping: ControllerMapping): void {
    this.leds = launcherLeds(mapping);
    this.palette = mapping.pads ?? DEFAULT_PAD_PALETTE;
    this.last.clear();
  }

  /** There is at least one light to drive (the manager polls only then). */
  get active(): boolean {
    return this.leds.length > 0;
  }

  reset(): void {
    this.last.clear();
  }

  private bytes(o: OutputSpec, value: number): number[] {
    return o.type === 'note' ? noteOnBytes(o.channel, o.number, value) : ccBytes(o.channel, o.number, value);
  }

  /** Sends the lights whose value changed; returns how many messages went out. */
  update(src: PadSource): number {
    let sent = 0;
    for (const { target, out } of this.leds) {
      const state = target.kind === 'slot' ? src.padState(target.track - 1, target.scene - 1) : target.kind === 'scene' ? src.sceneState(target.scene - 1) : 'empty';
      const value = this.palette[state];
      const key = addressOf(out);
      if (this.last.get(key) === value) continue;
      this.last.set(key, value);
      this.send(this.bytes(out, value));
      sent++;
    }
    return sent;
  }

  /** Every light off (the controller is let go). */
  clear(): void {
    for (const { out } of this.leds) this.send(this.bytes(out, this.palette.empty));
    this.last.clear();
  }
}
