import type { PluginInstance } from './channels';
import type { InsertId, SlotId } from './ids';

/** The mixer: inserts (tracks) in order, the master first. */
export interface Mixer {
  inserts: Record<InsertId, Insert>;
  /** order[0] is always MASTER; an insert's number is its index. */
  order: InsertId[];
}

/** One mixer track: fader, pan, effects and where its output goes. */
export interface Insert {
  id: InsertId;
  name: string;
  color?: string;
  /** Linear gain (1 = 0 dB). */
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  /** Ordered effect slots, no gaps. */
  fx: FxSlot[];
  /**
   * Where this insert's output goes (at most one route per target). New inserts route to the
   * master; the master has none. No routes = silent. The routes and sidechains form no cycle.
   */
  routes: Route[];
}

/** A send from one insert to another. */
export interface Route {
  to: InsertId;
  /** Linear send gain (1 = 0 dB). */
  level: number;
  /** Taken before the insert's pan and fader instead of after them. */
  pre: boolean;
}

/** One effect on an insert. */
export interface FxSlot {
  id: SlotId;
  plugin: PluginInstance;
  enabled: boolean;
  /** Dry/wet 0–1. */
  mix: number;
  /** Insert whose output feeds this effect's sidechain input (effects that declare one); null = none. */
  sidechain: InsertId | null;
}
