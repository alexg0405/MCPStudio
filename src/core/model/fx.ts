/**
 * Transition sounds the arranger places (risers, downlifters, reverse crashes, whooshes, impacts,
 * sub drops): built-in samples the engine generates (`engine/kit/fx.ts`), named after their length
 * in beats at a tempo, `fx/riser/16b@150`, so a riser ends exactly on the downbeat it leads to. They
 * play on audio clip channels that follow the tempo (`stretch: 'resample'` at that `sourceBpm`).
 * Older versions load unknown built-in names as silence, so projects with these still open.
 */
import { newId } from './ids';
import type { SampleRef } from './types';

/** The kinds of transition sound the arranger can place. */
export const FX_KINDS = ['riser', 'downlifter', 'reverse-crash', 'whoosh', 'impact', 'sub-drop'] as const;
/** One of `FX_KINDS`. */
export type FxKind = (typeof FX_KINDS)[number];

/** Bump (and keep the old generator) if a published sound ever changes. */
export const FX_VERSION = 1;

/** The name of each transition sound kind as the UI shows it. */
export const FX_LABELS: Record<FxKind, string> = {
  riser: 'Riser',
  downlifter: 'Downlifter',
  'reverse-crash': 'Reverse crash',
  whoosh: 'Whoosh',
  impact: 'Impact',
  'sub-drop': 'Sub drop',
};

/** Hits that ring for a set time rather than a number of bars (seconds). */
export const FX_SECONDS: Partial<Record<FxKind, number>> = { impact: 3.5, 'sub-drop': 2.5 };

/** The parts of a transition sample's name: its kind, its length in beats and the tempo it was built at. */
export interface FxName {
  kind: FxKind;
  /** Length in beats (quarter notes). */
  beats: number;
  bpm: number;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** `fx/<kind>/<beats>b@<bpm>`. */
export function fxName(kind: FxKind, beats: number, bpm: number): string {
  return `fx/${kind}/${r3(beats)}b@${r3(bpm)}`;
}

/** The parts of an FX sample name, or null for anything else. */
export function parseFxName(name: string): FxName | null {
  const m = /^fx\/([a-z-]+)\/(\d+(?:\.\d+)?)b@(\d+(?:\.\d+)?)$/.exec(name);
  if (!m) return null;
  const kind = m[1] as FxKind;
  const beats = Number(m[2]);
  const bpm = Number(m[3]);
  if (!FX_KINDS.includes(kind) || !(beats >= 0.25 && beats <= 256) || !(bpm >= 20 && bpm <= 999)) return null;
  return { kind, beats, bpm };
}

/** How long the sample lasts, in seconds. */
export const fxSeconds = (f: FxName): number => (f.beats * 60) / f.bpm;

/** Beats an FX lasts at a tempo: its own length for hits (impact 3.5 s), else the given beats. */
export function fxBeats(kind: FxKind, bpm: number, beats?: number): number {
  const secs = FX_SECONDS[kind];
  if (secs !== undefined && beats === undefined) return Math.max(1, Math.round((secs * bpm) / 60));
  return Math.max(0.25, beats ?? 4);
}

/** "Riser · 4 bars", "Impact", "Reverse crash · 2 beats". */
export function fxLabel(kind: FxKind, beats: number, beatsPerBar = 4): string {
  if (FX_SECONDS[kind] !== undefined) return FX_LABELS[kind];
  const bars = beats / beatsPerBar;
  const len = Number.isInteger(bars) ? `${bars} bar${bars === 1 ? '' : 's'}` : `${r3(beats)} beat${beats === 1 ? '' : 's'}`;
  return `${FX_LABELS[kind]} · ${len}`;
}

/** A sample entry for an FX sound (not yet in the project). */
export function fxSampleRef(kind: FxKind, beats: number, bpm: number): SampleRef {
  const f = { kind, beats, bpm };
  return {
    id: newId.sample(),
    name: fxLabel(kind, beats),
    source: { kind: 'builtin', generator: fxName(kind, beats, bpm), version: FX_VERSION },
    durationSec: fxSeconds(f),
  };
}
