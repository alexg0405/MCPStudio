import type { ChannelId, InsertId, ParamTarget, SlotId } from './types';

/**
 * A stable string for a target: the key the engine registers automatable params under and the UI
 * uses to find a knob's automation or controller link.
 */
export function targetKey(t: ParamTarget): string {
  switch (t.kind) {
    case 'channel':
      return `ch:${t.channelId}:${t.param}`;
    case 'insert':
      return `ins:${t.insertId}:${t.param}`;
    case 'slot':
      return `slot:${t.insertId}:${t.slotId}:${t.param}`;
    case 'route':
      return `route:${t.insertId}:${t.to}`;
    case 'plugin':
      return t.owner.kind === 'channel'
        ? `plug:ch:${t.owner.channelId}:${t.paramId}`
        : `plug:fx:${t.owner.insertId}:${t.owner.slotId}:${t.paramId}`;
    case 'tempo':
      return 'tempo';
  }
}

export function sameTarget(a: ParamTarget, b: ParamTarget): boolean {
  return targetKey(a) === targetKey(b);
}

/** Whether the target belongs to the channel (its volume, pan, pitch or instrument params). */
export function targetUsesChannel(t: ParamTarget, id: ChannelId): boolean {
  if (t.kind === 'channel') return t.channelId === id;
  return t.kind === 'plugin' && t.owner.kind === 'channel' && t.owner.channelId === id;
}

/** Whether the target belongs to the insert (its levels, slots, effects or routes, either end). */
export function targetUsesInsert(t: ParamTarget, id: InsertId): boolean {
  switch (t.kind) {
    case 'insert':
    case 'slot':
      return t.insertId === id;
    case 'route':
      return t.insertId === id || t.to === id;
    case 'plugin':
      return t.owner.kind === 'fx' && t.owner.insertId === id;
    case 'channel':
    case 'tempo':
      return false;
  }
}

/** Whether the target belongs to the effect slot (its mix or its effect's params). */
export function targetUsesSlot(t: ParamTarget, insertId: InsertId, slotId: SlotId): boolean {
  if (t.kind === 'slot') return t.insertId === insertId && t.slotId === slotId;
  return t.kind === 'plugin' && t.owner.kind === 'fx' && t.owner.insertId === insertId && t.owner.slotId === slotId;
}
