/** The `save_preset` action: a channel's or effect's settings saved as one of the musician's own presets. */
import type { PluginOwner } from '@core/model/types';
import type { Services } from '../../../services';
import type { AiAction } from '../../schema';
import { fail, type OpContext } from '../context';
import { str } from '../values';
import type { SessionOutput } from './output';

/** Saves the settings (same name replaces) and says so. */
export function applySavePreset(services: Services, action: AiAction, context: OpContext, out: SessionOutput): void {
  const name = str(action.name) ?? fail('the preset needs a name');
  let owner: PluginOwner;
  let instance;
  if (action.effect !== undefined) {
    const effect = context.effect(action.effect);
    owner = { kind: 'fx', insertId: effect.insertId, slotId: effect.slotId };
    instance = context.project.mixer.inserts[effect.insertId]!.fx.find((slot) => slot.id === effect.slotId)!.plugin;
  } else {
    const channel = context.project.channels[context.channel(action.channel)]!;
    if (channel.kind !== 'instrument') return fail(`“${channel.name}” has no instrument to save`);
    owner = { kind: 'channel', channelId: channel.id };
    instance = channel.plugin;
  }
  const definition = services.plugins.get(instance.pluginId) ?? fail(`the plugin ${instance.pluginId} isn't installed`);
  const saved = services.presets.save({
    pluginId: definition.id,
    version: definition.version,
    name,
    params: structuredClone({ ...instance.params }),
    ...(instance.state !== undefined ? { state: structuredClone(instance.state) as never } : {}),
  });
  services.presets.noteLoaded(owner, saved.name);
  out.ui.push(`Saved ${definition.name} preset “${saved.name}”`);
}
