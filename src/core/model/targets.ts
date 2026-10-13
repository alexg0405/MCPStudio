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

/** The target a `targetKey()` string stands for, or null for anything else. */
export function parseTargetKey(key: string): ParamTarget | null {
  const [kind, ...rest] = key.split(':');
  switch (kind) {
    case 'ch': {
      const [channelId, param] = rest;
      return channelId && (param === 'volume' || param === 'pan' || param === 'pitch')
        ? { kind: 'channel', channelId: channelId as ChannelId, param }
        : null;
    }
    case 'ins': {
      const [insertId, param] = rest;
      return insertId && (param === 'volume' || param === 'pan')
        ? { kind: 'insert', insertId: insertId as InsertId, param }
        : null;
    }
    case 'slot': {
      const [insertId, slotId, param] = rest;
      return insertId && slotId && param === 'mix'
        ? { kind: 'slot', insertId: insertId as InsertId, slotId: slotId as SlotId, param }
        : null;
    }
    case 'route': {
      const [insertId, to] = rest;
      return insertId && to ? { kind: 'route', insertId: insertId as InsertId, to: to as InsertId } : null;
    }
    case 'plug': {
      const [ownerKind, ...ids] = rest;
      if (ownerKind === 'ch' && ids.length >= 2) {
        const [channelId, ...param] = ids;
        return { kind: 'plugin', owner: { kind: 'channel', channelId: channelId as ChannelId }, paramId: param.join(':') };
      }
      if (ownerKind === 'fx' && ids.length >= 3) {
        const [insertId, slotId, ...param] = ids;
        return {
          kind: 'plugin',
          owner: { kind: 'fx', insertId: insertId as InsertId, slotId: slotId as SlotId },
          paramId: param.join(':'),
        };
      }
      return null;
    }
    case 'tempo':
      return rest.length === 0 ? { kind: 'tempo' } : null;
    default:
      return null;
  }
}
