/**
 * Transitions between sections. A boundary A → B at X is classified by the energy change Δ (B − A):
 * rise (Δ ≥ 2, or a build into a drop, chorus or hook), lift (+1), same, dip (−1), fall (≤ −2), outro
 * (into the outro); the song's start is the intro. Each kind has a recipe:
 *
 * | Kind  | End of A                       | Gap (drums + 808 out)             | FX at X (clip gain)                                    | Crash | Automation |
 * |-------|--------------------------------|-----------------------------------|--------------------------------------------------------|-------|------------|
 * | rise  | fill (snare build after a build) | 1 beat; Δ ≥ 3: 2 + full stop on the last | riser −4, reverse crash −3, impact −2, sub drop −6*  | 1.0   | high-pass sweep up across the riser, snaps back at X |
 * | lift  | 2-beat fill                    | –                                 | riser −10, reverse crash (2 beats) −6                  | .9    | – |
 * | same  | 2-beat fill                    | –                                 | –                                                      | .85   | – |
 * | dip   | 1-beat fill                    | –                                 | downlifter (1 bar) −10                                 | .7    | – |
 * | fall  | 1-beat fill                    | –                                 | downlifter −5, impact −8                               | .85   | low-pass 1.2 kHz at X opening over min(8 bars, B/2); reverb throw on A's last beat |
 * | outro | 1-beat fill                    | –                                 | downlifter −6                                          | .8    | – |
 * | intro | –                              | –                                 | –                                                      | –     | low-pass 500 Hz opening across an intro of ≥ 4 bars at energy ≤ 2 |
 *
 * (*sub drop: trap, drill, EDM, house and the bass styles, Δ ≥ 3.) Risers last 1, 2 or 4 bars, whichever is closest to
 * 6 s. The song ends with a master fade over its last 4 bars, or (trap, drill, boom bap, reggaeton)
 * a stop: the last bar plays one beat, with a crash, an impact and a reverb throw. Every curve ends
 * on its target's own value (automation holds its last value), except the fade at the very end.
 *
 * Styles bend the recipe (`TRAITS`): big room and trance build with a snare roll over 8 bars, not 4; the
 * half-time bass styles and drum & bass leave the big silence before a drop already at Δ ≥ 2; progressive
 * house and trance sweep the filter over the whole build (up to 8 bars) rather than only the riser's bars;
 * big room and future bass hit the riser harder; dubstep and future bass end on a stop.
 */
import type { Style } from '../beat/style';
import type { FxKind } from '../model/fx';
import { fxBeats } from '../model/fx';
import type { Tick, VariantKind } from '../model/types';
import { nextFill, type PhraseEvent, type SectionCaps } from './phrases';
import { isPeak, type FillChoice, type SectionRole, type TransitionChoice } from './sections';

const BEAT = 960;

export type BoundaryKind = 'intro' | 'rise' | 'lift' | 'same' | 'dip' | 'fall' | 'outro' | 'none';

/** What a boundary needs to know about the sections on either side. */
export interface BoundarySide {
  role: SectionRole;
  energy: number;
  bars: number;
  transitionIn?: TransitionChoice;
}

export function classifyBoundary(a: BoundarySide | null, b: BoundarySide): BoundaryKind {
  if (!a) return 'intro';
  if (b.transitionIn && b.transitionIn !== 'auto') return b.transitionIn;
  if (b.role === 'outro') return 'outro';
  if (a.role === 'build' && isPeak(b.role)) return 'rise';
  const delta = b.energy - a.energy;
  if (delta >= 2) return 'rise';
  if (delta === 1) return 'lift';
  if (delta === 0) return 'same';
  if (delta === -1) return 'dip';
  // Into a build the energy dips (the build itself rises).
  return b.role === 'build' ? 'dip' : 'fall';
}

/** Riser length in bars: 1, 2 or 4, whichever is closest to 6 seconds. */
export function riserBars(bpm: number, beatsPerBar = 4): 1 | 2 | 4 {
  const bar = (beatsPerBar * 60) / bpm;
  let best: 1 | 2 | 4 = 1;
  for (const n of [1, 2, 4] as const) if (Math.abs(n * bar - 6) < Math.abs(best * bar - 6)) best = n;
  return best;
}

/** How a style bends the transition recipe (see the header); what it leaves out is the default. */
export interface TransitionTraits {
  /** Δ from which a rise gets the big silence (2 beats of gap, the last one a full stop). Default 3. */
  bigGapAt: number;
  /** Bars the snare build before a drop spans (at most the build's length). Default 4. */
  snareBuildBars: number;
  /** The riser's clip gain, dB. Default −4. */
  riserDb: number;
  /** The high-pass sweep spans this many bars of the build (at most its length); default: the riser's bars. */
  sweepBars?: number;
}

const DEFAULT_TRAITS: TransitionTraits = { bigGapAt: 3, snareBuildBars: 4, riserDb: -4 };

export const TRAITS: Partial<Record<Style, Partial<TransitionTraits>>> = {
  edm: { riserDb: -3 },
  bigroom: { snareBuildBars: 8, riserDb: -2 },
  proghouse: { sweepBars: 8, riserDb: -6 },
  futurebass: { bigGapAt: 2, riserDb: -3 },
  dubstep: { bigGapAt: 2 },
  melodicdub: { bigGapAt: 2, riserDb: -5 },
  techhouse: { riserDb: -6 },
  trance: { snareBuildBars: 8, sweepBars: 8, riserDb: -3 },
  dnb: { bigGapAt: 2, snareBuildBars: 4 },
};

export const traitsOf = (style: Style): TransitionTraits => ({ ...DEFAULT_TRAITS, ...TRAITS[style] });

/** The pre-drop gap of a rise: drums and 808 out for 1 beat, or 2 beats plus a full stop at Δ ≥ 3 (a style may start the big one earlier). */
export function gapBeats(kind: BoundaryKind, delta: number, style?: Style): { gap: number; stop: number } {
  if (kind !== 'rise') return { gap: 0, stop: 0 };
  return delta >= (style ? traitsOf(style).bigGapAt : DEFAULT_TRAITS.bigGapAt) ? { gap: 2, stop: 1 } : { gap: 1, stop: 0 };
}

export const CRASH_VELOCITY: Record<BoundaryKind, number | null> = {
  rise: 1,
  lift: 0.9,
  same: 0.85,
  dip: 0.7,
  fall: 0.85,
  outro: 0.8,
  intro: null,
  none: null,
};

const FILL_BEATS: Record<BoundaryKind, number> = { rise: 2, lift: 2, same: 2, dip: 1, fall: 1, outro: 1, intro: 0, none: 0 };

const SUB_DROP_STYLES: ReadonlySet<Style> = new Set<Style>(['trap', 'drill', 'edm', 'house', 'bigroom', 'futurebass', 'dubstep', 'melodicdub', 'dnb']);

/** How much FX transitions get: everything, only builds into drops, or none (fills, gaps and crashes stay). */
export type FxLevel = 'auto' | 'light' | 'none';

/** A transition sound placed on the song (song ticks). */
export interface FxPlacement {
  kind: FxKind;
  beats: number;
  start: Tick;
  gainDb: number;
}

/** Where an automation curve goes: an EQ band on the chords or lead bus, the reverb send, the master. */
export type AutomationTarget =
  | { kind: 'eq'; bus: 'chords' | 'lead'; band: 'low-cut' | 'high-cut' }
  | { kind: 'throw' }
  | { kind: 'master' };

export type AutomationPurpose = 'sweep-up' | 'filter-open' | 'intro-open' | 'throw' | 'fade';

/** One curve, values in the control's own unit; 'neutral' is the control's own setting, 'peak'/'throw' are resolved against it. */
export interface AutomationItem {
  purpose: AutomationPurpose;
  target: AutomationTarget;
  start: Tick;
  length: Tick;
  points: { at: Tick; value: number | 'neutral' | 'throw'; tension?: number }[];
}

export interface BoundaryContext {
  bpm: number;
  beatsPerBar: number;
  barTicks: Tick;
  style: Style;
  fx: FxLevel;
}

export interface BoundaryRecipe {
  kind: BoundaryKind;
  /** X: where B starts. */
  at: Tick;
  delta: number;
  /** Changes at the end of A (A-relative ticks). */
  end: PhraseEvent[];
  fx: FxPlacement[];
  crash: number | null;
  automation: AutomationItem[];
  /** Riser length used (bars), for the summary. */
  riser?: number;
}

const sweepTargets = ['chords', 'lead'] as const;

/**
 * The recipe for the boundary A → B at `at`. `a` is null at the song's start. `aFill` and `aCaps`
 * are A's fill choice and what its patterns can play (a section without drums gets no fill).
 */
export function boundaryRecipe(
  kind: BoundaryKind,
  at: Tick,
  a: (BoundarySide & { fill: FillChoice; caps: SectionCaps }) | null,
  b: BoundarySide,
  ctx: BoundaryContext,
  rotation: { fill: number },
): BoundaryRecipe {
  const bar = ctx.barTicks;
  const delta = a ? b.energy - a.energy : 0;
  const out: BoundaryRecipe = { kind, at, delta, end: [], fx: [], crash: CRASH_VELOCITY[kind], automation: [] };
  const fx = ctx.fx;
  const full = fx === 'auto';
  if (kind === 'intro') {
    if (full && b.bars >= 4 && b.energy <= 2)
      for (const bus of sweepTargets)
        out.automation.push({
          purpose: 'intro-open',
          target: { kind: 'eq', bus, band: 'high-cut' },
          start: at,
          length: b.bars * bar,
          points: [
            { at: 0, value: 500, tension: 0.3 },
            { at: b.bars * bar, value: 'neutral' },
          ],
        });
    return out;
  }
  if (!a || kind === 'none') return out;
  const aLen = a.bars * bar;
  // End of A: snare build or fill, then the gap and the full stop.
  const traits = traitsOf(ctx.style);
  const { gap, stop } = gapBeats(kind, delta, ctx.style);
  const gapTicks = Math.min(aLen, gap * BEAT);
  const fillEnd = aLen - gapTicks;
  if (a.caps.drums && a.fill !== 'none') {
    if (kind === 'rise' && a.role === 'build') {
      const build = Math.min(aLen, Math.min(traits.snareBuildBars, a.bars) * bar);
      if (fillEnd > aLen - build)
        out.end.push({ kind: 'snare-build', from: aLen - build, to: fillEnd, total: fillEnd - (aLen - build), energy: a.energy, why: 'end' });
    } else {
      const beats = kind === 'rise' ? (a.energy >= 3 ? 2 : 1) : FILL_BEATS[kind];
      const from = Math.max(0, fillEnd - beats * BEAT);
      const fillKind: VariantKind | null = nextFill(ctx.style, a.fill, rotation);
      if (fillKind && from < fillEnd) out.end.push({ kind: fillKind, from, to: fillEnd, energy: a.energy, why: 'end' });
    }
  }
  if (gapTicks > 0) out.end.push({ kind: 'gap', from: aLen - gapTicks, to: aLen, energy: a.energy, why: 'end' });
  if (stop > 0) out.end.push({ kind: 'dropout', from: aLen - Math.min(aLen, stop * BEAT), to: aLen, energy: a.energy, why: 'end' });
  // FX at X.
  const bpb = ctx.beatsPerBar;
  const place = (k: FxKind, beats: number, gainDb: number, ending: boolean) =>
    out.fx.push({ kind: k, beats, start: ending ? at - beats * BEAT : at, gainDb });
  const riser = Math.min(riserBars(ctx.bpm, bpb), Math.max(1, Math.floor(a.bars)));
  if (kind === 'rise' && fx !== 'none') {
    place('riser', riser * bpb, traits.riserDb, true);
    out.riser = riser;
    place('reverse-crash', Math.min(4, a.bars * bpb), -3, true);
    place('impact', fxBeats('impact', ctx.bpm), -2, false);
    if (full && delta >= 3 && SUB_DROP_STYLES.has(ctx.style)) place('sub-drop', fxBeats('sub-drop', ctx.bpm), -6, false);
    if (full)
      for (const bus of sweepTargets) {
        // Progressive house and trance sweep the filter over the whole build, the others over the riser.
        const length = (traits.sweepBars ? Math.min(traits.sweepBars, Math.max(1, Math.floor(a.bars))) : riser) * bar;
        out.automation.push({
          purpose: 'sweep-up',
          target: { kind: 'eq', bus, band: 'low-cut' },
          start: at - length,
          length,
          points: [
            { at: 0, value: 'neutral', tension: 0.35 },
            { at: length, value: bus === 'chords' ? 700 : 900 },
            { at: length, value: 'neutral' },
          ],
        });
      }
  }
  if (!full) return out;
  if (kind === 'lift') {
    place('riser', riser * bpb, -10, true);
    out.riser = riser;
    place('reverse-crash', Math.min(2, a.bars * bpb), -6, true);
  }
  const down = (bars: number, gainDb: number) => place('downlifter', Math.max(1, Math.min(bars, b.bars)) * bpb, gainDb, false);
  if (kind === 'dip') down(1, -10);
  if (kind === 'fall') {
    down(2, -5);
    place('impact', fxBeats('impact', ctx.bpm), -8, false);
    const open = Math.max(1, Math.min(8, Math.floor(b.bars / 2))) * bar;
    for (const bus of sweepTargets)
      out.automation.push({
        purpose: 'filter-open',
        target: { kind: 'eq', bus, band: 'high-cut' },
        start: at,
        length: open,
        points: [
          { at: 0, value: 1200, tension: 0.35 },
          { at: open, value: 'neutral' },
        ],
      });
    out.automation.push(throwAt(at - BEAT));
  }
  if (kind === 'outro') down(2, -6);
  return out;
}

/** A reverb throw: the chords' reverb send up for one beat, back to its own level after. */
function throwAt(start: Tick): AutomationItem {
  return {
    purpose: 'throw',
    target: { kind: 'throw' },
    start,
    length: BEAT,
    points: [
      { at: 0, value: 'throw' },
      { at: BEAT, value: 'throw' },
      { at: BEAT, value: 'neutral' },
    ],
  };
}

export type EndingKind = 'fade' | 'stop';
const STOP_STYLES: ReadonlySet<Style> = new Set<Style>(['trap', 'drill', 'boombap', 'reggaeton', 'dubstep', 'futurebass']);

/** The ending a style gets by default. */
export const defaultEnding = (style: Style): EndingKind => (STOP_STYLES.has(style) ? 'stop' : 'fade');

export interface EndingRecipe {
  kind: EndingKind;
  /** Changes at the end of the last section (section-relative). */
  end: PhraseEvent[];
  fx: FxPlacement[];
  crash: { at: Tick; velocity: number } | null;
  automation: AutomationItem[];
}

/** How the song ends after its last section [from, to). */
export function endingRecipe(
  kind: EndingKind,
  last: { from: Tick; to: Tick; energy: number },
  ctx: BoundaryContext,
): EndingRecipe {
  const bar = ctx.barTicks;
  const len = last.to - last.from;
  if (kind === 'fade') {
    const fade = Math.min(len, 4 * bar);
    return {
      kind,
      end: [],
      fx: [],
      crash: null,
      automation:
        ctx.fx === 'none'
          ? []
          : [
              {
                purpose: 'fade',
                target: { kind: 'master' },
                start: last.to - fade,
                length: fade,
                points: [
                  { at: 0, value: 'neutral' },
                  { at: fade, value: 0 },
                ],
              },
            ],
    };
  }
  // A stop: the last bar plays its first beat, with a crash, an impact and the reverb thrown.
  const lastBar = Math.max(0, len - bar);
  const end: PhraseEvent[] = len > BEAT ? [{ kind: 'dropout', from: lastBar + Math.min(BEAT, len), to: len, energy: last.energy, why: 'end' }] : [];
  const at = last.from + lastBar;
  return {
    kind,
    end,
    fx: ctx.fx === 'none' ? [] : [{ kind: 'impact', beats: fxBeats('impact', ctx.bpm), start: at, gainDb: -4 }],
    crash: { at, velocity: 0.95 },
    automation: ctx.fx === 'none' ? [] : [throwAt(at)],
  };
}
