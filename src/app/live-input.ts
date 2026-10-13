/**
 * Every live note and controller (MIDI keyboards, the typing keyboard, the on-screen piano) goes
 * through here: it plays the selected channel through the engine and tells listeners (note
 * recording, MIDI learn, the on-screen piano's lit keys) with the AudioContext time it happened at.
 */
import type { ChannelId } from '@core/model/types';
import type { EngineApi } from '@engine/api';

export type LiveSource = 'midi' | 'typing' | 'screen';

/** Where an event came from (for "Link to controller" and per-device filtering). */
export interface LiveOrigin {
  source: LiveSource;
  /** MIDI input name. */
  device?: string;
  /** MIDI channel 0–15. */
  midiChannel?: number;
}

export type LiveEvent =
  | ({
      type: 'noteOn';
      key: number;
      velocity: number;
      time: number;
      channelId: ChannelId | null;
      id: number;
    } & LiveOrigin)
  | ({
      type: 'noteOff';
      key: number;
      release: number;
      time: number;
      channelId: ChannelId | null;
      id: number;
    } & LiveOrigin)
  | ({ type: 'cc'; cc: number; value: number; time: number } & LiveOrigin)
  | ({ type: 'pitchBend'; value: number; time: number } & LiveOrigin);

/** Pitch bend range in semitones (the usual ±2). */
export const BEND_RANGE = 2;

interface Held {
  id: number;
  channelId: ChannelId | null;
  noteId: number | null;
  key: number;
  origin: LiveOrigin;
}

export class LiveInput {
  private readonly listeners = new Set<(e: LiveEvent) => void>();
  private readonly held = new Map<string, Held>();
  private seq = 0;

  constructor(
    private readonly engine: () => EngineApi,
    private readonly target: () => ChannelId | null,
  ) {}

  subscribe(fn: (e: LiveEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Keys sounding right now (for the on-screen piano). */
  heldKeys(): number[] {
    return [...this.held.values()].map((h) => h.key);
  }

  /** `timeStamp`: the event's performance.now() time (MIDI messages carry it), default now. */
  noteOn(key: number, velocity: number, origin: LiveOrigin, timeStamp?: number): void {
    const k = this.heldKey(key, origin);
    if (this.held.has(k)) this.noteOff(key, 0.5, origin, timeStamp);
    const channelId = this.target();
    const v = Math.max(0.01, Math.min(1, velocity));
    const noteId = channelId ? this.engine().previewNoteOn(channelId, key, v) : null;
    const id = ++this.seq;
    this.held.set(k, { id, channelId, noteId, key, origin });
    this.emit({ type: 'noteOn', key, velocity: v, time: this.timeOf(timeStamp), channelId, id, ...origin });
  }

  noteOff(key: number, release: number, origin: LiveOrigin, timeStamp?: number): void {
    const k = this.heldKey(key, origin);
    const h = this.held.get(k);
    if (!h) return;
    this.held.delete(k);
    if (h.channelId && h.noteId !== null) this.engine().previewNoteOff(h.channelId, h.noteId);
    this.emit({
      type: 'noteOff',
      key,
      release,
      time: this.timeOf(timeStamp),
      channelId: h.channelId,
      id: h.id,
      ...origin,
    });
  }

  /** A controller (0–1). Mod wheel and friends reach the selected channel's instrument. */
  controlChange(cc: number, value: number, origin: LiveOrigin, timeStamp?: number): void {
    const channelId = this.target();
    if (channelId) this.engine().previewControl(channelId, cc, value);
    this.emit({ type: 'cc', cc, value, time: this.timeOf(timeStamp), ...origin });
  }

  /** Pitch bend −1…1 (bends the selected channel by ±BEND_RANGE semitones). */
  pitchBend(value: number, origin: LiveOrigin, timeStamp?: number): void {
    const channelId = this.target();
    const v = Math.max(-1, Math.min(1, value));
    if (channelId) this.engine().previewPitchBend(channelId, v * BEND_RANGE * 100);
    this.emit({ type: 'pitchBend', value: v, time: this.timeOf(timeStamp), ...origin });
  }

  /** Releases every held note (focus lost, device unplugged…). */
  releaseAll(source?: LiveSource): void {
    for (const h of [...this.held.values()])
      if (!source || h.origin.source === source) this.noteOff(h.key, 0.5, h.origin);
  }

  private heldKey(key: number, o: LiveOrigin): string {
    return `${o.source}:${o.device ?? ''}:${o.midiChannel ?? ''}:${key}`;
  }

  private timeOf(timeStamp?: number): number {
    const perf = typeof performance !== 'undefined' ? performance.now() : 0;
    return this.engine().contextTimeAt(timeStamp ?? perf);
  }

  private emit(e: LiveEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        console.error('[agstudio] live input listener failed', err);
      }
    }
  }
}
