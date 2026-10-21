import type { ParamValue } from '@agstudio/sdk/params';
import type { PluginInstance } from './channels';
import type { BranchId, GroupId, InsertId, SlotId, SnapshotId } from './ids';
import type { Rack } from './rack';

/** The mixer: inserts (tracks) in order, the master first. */
export interface Mixer {
  inserts: Record<InsertId, Insert>;
  /** order[0] is always MASTER; an insert's number is its index. */
  order: InsertId[];
  /**
   * Groups of tracks (linked controls and an optional VCA fader), in the order they were made. A track is in
   * at most one group and the master in none. Absent until the first group is made. Added in v3 (optional).
   */
  groups?: MixGroup[];
}

/** Which controls of a group's members move together. */
export interface GroupLinks {
  /** Moving one member's fader moves the others'. */
  volume: boolean;
  /** Moving one member's pan moves the others'. */
  pan: boolean;
  /** Muting one member mutes them all. */
  mute: boolean;
  /** Soloing one member solos them all. */
  solo: boolean;
}

/** How linked faders and pans follow the one that is moved. */
export type GroupMode = 'relative' | 'absolute';

/**
 * A mixer group: tracks that move together, and optionally a VCA fader. A VCA scales the members' levels in
 * decibels without moving their faders (see `docs/architecture.md`, "Mixer snapshots and groups").
 */
export interface MixGroup {
  id: GroupId;
  name: string;
  /** The colour of the band over the members' strips (a hex string). */
  color: string;
  /** The tracks in the group, in the order they were added. */
  members: InsertId[];
  links: GroupLinks;
  /**
   * relative: the others keep their distance from the moved one (a gain ratio, a pan offset);
   * absolute: they all take the moved one's value.
   */
  mode: GroupMode;
  /** The VCA fader: a linear gain (1 = 0 dB) every member's level is multiplied by. Absent = the group has no VCA. */
  vca?: number;
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
  /**
   * Solo-safe: a solo elsewhere does not silence this track (a reverb return, a bus, a click). Absent = false.
   * Added in v3 (optional).
   */
  soloSafe?: boolean;
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
  /**
   * The inside of the slot when it is an effect rack (its plugin is `agstudio.rack`): branches of effects, how the
   * input is split between them and the macro knobs. Absent for every other effect. Added in v3 (optional).
   */
  rack?: Rack;
}

/**
 * A saved state of the mixer: the values of faders, pans, mutes, solos, sends and effect settings, nothing else
 * (no notes, no arrangement, no plugin state), so it stays small. Recalling it writes those values back.
 */
export interface MixSnapshot {
  id: SnapshotId;
  name: string;
  /** When it was saved or last updated, in milliseconds since 1970. */
  savedAt: number;
  /** The state of every track (the master too) at the time. */
  inserts: Record<InsertId, SnapshotInsert>;
  /** The VCA levels (linear gain) of the groups that had one. Absent when none did. */
  vca?: Record<GroupId, number>;
  /** Where each track sent its audio and its effects' sidechains. Present only when it was saved with routing. */
  routing?: Record<InsertId, SnapshotRouting>;
}

/** One track in a snapshot. */
export interface SnapshotInsert {
  /** The track's name then, so a list of differences can still name a track that has been deleted since. */
  name: string;
  /** Linear gain. */
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  /** Send levels (linear gain) by the track they go to. */
  sends: Record<InsertId, number>;
  /** The effects by slot id. */
  fx: Record<SlotId, SnapshotSlot>;
}

/**
 * One effect slot in a snapshot: bypass, dry/wet and the values of its parameters. The effects inside a rack are kept
 * the same way, each under its own slot id, so a snapshot holds a rack's macros (parameters of the rack slot) and the
 * settings of every effect in it.
 */
export interface SnapshotSlot {
  /** The effect it held; its parameters are only recalled while the slot still holds the same one. */
  plugin: string;
  enabled: boolean;
  mix: number;
  params: Record<string, ParamValue>;
  /** For a rack slot: what its branches and crossovers were set to. */
  rack?: SnapshotRack;
}

/** The mix settings of a rack in a snapshot (what is inside each branch is kept per effect, not here). */
export interface SnapshotRack {
  /** By branch; the name is kept so a list of differences can name a branch that has been removed since. */
  branches: Record<BranchId, { name: string; levelDb: number; pan: number; muted: boolean; solo: boolean }>;
  /** The band edges (Hz) of a `bands` rack. */
  crossovers: number[];
}

/** One track's routing in a snapshot (the send levels are in `SnapshotInsert.sends`). */
export interface SnapshotRouting {
  /** The tracks it sends to, in order, and whether each send is taken before the fader. */
  routes: { to: InsertId; pre: boolean }[];
  /** The source of each effect slot's sidechain (null = the effect's own input). */
  sidechains: Record<SlotId, InsertId | null>;
}
