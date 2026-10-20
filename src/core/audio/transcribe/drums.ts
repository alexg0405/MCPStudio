/**
 * Drums: the kick, snare, clap, hats, toms and cymbals of a loop or a beat, each with when it was hit and how hard, and a
 * clean example of every kind (to cut into Drum Pads so the notes sound like the recording). The finding is in
 * `drum-bands.ts` (four views of the sound) and `drum-rules.ts` (what each start is); this file puts the two together.
 * Pure and deterministic.
 */
import { bandViews, envelopeOf, HOLD_SEC, type BandViews, type Envelope } from './drum-bands';
import { hitsFromViews } from './drum-rules';
import { readViews } from './drum-views';
import { cutsFor } from './drum-cuts';
import type { DrumKind, HeardHit, KitCut } from './types';

/** Settings of the drum listener. */
export interface DrumOptions {
  /** 0..1: how much is picked up (default 0.5). */
  sensitivity?: number;
}

/** What listening to a drum recording found. */
export interface HeardDrums {
  hits: HeardHit[];
  cuts: KitCut[];
}

/** The strength of the loudest hits of a kind is 1; this share of the way up the sorted levels is "the loudest". */
const TOP_SHARE = 0.95;
/** The strength of the quietest hit that is kept (a ghost note). */
const MIN_STRENGTH = 0.15;

/** The dB level of a hit as a strength 0..1 against the loudest hits of its kind (levels are amplitudes in dB). */
function withStrengths(hits: readonly HeardHit[]): HeardHit[] {
  const byKind = new Map<DrumKind, number[]>();
  for (const h of hits) byKind.set(h.kind, [...(byKind.get(h.kind) ?? []), h.strength]);
  const tops = new Map<DrumKind, number>();
  for (const [kind, levels] of byKind) {
    const sorted = [...levels].sort((a, b) => a - b);
    tops.set(kind, sorted[Math.min(sorted.length - 1, Math.round(TOP_SHARE * (sorted.length - 1)))] as number);
  }
  return hits.map((h) => {
    const top = tops.get(h.kind) as number;
    const strength = Math.max(MIN_STRENGTH, Math.min(1, Math.pow(10, (h.strength - top) / 20)));
    return { ...h, strength: Math.round(strength * 1000) / 1000 };
  });
}

/** The level curve of every view, each with the peak hold that suits its pitch range. */
function envelopesOf(views: BandViews, rate: number): Record<keyof BandViews, Envelope> {
  const make = (name: keyof BandViews) => envelopeOf(views[name], rate, HOLD_SEC[name]);
  return { sub: make('sub'), low: make('low'), mid: make('mid'), midBand: make('midBand'), high: make('high') };
}

/** The drum hits of a mono recording (seconds on its own timeline), and examples of each kind for a kit. */
export function detectDrums(mono: Float32Array, sampleRate: number, options: DrumOptions = {}): HeardDrums {
  const views = bandViews(mono, sampleRate);
  const read = readViews(views, envelopesOf(views, sampleRate), sampleRate, options.sensitivity ?? 0.5);
  const hits = withStrengths(hitsFromViews(read));
  return { hits, cuts: cutsFor(hits, mono.length / sampleRate) };
}
