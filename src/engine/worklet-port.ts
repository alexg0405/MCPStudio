import { SleepSignal, type NoteOff, type NoteOn, type WorkletPort } from '@agstudio/sdk';
import {
  EV_ALL_OFF,
  EV_ALL_OFF_HARD,
  EV_CC,
  EV_NOTE_OFF,
  EV_NOTE_ON,
  EV_PARAM,
  EV_TRANSPORT,
  type FromProcessor,
  type ToProcessor,
} from '@agstudio/sdk/protocol';

/** The most transport anchors held for a sleeping kernel (older ones no longer matter once the newest are replayed). */
const MAX_HELD_ANCHORS = 8;

/** What a sleeping kernel gets of an event the host has for it: it wakes, the news waits, nothing is lost by dropping it, or it is sent as usual. */
type SleepingFate = 'wake' | 'hold' | 'drop' | 'send';

/** One transport anchor held back from a sleeping kernel: the arguments of its packed event. */
interface HeldAnchor {
  frame: number;
  beat: number;
  playing: number;
  bpm: number;
  replan: number;
}

/**
 * Main-thread side of a worklet plugin. Note events from one pump are batched into a single
 * transferred Float64Array message; frames are absolute context frames.
 *
 * It also keeps the host's picture of whether the kernel sleeps (`sleep`, see the SDK's `Sleeper`). The processor says
 * when it falls asleep; from then on only an event that can start sound sends the kernel anything, and the news that
 * can wait (param changes, the song's transport anchors) is held back and replayed in front of that event. The engine
 * takes a sleeping plugin out of the audio graph and puts it back when `sleep` says it is awake again, which is the
 * moment such an event is handed to this port: scheduled notes are handed over a lookahead early.
 */
export class WorkletPortImpl implements WorkletPort {
  readonly sleep = new SleepSignal();
  /** Messages posted that the processor counts (every kind but `sync` and `dispose`): see FromProcessor `sleep`. */
  private sent = 0;
  private readonly heldParams = new Map<number, { frame: number; value: number }>();
  private heldAnchors: HeldAnchor[] = [];
  private pending: number[] = [];
  private flushQueued = false;
  private syncSeq = 0;
  private readonly syncs = new Map<number, () => void>();
  private readonly listeners = new Set<(msg: unknown) => void>();
  private disposed = false;
  /**
   * Seconds this plugin sits behind the song's clock (the mixer's delay compensation: see `AutomatableParam.shift`).
   * The song's transport anchors are sent that much later, so a tempo-synced plugin follows what it renders.
   */
  shift = 0;

  constructor(
    readonly node: AudioWorkletNode,
    private readonly sampleRate: number,
    private readonly onFault: (error: unknown) => void,
    private readonly onDispose: (port: WorkletPortImpl) => void,
    /** Instruments drop a note off or an all-notes-off while asleep (nothing is sounding); effects may be following notes, so they wake. */
    private readonly isInstrument = false,
  ) {
    node.port.onmessage = (e: MessageEvent<FromProcessor>) => this.receive(e.data);
    // First in line, so the news held back is queued before anyone who hears that the kernel woke sends it something.
    this.sleep.onChange((asleep) => {
      if (!asleep) this.releaseHeld();
    });
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

  /** A param that isn't an AudioParam changes at `time` (see EV_PARAM): its event index and encoded value. */
  param(index: number, value: number, time: number): void {
    this.push(EV_PARAM, time, 0, index, value, 0, 0);
  }

  /** The song's transport from `time` on (see EV_TRANSPORT; engine/kernel-transport.ts sends these). */
  transport(time: number, beat: number, playing: boolean, bpm: number, replan: boolean): void {
    this.push(EV_TRANSPORT, time + this.shift, beat, playing ? 1 : 0, bpm, replan ? 1 : 0, 0);
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
    const frame = Math.round(time * this.sampleRate);
    if (this.sleep.asleep) {
      const fate = this.fateWhileAsleep(type);
      if (fate === 'drop') return;
      if (fate === 'hold') {
        this.hold(type, frame, id, key, vel, pan);
        return;
      }
      if (fate === 'wake') this.wakeUp();
    }
    this.pending.push(type, frame, id, key, vel, pan, fine);
    if (!this.flushQueued) {
      this.flushQueued = true;
      queueMicrotask(() => this.flush());
    }
  }

  /**
   * What a sleeping kernel gets of an event of this type. An instrument wakes when the host sends it a note, and the
   * news that can wait (params, the song's anchors) goes in front of that note. An effect wakes when sound reaches it,
   * which the host does not see, so it must always be up to date: its param changes and anchors are sent as usual (the
   * processor applies them while asleep without waking).
   */
  private fateWhileAsleep(type: number): SleepingFate {
    if (type === EV_PARAM || type === EV_TRANSPORT) return this.isInstrument ? 'hold' : 'send';
    const isRelease = type === EV_NOTE_OFF || type === EV_ALL_OFF || type === EV_ALL_OFF_HARD;
    return isRelease && this.isInstrument ? 'drop' : 'wake';
  }

  private hold(type: number, frame: number, id: number, key: number, vel: number, pan: number): void {
    if (type === EV_PARAM) {
      this.heldParams.set(key, { frame, value: vel });
      return;
    }
    // A re-planned anchor makes the held ones from its frame on stale, as it does in the processor's queue.
    if (pan === 1) this.heldAnchors = this.heldAnchors.filter((a) => a.frame < frame);
    this.heldAnchors.push({ frame, beat: id, playing: key, bpm: vel, replan: pan });
    if (this.heldAnchors.length > MAX_HELD_ANCHORS) this.heldAnchors.shift();
  }

  /** The host is about to send the kernel something that can start sound: awake first, and what was held back goes in front of it. */
  private wakeUp(): void {
    this.sleep.set(false);
  }

  /** The kernel is awake again (by the host's doing or its own): it gets the param changes and anchors held back, in order. */
  private releaseHeld(): void {
    for (const [index, held] of this.heldParams) this.pending.push(EV_PARAM, held.frame, 0, index, held.value, 0, 0);
    this.heldParams.clear();
    for (const a of this.heldAnchors) this.pending.push(EV_TRANSPORT, a.frame, a.beat, a.playing, a.bpm, a.replan, 0);
    this.heldAnchors = [];
    if (this.pending.length > 0 && !this.flushQueued) {
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
    this.sent++;
    this.node.port.postMessage({ t: 'ev', data } satisfies ToProcessor, [data.buffer]);
  }

  private post(msg: ToProcessor, transfer: Transferable[] = []): void {
    if (this.disposed) return;
    const isBarrier = msg.t === 'sync' || msg.t === 'dispose';
    // State, samples, messages and resets may start sound in a kernel of their own: it wakes for them.
    if (!isBarrier && this.sleep.asleep) this.wakeUp();
    this.flush();
    if (!isBarrier) this.sent++;
    this.node.port.postMessage(msg, transfer);
  }

  private receive(msg: FromProcessor): void {
    switch (msg.t) {
      case 'sync':
        this.syncs.get(msg.id)?.();
        this.syncs.delete(msg.id);
        break;
      case 'sleep':
        // Only a sleep the host knows everything about: no message in flight, none waiting to be sent.
        if (msg.received === this.sent && this.pending.length === 0) this.sleep.set(true);
        break;
      case 'wake':
        this.sleep.set(false);
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
