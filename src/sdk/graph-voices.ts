/**
 * Voice bookkeeping for main-thread ("graph") instruments built from native Web Audio nodes.
 * Handles polyphony limits, voice stealing without clicks, cancelling notes that have not
 * started yet, and cleanup.
 */

export interface GraphVoice {
  /** Scheduled start time (AudioContext seconds). */
  start: number;
  /** Source nodes to stop (oscillators, buffer sources). */
  sources: AudioScheduledSourceNode[];
  /** The voice's last node. GraphVoices connects it to the destination through a click-free kill gain. */
  out: AudioNode;
  /** Other nodes to disconnect on cleanup. */
  nodes?: AudioNode[];
  /** Extra cleanup (e.g. ParamSignal disconnect functions). */
  cleanup?: Array<() => void>;
  /**
   * Starts the release at time `t` and returns when the voice is silent. Return null to ignore
   * note-offs (one-shot samples play to their natural end).
   */
  release?(t: number): number | null;
  /** Natural end time if known (e.g. a one-shot sample's end). */
  end?: number;
}

/**
 * One signal that is the sum of several (e.g. a transpose knob plus the channel pitch), for nodes
 * that should follow all of them.
 */
export function sumSignals(
  ac: BaseAudioContext,
  ...signals: { readonly node: AudioNode }[]
): {
  readonly node: AudioNode;
  connect(target: AudioParam): () => void;
} {
  const node = new GainNode(ac);
  for (const s of signals) s.node.connect(node);
  return {
    node,
    connect(target: AudioParam) {
      node.connect(target);
      return () => {
        try {
          node.disconnect(target);
        } catch {
          /* already disconnected */
        }
      };
    },
  };
}

interface Live extends GraphVoice {
  noteId: number;
  kill: GainNode;
  /** When the voice is (or will be) silent; Infinity while held. */
  until: number;
  released: boolean;
  disposed: boolean;
}

const FADE = 0.005;

export class GraphVoices {
  private readonly voices = new Map<number, Live>();
  private readonly max: number;

  constructor(
    private readonly ac: BaseAudioContext,
    private readonly destination: AudioNode,
    opts: { max?: number } = {},
  ) {
    this.max = opts.max ?? 16;
  }

  get size(): number {
    return this.voices.size;
  }

  /** Registers a voice that has already been scheduled. */
  add(noteId: number, voice: GraphVoice): void {
    this.gc(this.ac.currentTime);
    const kill = new GainNode(this.ac, { gain: 1 });
    voice.out.connect(kill).connect(this.destination);
    const live: Live = {
      ...voice,
      noteId,
      kill,
      until: voice.end ?? Infinity,
      released: false,
      disposed: false,
    };
    const prev = this.voices.get(noteId);
    if (prev) this.kill(prev, voice.start);
    this.voices.set(noteId, live);
    this.enforceMax(voice.start);
  }

  /** Note-off. A release time at or before the voice's start cancels it. */
  release(noteId: number, time: number): void {
    const v = this.voices.get(noteId);
    if (!v || v.released) return;
    if (time <= v.start) {
      this.dispose(v, true);
      return;
    }
    v.released = true;
    const until = v.release ? v.release(time) : time;
    if (until !== null) {
      v.until = Math.min(v.until, until);
      if (!v.release) this.kill(v, time);
    }
  }

  /** Releases (or with `hard`, quickly fades) every voice sounding at `time` and cancels later ones. */
  releaseAll(time: number, hard = false): void {
    for (const v of [...this.voices.values()]) {
      if (v.start >= time) this.dispose(v, true);
      else if (hard) this.kill(v, time);
      else this.release(v.noteId, time);
    }
  }

  /** Cuts every voice except `keep` with a short fade (monophonic "cut itself" behaviour). */
  cutOthers(time: number, keep?: number): void {
    for (const v of this.voices.values()) if (v.noteId !== keep && v.start < time) this.kill(v, time);
  }

  /** Disposes voices that finished before `now`. Called automatically on add(); call it from long-idle plugins too. */
  gc(now: number): void {
    for (const v of [...this.voices.values()]) if (v.until + 0.05 < now) this.dispose(v, false);
  }

  disposeAll(): void {
    for (const v of [...this.voices.values()]) this.dispose(v, true);
  }

  /**
   * Keeps at most `max` voices sounding at `time`. Counts only voices alive then (not ones that
   * already ended or are scheduled later), so pre-scheduling a whole song for export works too.
   * Steals released voices first, then the oldest.
   */
  private enforceMax(time: number): void {
    const alive: Live[] = [];
    for (const v of this.voices.values()) if (v.start <= time + 1e-6 && v.until > time) alive.push(v);
    if (alive.length <= this.max) return;
    alive.sort((a, b) => Number(b.released) - Number(a.released) || a.start - b.start);
    for (let i = 0; i < alive.length - this.max; i++) this.kill(alive[i] as Live, time);
  }

  /** Fades a voice out over 5 ms at `time` and stops its sources. */
  private kill(v: Live, time: number): void {
    const t = Math.max(time, this.ac.currentTime);
    v.kill.gain.cancelScheduledValues(t);
    v.kill.gain.setValueAtTime(1, t);
    v.kill.gain.linearRampToValueAtTime(0, t + FADE);
    for (const s of v.sources) {
      try {
        s.stop(t + FADE + 0.001);
      } catch {
        /* already stopped */
      }
    }
    v.released = true;
    v.until = Math.min(v.until, t + FADE);
  }

  private dispose(v: Live, stopNow: boolean): void {
    if (v.disposed) return;
    v.disposed = true;
    this.voices.delete(v.noteId);
    if (stopNow) {
      for (const s of v.sources) {
        try {
          s.stop();
        } catch {
          /* not started or already stopped */
        }
      }
    }
    for (const fn of v.cleanup ?? []) fn();
    for (const n of v.nodes ?? []) n.disconnect();
    for (const s of v.sources) s.disconnect();
    v.out.disconnect();
    v.kill.disconnect();
  }
}
