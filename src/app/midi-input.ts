import type { ChannelId } from '@core/model/types';
import type { EngineApi } from '@engine/api';

/**
 * Web MIDI note input: connected keyboards play the selected channel (live preview; recording into
 * patterns comes after v1). Sustain pedal (CC64) holds notes.
 */
export class MidiInput {
  private access: MIDIAccess | null = null;
  private readonly held = new Map<string, { channelId: ChannelId; noteId: number }>();
  private readonly sustained = new Set<string>();
  private sustain = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly engine: () => EngineApi,
    private readonly target: () => ChannelId | null,
  ) {}

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
    for (const key of [...this.held.keys()]) this.release(key);
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
        if (e.data) this.handle(input.id, e.data);
      };
    }
  }

  private handle(inputId: string, data: Uint8Array): void {
    const status = (data[0] ?? 0) & 0xf0;
    const d1 = data[1] ?? 0;
    const d2 = data[2] ?? 0;
    const key = `${inputId}:${d1}`;
    if (status === 0x90 && d2 > 0) {
      const channelId = this.target();
      if (!channelId) return;
      if (this.held.has(key)) this.release(key);
      this.sustained.delete(key);
      const noteId = this.engine().previewNoteOn(channelId, d1, d2 / 127);
      this.held.set(key, { channelId, noteId });
    } else if (status === 0x80 || (status === 0x90 && d2 === 0)) {
      if (this.sustain) this.sustained.add(key);
      else this.release(key);
    } else if (status === 0xb0 && d1 === 64) {
      this.sustain = d2 >= 64;
      if (!this.sustain) {
        for (const k of this.sustained) this.release(k);
        this.sustained.clear();
      }
    }
  }

  private release(key: string): void {
    const h = this.held.get(key);
    if (!h) return;
    this.held.delete(key);
    this.engine().previewNoteOff(h.channelId, h.noteId);
  }
}
