import type { LiveInput, LiveOrigin } from './live-input';

/**
 * Web MIDI input: connected keyboards and controllers feed the live input (which plays the
 * selected channel and lets recording and MIDI learn listen). Notes, controllers (the sustain
 * pedal, CC64, holds notes) and pitch bend, with each message's own timestamp.
 */
export class MidiInput {
  private access: MIDIAccess | null = null;
  private readonly held = new Set<string>();
  private readonly sustained = new Map<string, { key: number; origin: LiveOrigin }>();
  private sustain = false;
  private readonly listeners = new Set<() => void>();
  /** Devices another consumer uses (DJ controllers) are not played as keyboards: it says which. */
  ignore: ((device: string) => boolean) | null = null;

  constructor(private readonly live: LiveInput) {}

  get enabled(): boolean {
    return this.access !== null;
  }

  inputNames(): string[] {
    return this.access ? [...this.access.inputs.values()].map((i) => i.name ?? 'MIDI input') : [];
  }

  /** Asks for MIDI access (Chrome shows a permission prompt the first time). */
  async enable(): Promise<void> {
    if (this.access) return;
    if (!('requestMIDIAccess' in navigator)) throw new Error('This browser has no Web MIDI support (use Chrome).');
    this.access = await navigator.requestMIDIAccess();
    this.attach();
    this.access.onstatechange = () => {
      this.attach();
      this.emit();
    };
    this.emit();
  }

  disable(): void {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) input.onmidimessage = null;
    this.access.onstatechange = null;
    this.access = null;
    this.live.releaseAll('midi');
    this.held.clear();
    this.sustained.clear();
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private attach(): void {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) {
      input.onmidimessage = (e: MIDIMessageEvent) => {
        if (e.data) this.handle(input.name ?? input.id, e.data, e.timeStamp);
      };
    }
  }

  /** Parses one MIDI message (exported behaviour is tested through `handle`). */
  handle(device: string, data: Uint8Array, timeStamp?: number): void {
    if (this.ignore?.(device)) return;
    const status = (data[0] ?? 0) & 0xf0;
    const midiChannel = (data[0] ?? 0) & 0x0f;
    const d1 = data[1] ?? 0;
    const d2 = data[2] ?? 0;
    const origin: LiveOrigin = { source: 'midi', device, midiChannel };
    const key = `${device}:${midiChannel}:${d1}`;
    if (status === 0x90 && d2 > 0) {
      this.sustained.delete(key);
      this.held.add(key);
      this.live.noteOn(d1, d2 / 127, origin, timeStamp);
    } else if (status === 0x80 || (status === 0x90 && d2 === 0)) {
      this.held.delete(key);
      if (this.sustain) this.sustained.set(key, { key: d1, origin });
      else this.live.noteOff(d1, status === 0x80 ? d2 / 127 : 0.5, origin, timeStamp);
    } else if (status === 0xb0) {
      if (d1 === 64) {
        this.sustain = d2 >= 64;
        if (!this.sustain) {
          for (const { key: k, origin: o } of this.sustained.values()) this.live.noteOff(k, 0.5, o, timeStamp);
          this.sustained.clear();
        }
      }
      this.live.controlChange(d1, d2 / 127, origin, timeStamp);
    } else if (status === 0xe0) {
      // 14-bit bend, centre 8192.
      this.live.pitchBend((((d2 << 7) | d1) - 8192) / 8192, origin, timeStamp);
    }
  }
}
