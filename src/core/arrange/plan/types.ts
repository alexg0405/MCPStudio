import type { Style } from '../../beat/style';
import type { ChannelId, PatternId, Tick, VariantStep } from '../../model/types';
import type { VariantEnv } from '../fills';
import type { PhraseEvent, SectionCaps } from '../phrases';
import type { SectionSpan, SectionSpec } from '../sections';
import type { AutomationItem, BoundaryRecipe, EndingKind, EndingRecipe, FxLevel, FxPlacement } from '../transitions';

/** What the musician asked an arrangement to be. */
export interface ArrangeRequest {
  /** Where the first section starts. */
  from: Tick;
  style: Style;
  sections: SectionSpec[];
  fx: FxLevel;
  ending: 'auto' | EndingKind;
}

/**
 * What planning needs to know about the project besides the sections: its channels (for variants) and how long a crash
 * rings.
 */
export interface PlanEnv {
  variant: VariantEnv;
  /** How long a crash hit rings (seconds), for its lane. */
  crashSeconds?: number;
}

/** A clip of a source pattern; `steps` (pattern ticks) make it a variant, none = the source itself. */
export interface PlannedClip {
  source: PatternId;
  start: Tick;
  length: Tick;
  steps: VariantStep[];
  section: number;
}

/** An FX sound placed on a lane. */
export interface PlannedFx extends FxPlacement {
  length: Tick;
  lane: string;
}

/** A crash hit the plan places: its song tick, velocity (0..1) and the track it goes on. */
export interface PlannedCrash {
  at: Tick;
  velocity: number;
  lane: string;
}

/** An automation curve the plan places, with the track it goes on. */
export interface PlannedAutomation extends AutomationItem {
  lane: string;
}

/** Everything an arrangement needs, decided without touching the project. */
export interface ArrangementPlan {
  from: Tick;
  to: Tick;
  style: Style;
  barTicks: Tick;
  sections: SectionSpan[];
  /** The boundary into each section (the first one is the intro). */
  boundaries: BoundaryRecipe[];
  ending: EndingRecipe;
  clips: PlannedClip[];
  fx: PlannedFx[];
  crashes: PlannedCrash[];
  automation: PlannedAutomation[];
  markers: { name: string; tick: Tick }[];
  /** Crash hits at the very start of a loop (they would crash every loop): moved into placed crashes. */
  loopCrashes: { patternId: PatternId; channelId: ChannelId; ticks: Tick[] }[];
  counts: PlanCounts;
}

/** What a plan holds, for the summary line. */
export interface PlanCounts {
  fills: number;
  builds: { riser: boolean; gap: boolean; impact: boolean }[];
  breakdowns: number;
}

/** A song-wide change (song ticks) and which section it belongs to. */
export interface SongEvent extends Omit<PhraseEvent, 'why'> {
  section: number;
  why: PhraseEvent['why'];
  /** Where it may change the song (a build kept to the bar before a part of the song); default everywhere. */
  within?: { from: Tick; to: Tick };
}

/** The span an event changes: its own, cut to `within`. */
export const eventSpan = (e: Pick<SongEvent, 'from' | 'to' | 'within'>): { from: Tick; to: Tick } => ({
  from: Math.max(e.from, e.within?.from ?? -Infinity),
  to: Math.min(e.to, e.within?.to ?? Infinity),
});

/** A section of an existing song, as `infer.ts` reads it. */
export interface DevelopSection {
  name: string;
  role: SectionSpan['role'];
  from: Tick;
  to: Tick;
  bars: number;
  energy: number;
  caps: SectionCaps;
  loopBars: number;
}
