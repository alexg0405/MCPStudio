/**
 * The mixer layout a song's mix is built on: one bus per role (kick, drums, 808/bass, chords, lead,
 * FX) plus reverb and delay returns, found again by name so a later setup, a transition (filter
 * sweeps on the chords/lead EQ) or the leveler reuses them.
 */
import { channelRoles, type Role, type RoleHint } from '@core/arrange/roles';
import { MASTER, type ChannelId, type InsertId, type Project, type SlotId } from '@core/model/types';

export type BusRole = 'kick' | 'drums' | 'bass' | 'chords' | 'lead' | 'vocals' | 'fx' | 'reverb' | 'delay';

export const BUS_NAMES: Record<BusRole, string> = {
  kick: 'Kick',
  drums: 'Drums',
  bass: '808',
  chords: 'Chords',
  lead: 'Lead',
  vocals: 'Vocals',
  fx: 'FX',
  reverb: 'Reverb',
  delay: 'Delay',
};

export interface MixLayout {
  buses: Partial<Record<BusRole, InsertId>>;
  /** The EQ Pro slot on a bus (its low/high cut bands are the filter-sweep targets). */
  eq: Partial<Record<BusRole, SlotId>>;
  /** The master's Limiter (the last one). */
  limiter?: SlotId;
}

/** The bus a channel of this role plays through (null: leave it where it is). */
export function busForRole(r: Role): BusRole | null {
  switch (r) {
    case 'kick':
      return 'kick';
    case 'snare':
    case 'clap':
    case 'rim':
    case 'hat':
    case 'open-hat':
    case 'perc':
    case 'tom':
    case 'crash':
    case 'kit':
      return 'drums';
    case '808':
    case 'bass':
      return 'bass';
    case 'chords':
    case 'pad':
    case 'keys':
      return 'chords';
    case 'lead':
    case 'pluck':
    case 'arp':
      return 'lead';
    case 'vox':
      return 'vocals';
    case 'fx':
      return 'fx';
    case 'other':
      return null;
  }
}

const EQ_PRO = 'agstudio.eq-pro';
const LIMITER = 'agstudio.limiter';

/** The role a built-in instrument implies on its own (whole kits on one channel, the 808, plucks). */
export const pluginRole: RoleHint = (pluginId) => {
  switch (pluginId) {
    case 'agstudio.bass808':
      return '808';
    case 'agstudio.drum-pads':
    case 'agstudio.drum-synth':
    case 'agstudio.slicer':
      return 'kit';
    case 'agstudio.pluck':
      return 'pluck';
    default:
      return undefined;
  }
};

/** Every channel's role, with the built-in plugins' hints. */
export function mixRoles(p: Project): Map<ChannelId, Role> {
  return channelRoles(p, pluginRole);
}

/** The role buses already in the project (by their names), with their EQ slots and the master Limiter. */
export function findMixLayout(p: Project): MixLayout {
  const layout: MixLayout = { buses: {}, eq: {} };
  for (const [role, name] of Object.entries(BUS_NAMES) as [BusRole, string][]) {
    const id = p.mixer.order.find((x) => x !== MASTER && p.mixer.inserts[x]?.name.toLowerCase() === name.toLowerCase());
    if (!id) continue;
    layout.buses[role] = id;
    const eq = p.mixer.inserts[id]!.fx.find((f) => f.plugin.pluginId === EQ_PRO);
    if (eq) layout.eq[role] = eq.id;
  }
  const limiters = p.mixer.inserts[MASTER]?.fx.filter((f) => f.plugin.pluginId === LIMITER) ?? [];
  if (limiters.length) layout.limiter = limiters[limiters.length - 1]!.id;
  return layout;
}
