import type { ChannelId, GroupId, InsertId, LinkId, MidiFxSlotId, SlotId, Tick } from './ids';

/** The owner of a plugin instance: an instrument channel, or an effect slot of a mixer insert. */
export type PluginOwner =
  { kind: 'channel'; channelId: ChannelId } | { kind: 'fx'; insertId: InsertId; slotId: SlotId };

/** Something automation, MIDI links and the AI can drive. */
export type ParamTarget =
  | { kind: 'channel'; channelId: ChannelId; param: 'volume' | 'pan' | 'pitch' }
  | { kind: 'insert'; insertId: InsertId; param: 'volume' | 'pan' }
  | { kind: 'slot'; insertId: InsertId; slotId: SlotId; param: 'mix' }
  | { kind: 'route'; insertId: InsertId; to: InsertId }
  /** The VCA fader of a mixer group (its level scales every member's fader). */
  | { kind: 'vca'; groupId: GroupId }
  | { kind: 'plugin'; owner: PluginOwner; paramId: string }
  /** A knob of a MIDI effect in an instrument channel's chain (`InstrumentChannel.midiFx`). */
  | { kind: 'midiFx'; channelId: ChannelId; slotId: MidiFxSlotId; paramId: string }
  | { kind: 'tempo' };

/** How the curve gets from a point to the next one. */
export type AutoShape = 'curve' | 'hold' | 'stairs' | 'smooth';
/** Every `AutoShape`, for lists and for checking loose input. */
export const AUTO_SHAPES: readonly AutoShape[] = ['curve', 'hold', 'stairs', 'smooth'];

/** One point of an automation curve. */
export interface AutoPoint {
  tick: Tick;
  /** Normalized 0–1. */
  value: number;
  /** Bend of the segment leaving this point, −1…1 (0 = straight). */
  tension?: number;
  /** Shape of the segment leaving this point; absent = 'curve'. */
  shape?: AutoShape;
}

/** "Link to controller": a MIDI control change that drives a target. */
export interface ControllerLink {
  id: LinkId;
  /** Controller number 0–127. */
  cc: number;
  /** MIDI channel 0–15, or null for any channel. */
  channel: number | null;
  /** Input device name to match; absent = any input. */
  device?: string;
  target: ParamTarget;
  /** Normalized range the controller sweeps (min may exceed max to invert it). */
  min: number;
  max: number;
}
