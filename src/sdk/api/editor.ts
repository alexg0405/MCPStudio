/** What a plugin's custom editor (`ui`) is given, and the pieces of the generated editor. */
import type { ParamSpecs, ParamValue, ValueOf } from '../params';
import type { AudioTap } from './host';

/** A React function component (kept structural so the core SDK has no React dependency). */
export type PluginUIComponent<Props> = (props: Props) => unknown;

/** The props of a plugin's custom editor: its param values, ways to edit them as undoable steps, and optional samples and tap. */
export interface PluginUIProps<P extends ParamSpecs = ParamSpecs, S = unknown> {
  specs: P;
  values: { readonly [K in keyof P]: ValueOf<P[K]> };
  state: S;
  /** Start of a continuous edit (knob drag); everything until endEdit() is one undo step. */
  beginEdit(param: keyof P & string): void;
  setParam(param: keyof P & string, value: ParamValue): void;
  endEdit(param: keyof P & string): void;
  setState(next: S): void;
  /**
   * Opens the host's menu for a param (create automation clip, link to controller…). SDK controls
   * given a `param` prop do this on right-click by themselves.
   */
  openParamMenu?(param: keyof P & string, at: { clientX: number; clientY: number }): void;
  /** The plugin's sample slots (plugins that declare `sampleSlots`), for editors that show their own. */
  samples?: PluginUISamples;
  /**
   * Plays a note on the instrument's channel right away (pads that play when clicked, a slice
   * preview); returns the function that releases it. Absent for effects.
   */
  playNote?(key: number, velocity?: number): () => void;
  /**
   * The running instance's audio and readings (see `host.tap()`), the same object for as long as the
   * editor is open: read it from `useFrame` and draw imperatively.
   */
  tap?: AudioTap;
}

/** A sample's peak overview for drawing: min and max per `bucket` frames, interleaved `[min0, max0, …]`. */
export interface SampleOverview {
  readonly peaks: Float32Array;
  readonly bucket: number;
  readonly sampleRate: number;
  readonly duration: number;
}

/**
 * Sample slots as an editor sees them (FPC-style pads, a slicer's waveform). Every change is one
 * undoable edit of the project, and the plugin hears it through `host.samples.onChange`.
 */
export interface PluginUISamples {
  /** Display name of the sample in a slot, or null when the slot is empty. */
  name(slot: string): string | null;
  /** Opens the browser's file chooser; the chosen audio file goes into the slot. */
  choose(slot: string): void;
  /** The built-in kit sounds (`id` for `loadKit`, `name` to show). */
  readonly kit: readonly { readonly id: string; readonly name: string }[];
  /** Puts a built-in kit sound into the slot. */
  loadKit(slot: string, id: string): void;
  /** Empties the slot. */
  clear(slot: string): void;
  /**
   * True when a drag may carry a sample: audio files (desktop or the sample browser) or a kit sound
   * from the browser panel. Call it in `onDragOver` and `preventDefault()` to accept the drop.
   */
  canDrop(data: DataTransfer): boolean;
  /**
   * Loads what a drop carries into the slot. Call it in `onDrop` (it reads the DataTransfer right
   * away); returns false when the drop carries no sample.
   */
  drop(slot: string, data: DataTransfer): boolean;
  /**
   * The slot's sample as a peak overview (256 frames per bucket, at the engine's sample rate), or
   * null when empty or still decoding (the editor re-renders once it is ready).
   */
  waveform(slot: string): SampleOverview | null;
}

/** A live value in the generated editor (see `meters`). */
export interface PluginMeter {
  /** The reading's name, as the kernel publishes it. */
  reading: string;
  label: string;
  /**
   * How to show it: 'reduction' = dB of gain reduction (0 = none) as a bar up to `max` dB (default
   * 12); 'db' = a level in dB; 'hz' = a frequency (0 = none); 'note' = a MIDI note number (below 0 =
   * none); 'cents' = a ± amount in cents.
   */
  kind: 'reduction' | 'db' | 'hz' | 'note' | 'cents';
  max?: number;
  /** What it tells you (hint bar). */
  hint?: string;
}
