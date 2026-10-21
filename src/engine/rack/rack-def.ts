/**
 * The built-in "Rack" effect. Unlike the other built-ins it is not made from SDK nodes: a rack holds other effects, so the
 * engine builds it (`rack-effect.ts`) and the mixer slot that holds it hands over what it needs (`HostDeps.rack`). The
 * definition is what the rest of the app sees: a name, a description and the eight macros and the output gain as parameters,
 * which is all it takes for automation, controller links, snapshots and the AI to handle them like any effect's.
 */
import { RACK_PARAMS, RACK_PLUGIN_ID, RACK_PLUGIN_VERSION } from '@core/model/rack';
import { defineEffect, type PluginDef, type PluginHost } from '@agstudio/sdk';
import type { PluginResolver } from '../api';
import type { HostImpl } from '../host';
import { RackEffect } from './rack-effect';

/** The rack as a plugin definition. */
export const RACK_DEF = defineEffect({
  id: RACK_PLUGIN_ID,
  name: 'Rack',
  version: RACK_PLUGIN_VERSION,
  category: 'Utility',
  description:
    'A container for effects: split the sound into parallel branches, frequency bands, mid and side or left and right, put effects in each, and move many settings at once with eight macro knobs.',
  params: RACK_PARAMS,
  create(host: PluginHost) {
    const build = (host as unknown as HostImpl).rackBuild;
    if (!build) throw new Error('A rack can only be made by a mixer effect slot.');
    return new RackEffect(host as unknown as HostImpl, build);
  },
}) as PluginDef;

/** A resolver that knows the rack as well as the plugins `base` knows (the rack needs no installing). */
export function withRackPlugin(base: PluginResolver): PluginResolver {
  return { get: (pluginId) => (pluginId === RACK_PLUGIN_ID ? RACK_DEF : base.get(pluginId)) };
}
