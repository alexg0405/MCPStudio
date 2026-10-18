import type { ParamSpecs, ValueOf } from '../params';

// ---------------------------------------------------------------------------------------------
// Note scripts: piano-roll tools (quantize, strum, arpeggiate, …) written as plugins.

/** A note as a script sees it (ticks at PPQ 960, pattern-relative). */
export interface ScriptNote {
  /** Present on notes that already exist; keep it to edit that note, drop it to add a new one. */
  readonly id?: string;
  tick: number;
  /** ≥ 1 tick. */
  length: number;
  /** MIDI key 0–127. */
  key: number;
  /** 0–1. */
  velocity: number;
  pan?: number;
  release?: number;
  fine?: number;
  muted?: boolean;
}

/** Everything a note script gets to work with: the notes, its parameter values and the pattern's timing. */
export interface NoteScriptContext<P extends ParamSpecs = ParamSpecs> {
  /** The notes to work on: the selection, or every note of the channel's pattern when none is selected. */
  readonly notes: readonly ScriptNote[];
  /** The script's parameter values from its dialog. */
  readonly values: { readonly [K in keyof P]: ValueOf<P[K]> };
  /** Ticks per quarter note (960). */
  readonly ppq: number;
  /** The piano roll's snap in ticks. */
  readonly grid: number;
  /** The song's tempo in beats per minute (to turn milliseconds into ticks: `ms / 1000 * bpm / 60 * ppq`). */
  readonly bpm: number;
  /** Ticks per bar. */
  readonly bar: number;
  /** Length of the pattern in ticks. */
  readonly length: number;
  /** The song's key, when one is set (root 0 = C; scale ids from '@agstudio/sdk/notes'). */
  readonly key: { readonly root: number; readonly scale: string } | null;
  /** Deterministic random number in [0, 1) (same inputs, same result). */
  rand(): number;
}

/** A piano-roll tool written as a plugin. Make one with `defineNoteScript`. */
export interface NoteScriptDef<P extends ParamSpecs = ParamSpecs> {
  kind: 'note-script';
  id: string;
  name: string;
  version: number;
  /** Groups scripts in the Tools menu. */
  category?: string;
  description?: string;
  params: P;
  /**
   * Returns the notes that replace `ctx.notes`: notes keeping an `id` are edited in place, notes
   * without one are added, input notes that are missing are deleted. Must not mutate its input.
   */
  run(ctx: NoteScriptContext<P>): readonly ScriptNote[];
}

/** A note script definition of any params, as the host stores them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyNoteScriptDef = NoteScriptDef<any>;

/** Declares a note script (adds `kind: 'note-script'`; the type parameter infers the param ids and value types). */
export function defineNoteScript<const P extends ParamSpecs>(def: Omit<NoteScriptDef<P>, 'kind'>): NoteScriptDef<P> {
  return { kind: 'note-script', ...def };
}
