/**
 * What an effect slot and the rack effect it holds hand each other. Types only (no imports of either side's classes), so the
 * slot strip and the rack can both use it without importing one another.
 */
import type { FxSlot, InsertId, PluginOwner, Project } from '@core/model/types';
import type { EngineCore } from '../engine-core';
import type { SlotIdleNeeds } from '../fx-slot-strip';

/** What the slot gives the rack when it creates it (through `HostDeps.rack`). */
export interface RackBuild {
  readonly core: EngineCore;
  readonly insertId: InsertId;
  /** The owner of the rack slot: effects inside it use it to tell that the rack's macros are automated. */
  readonly owner: PluginOwner;
  /** The slot as it is in the document now. */
  slot(): FxSlot;
  /** The project as the engine last saw it. */
  project(): Project;
  /** The rack's latency (or what it listens to) changed: the slot makes its dry path match and tells the mixer. */
  onLatency(): void;
}

/**
 * What a slot asks of an effect that holds other effects (a rack): the engine handles these the way an insert handles its
 * own slots. An effect that is not nested has none of them.
 */
export interface NestedEffect {
  readonly isNested: true;
  /** The slot's rack (or the project's samples and plugins) changed. */
  applyRack(slot: FxSlot, project: Project): void;
  /** Frames the rack's audio is behind its input: the slowest branch. */
  readonly latencyFrames: number;
  /** Resolves when every effect inside has been created. */
  readonly ready: Promise<void>;
  /** The delay compensation holds the audio reaching the rack back by `inSeconds` (the rack's own output gain, `outSeconds`). */
  setShift(inSeconds: number, outSeconds: number): void;
  /** The insert stopped or resumed processing the rack. */
  setParked(isParked: boolean): void;
  samplesChanged(project: Project): void;
  automationChanged(project: Project): void;
  pluginsChanged(ids: ReadonlySet<string>, project: Project): void;
  /** What the rack needs before the insert may park (the effects inside, in the slowest branch). */
  idleNeeds(): SlotIdleNeeds;
  /** How many macro targets are hooked now (tests and diagnostics). */
  readonly linkedTargets: number;
}

/** The nested-effect parts of an effect instance, or null for an ordinary effect. */
export function nestedOf(effect: unknown): NestedEffect | null {
  return typeof effect === 'object' && effect !== null && (effect as { isNested?: unknown }).isNested === true
    ? (effect as NestedEffect)
    : null;
}
