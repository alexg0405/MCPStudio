/**
 * The types shared by the DJ mix modules (`mix.ts`, `mix-mixer.ts`, `mix-write.ts`).
 */
import type { MixPlan } from '@core/dj/plan';
import type { InsertId, SampleRef, SlotId } from '@core/model/types';

/** A song for the mix: its sample (stored), the title to show, and whether auto order keeps its place. */
export interface MixSong {
  ref: SampleRef;
  title: string;
  pinned?: boolean;
}

/** A deck's mixer track and the two effect slots the transitions automate. */
export interface DeckSlots {
  insertId: InsertId;
  eq: SlotId;
  filter: SlotId;
}

/** A written plan and the lines that say what changed. */
export interface MixWriteResult {
  plan: MixPlan;
  changes: string[];
}
