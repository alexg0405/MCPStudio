/** Choosing the instrument, settings and level of a new pitched channel: a named preset, else the style's palette. */
import { defaultValues, type ParamValue, type PluginDef } from '@agstudio/sdk';
import type { BeatTrack } from '@core/beat/spec';
import type { Style } from '@core/beat/style';
import { DEFAULT_CHANNEL_VOLUME } from '@core/model/defaults';
import { presetChoices, presetValues, type PresetChoice } from '../../presets';
import type { Services } from '../../services';
import { soundFor } from '../palette';
import { lower } from './channel-matching';

/** The sound a new pitched channel gets. */
export interface PickedSound {
  def: PluginDef;
  params: Record<string, ParamValue>;
  state: unknown;
  volume: number;
  rootKey?: number;
}

/** The preset of that name for a plugin: the musician's own first (they name them), then the factory ones. */
function findPreset(services: Services, definition: PluginDef, name: string): PresetChoice | undefined {
  return presetChoices(definition, services.presets)
    .reverse()
    .find((preset) => lower(preset.name) === lower(name));
}

/** The first instrument that has the preset the track names, with that preset's settings. */
function soundFromNamedPreset(
  services: Services,
  style: Style,
  track: BeatTrack,
  warnings: string[],
): PickedSound | null {
  const choices = soundFor(style, track.sound);
  const definitions = [
    ...choices
      .map((choice) => services.plugins.get(choice.pluginId))
      .filter((definition): definition is PluginDef => !!definition),
    ...services.plugins.list('instrument').map((entry) => entry.def),
  ];
  for (const definition of definitions) {
    const preset = findPreset(services, definition, track.preset!);
    if (!preset) continue;
    const values = presetValues(definition, preset);
    const volume = choices[0]?.volume ?? DEFAULT_CHANNEL_VOLUME;
    return { def: definition, params: values.params, state: values.state, volume };
  }
  warnings.push(`beat: no instrument has a preset “${track.preset}”, so “${track.name}” plays the ${style} sound`);
  return null;
}

/** The instrument, settings and level a new pitched channel gets: a named preset, else the palette. */
export function pickSound(services: Services, style: Style, track: BeatTrack, warnings: string[]): PickedSound | null {
  if (track.preset) {
    const named = soundFromNamedPreset(services, style, track, warnings);
    if (named) return named;
  }
  for (const choice of soundFor(style, track.sound)) {
    const definition = services.plugins.get(choice.pluginId);
    if (!definition) continue;
    const preset = choice.preset ? findPreset(services, definition, choice.preset) : undefined;
    const values = preset
      ? presetValues(definition, preset)
      : { params: defaultValues(definition.params), state: undefined };
    for (const [paramId, value] of Object.entries(choice.params ?? {})) {
      if (definition.params[paramId]) values.params[paramId] = value;
    }
    return {
      def: definition,
      params: values.params,
      state: values.state,
      volume: choice.volume,
      ...(choice.rootKey !== undefined ? { rootKey: choice.rootKey } : {}),
    };
  }
  return null;
}
