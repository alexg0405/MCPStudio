import type { NoteOff, NoteOn, WorkletPort } from '@agstudio/sdk';
import {
  EV_ALL_OFF,
  EV_ALL_OFF_HARD,
  EV_CC,
  EV_NOTE_OFF,
  EV_NOTE_ON,
  EV_TRANSPORT,
  type FromProcessor,
  type ToProcessor,
} from '@agstudio/sdk/protocol';

/**
 * Main-thread side of a worklet plugin. Note events from one pump are batched into a single
 * transferred Float64Array message; frames are absolute context frames.
 */
export class WorkletPortImpl implements WorkletPort {
  private pending: number[] = [];
  private flushQueued = false;
  private syncSeq = 0;
  private readonly syncs = new Map<number, () => void>();
  private readonly listeners = new Set<(msg: unknown) => void>();
  private disposed = false;

  constructor(
    readonly node: AudioWorkletNode,
    private readonly sampleRate: number,
    private readonly onFault: (error: unknown) => void,
    private readonly onDispose: (port: WorkletPortImpl) => void,
  ) {
    node.port.onmessage = (e: MessageEvent<FromProcessor>) => this.receive(e.data);
    node.onprocessorerror = (e) => this.onFault(e instanceof ErrorEvent ? (e.error ?? e.message) : 'processor error');
  }

  noteOn(e: NoteOn): void {
    this.push(EV_NOTE_ON, e.time, e.noteId, e.key, e.velocity, e.pan ?? 0, e.fine ?? 0);
  }

  noteOff(e: NoteOff): void {
    this.push(EV_NOTE_OFF, e.time, e.noteId, e.key, e.release ?? 0.5, 0, 0);
  }

  allNotesOff(time: number, hard = false): void {
    this.push(hard ? EV_ALL_OFF_HARD : EV_ALL_OFF, time, 0, 0, 0, 0, 0);
  }

  controlChange(cc: number, value: number, time: number): void {
    this.push(EV_CC, time, 0, cc, value, 0, 0);
  }

  /** The song's transport from `time` on (see EV_TRANSPORT; engine/kernel-transport.ts sends these). */
  transport(time: number, beat: number, playing: boolean, bpm: number, replan: boolean): void {
    this.push(EV_TRANSPORT, time, beat, playing ? 1 : 0, bpm, replan ? 1 : 0, 0);
  }

  setState(state: unknown): void {
    this.post({ t: 'state', state });
  }

  sendSample(slot: string, buffer: AudioBuffer | null): void {
    if (!buffer) {
      this.post({ t: 'sample', slot, channels: null, sampleRate: this.sampleRate });
      return;
    }
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice());
    this.post(
      { t: 'sample', slot, channels, sampleRate: buffer.sampleRate },
      channels.map((c) => c.buffer),
    );
  }

  send(msg: unknown, transfer: Transferable[] = []): void {
    this.post({ t: 'user', msg }, transfer);
  }

  reset(): void {
    this.post({ t: 'reset' });
  }

  onMessage(cb: (msg: unknown) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  sync(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const id = ++this.syncSeq;
    return new Promise((resolve) => {
      this.syncs.set(id, resolve);
      this.post({ t: 'sync', id });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.post({ t: 'dispose' });
    this.disposed = true;
    for (const resolve of this.syncs.values()) resolve();
    this.syncs.clear();
    this.listeners.clear();
    this.node.disconnect();
    this.onDispose(this);
  }

  private push(type: number, time: number, id: number, key: number, vel: number, pan: number, fine: number): void {
    if (this.disposed) return;
    this.pending.push(type, Math.round(time * this.sampleRate), id, key, vel, pan, fine);
    if (!this.flushQueued) {
      this.flushQueued = true;
      queueMicrotask(() => this.flush());
    }
  }

  /** Sends batched note events now (messages must stay in order with other posts). */
  flush(): void {
    this.flushQueued = false;
    if (this.pending.length === 0 || this.disposed) return;
    const data = new Float64Array(this.pending);
    this.pending = [];
    this.node.port.postMessage({ t: 'ev', data } satisfies ToProcessor, [data.buffer]);
  }

  private post(msg: ToProcessor, transfer: Transferable[] = []): void {
    if (this.disposed) return;
    this.flush();
    this.node.port.postMessage(msg, transfer);
  }

  private receive(msg: FromProcessor): void {
    switch (msg.t) {
      case 'sync':
        this.syncs.get(msg.id)?.();
        this.syncs.delete(msg.id);
        break;
      case 'fault':
        this.onFault(msg.error);
        break;
      case 'nan':
        console.warn('[agstudio] a plugin produced NaN/Infinity; the block was silenced');
        break;
      case 'user':
        for (const cb of this.listeners) cb(msg.msg);
        break;
      case 'ready':
        break;
    }
  }
}
