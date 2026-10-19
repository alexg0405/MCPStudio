import type { SpecsResolver } from '../../automation/targets';
import type { InsertId, PatternId, SampleRef, SlotId } from '../../model/types';
import type { TempoMap } from '../../time/ppq';
import type { VariantEnv } from '../fills';

/** What writing needs beyond the plan: the variant env, the automation targets the app found or made, sounds. */
export interface ApplyEnv {
  variant: VariantEnv;
  specsOf: SpecsResolver;
  /** The tempo map of the song (splitting audio clips at the edges of a cleared range). */
  tempo: TempoMap;
  targets: SweepTargets;
  /** The crash sound for crash hits, where it plays and how loud (default: the kit crash on the master). */
  crash?: { sample: SampleRef; output: InsertId; volume: number };
  /** Where FX sounds play (the FX bus). */
  fxOutput?: InsertId;
  /** Seconds a built-in sample lasts (crash hits), when known. */
  sampleSeconds?(ref: SampleRef): number | null;
}

/** The controls the arranger's curves move: EQ Pro bands on the chords and lead buses, the reverb send. */
export interface SweepTargets {
  chords?: { insertId: InsertId; slotId: SlotId };
  lead?: { insertId: InsertId; slotId: SlotId };
  /** The chords bus's send to the reverb return. */
  throw?: { from: InsertId; to: InsertId };
}

/** What `applyArrangement` did, for the summary line. */
export interface ApplyReport {
  variants: number;
  clips: number;
  fx: number;
  crashes: number;
  automation: number;
  /** Clips that were there before and got replaced. */
  replaced: number;
  movedCrashes: { patternId: PatternId; count: number }[];
}
