/** The running side of a plugin: what `create(host)` returns. */
import type { NoteOff, NoteOn } from './notes';

/** What an instrument's `create()` returns: its output node and how it plays notes. */
export interface InstrumentInstance<S = unknown> {
  readonly output: AudioNode;
  noteOn(e: NoteOn): void;
  noteOff(e: NoteOff): void;
  /** Releases everything sounding at `time` and drops anything scheduled at or after it. */
  allNotesOff(time: number, hard?: boolean): void;
  /** A MIDI control change (mod wheel = 1, …), value 0–1. Pitch bend arrives as `host.channel.pitch`. */
  controlChange?(cc: number, value: number, time: number): void;
  setState?(state: S): void;
  dispose(): void;
  /** Seconds of release tail after the last note (export padding). */
  readonly tailTime?: number;
}

/** What an effect's `create()` returns: the nodes audio goes through, and its latency and tail. */
export interface EffectInstance<S = unknown> {
  readonly input: AudioNode;
  readonly output: AudioNode;
  setState?(state: S): void;
  /** Clears internal buffers (delay lines, reverb tails). */
  reset?(): void;
  dispose(): void;
  readonly latency?: number;
  readonly tailTime?: number;
}
