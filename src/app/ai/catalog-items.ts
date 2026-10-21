/**
 * Everything Studio can be told about, as one flat list: instruments, effects, piano-roll tools, effect chains, MIDI
 * effects and their chains, and app commands. The compact index (`catalog-index.ts`), the guess of what a request needs (`predict.ts`), the read tools
 * (`read/catalog-tools.ts`) and the attached details (`catalog-details.ts`) all start from it, so they never disagree about
 * what exists or what it is called.
 *
 * The order is fixed (kind, then id, in plain code-unit order, never the locale's), so the same installed plugins and
 * commands always give the same list, on every machine and after every reload.
 */
import type { PluginDef } from '@agstudio/sdk';
import { chainChoices, type ChainChoice } from '@app/chains';
import type { PluginRegistry } from '@app/plugins/registry';
import type { PresetLibrary } from '@app/presets';
import { FACTORY_CHAINS, type FactoryChain } from '@app/actions/midi-fx';
import { MIDI_FX } from '@core/midi-fx/registry';
import type { MidiFxDef } from '@core/midi-fx/types';
import type { Services } from '../services';
import { describeChain, describeMidiFx, describeMidiFxChain, describePlugin, describeScript } from './catalog';
import { aiCommands, describeCommand } from './commands';

export type CatalogKind = 'instrument' | 'effect' | 'tool' | 'chain' | 'midi-effect' | 'midi-chain' | 'command';

/** One thing in the catalog. */
export interface CatalogItem {
  kind: CatalogKind;
  /** A plugin id, a command id, or a chain's name. */
  id: string;
  /** What the musician sees: the plugin's name, the command's title, the chain's name. */
  name: string;
  /** A plugin's category ("Dynamics"), a command's area ("Piano roll"); empty for a chain. */
  category: string;
  /** What the author wrote, in full (a command's hint). */
  description: string;
  /** Presets that ship with the plugin (the musician's own are not counted: they change without a plugin changing). */
  presetCount: number;
  /** Plugins: from the plugins folder, not built in. */
  isUserPlugin: boolean;
  /** Part of the catalog index. False for the musician's own chains: saving one must not change the system prompt. */
  isInIndex: boolean;
  /** Commands: takes an argument (the `argsHint`). */
  takesArgument: boolean;
  /** The full details: settings with ranges and units, presets, arguments. Written when asked for. */
  describe(presets?: PresetLibrary): { text: string; hasNumberedSettings: boolean };
}

/** Plain code-unit order: the same on every machine (`localeCompare` is not). */
export const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const KIND_ORDER: Record<CatalogKind, number> = {
  instrument: 0,
  effect: 1,
  tool: 2,
  chain: 3,
  'midi-effect': 4,
  'midi-chain': 5,
  command: 6,
};

function pluginItem(entry: { def: PluginDef; source: 'builtin' | 'user' }, kind: 'instrument' | 'effect'): CatalogItem {
  const { def } = entry;
  return {
    kind,
    id: def.id,
    name: def.name,
    category: def.category ?? '',
    description: def.description ?? '',
    presetCount: def.presets?.length ?? 0,
    isUserPlugin: entry.source === 'user',
    isInIndex: true,
    takesArgument: false,
    describe: (presets) => {
      const described = describePlugin(def, presets);
      return { text: described.text, hasNumberedSettings: described.families };
    },
  };
}

function toolItems(registry: PluginRegistry): CatalogItem[] {
  return registry.scripts().map((entry) => ({
    kind: 'tool' as const,
    id: entry.def.id,
    name: entry.def.name,
    category: '',
    description: entry.def.description ?? '',
    presetCount: 0,
    isUserPlugin: entry.source === 'user',
    isInIndex: true,
    takesArgument: false,
    describe: () => {
      const described = describeScript(entry.def);
      return { text: described.text, hasNumberedSettings: described.families };
    },
  }));
}

function chainItem(choice: ChainChoice): CatalogItem {
  return {
    kind: 'chain',
    id: choice.name,
    name: choice.name,
    category: '',
    description: choice.description ?? '',
    presetCount: 0,
    isUserPlugin: false,
    isInIndex: choice.source === 'factory',
    takesArgument: false,
    describe: () => ({ text: describeChain(choice), hasNumberedSettings: false }),
  };
}

/** A MIDI effect (an arpeggiator, a chord maker…): it changes an instrument channel's notes before the instrument plays them. */
function midiEffectItem(def: MidiFxDef): CatalogItem {
  return {
    kind: 'midi-effect',
    id: def.id,
    name: def.name,
    category: 'MIDI',
    description: def.description,
    presetCount: def.presets.length,
    isUserPlugin: false,
    isInIndex: true,
    takesArgument: false,
    describe: (presets) => ({ text: describeMidiFx(def, presets), hasNumberedSettings: false }),
  };
}

/** A ready-made chain of MIDI effects (the musician's own are in get_chains, like effect chains). */
function midiChainItem(chain: FactoryChain): CatalogItem {
  return {
    kind: 'midi-chain',
    id: chain.name,
    name: chain.name,
    category: '',
    description: chain.description,
    presetCount: 0,
    isUserPlugin: false,
    isInIndex: true,
    takesArgument: false,
    describe: () => ({ text: describeMidiFxChain(chain), hasNumberedSettings: false }),
  };
}

function commandItems(services: Services): CatalogItem[] {
  return aiCommands(services).map((def) => ({
    kind: 'command' as const,
    id: def.id,
    name: def.title,
    category: def.category ?? 'Other',
    description: def.hint ?? '',
    presetCount: 0,
    isUserPlugin: false,
    isInIndex: true,
    takesArgument: def.argsHint !== undefined,
    describe: () => ({ text: describeCommand(def), hasNumberedSettings: false }),
  }));
}

/** Every item, in the fixed order: by kind, then built-in before the musician's own plugins, then by id. */
export function catalogItems(services: Services): CatalogItem[] {
  const items: CatalogItem[] = [
    ...services.plugins.list('instrument').map((entry) => pluginItem(entry, 'instrument')),
    ...services.plugins.list('effect').map((entry) => pluginItem(entry, 'effect')),
    ...toolItems(services.plugins),
    ...chainChoices(services.presets.chains()).map(chainItem),
    ...MIDI_FX.map(midiEffectItem),
    ...FACTORY_CHAINS.map(midiChainItem),
    ...commandItems(services),
  ];
  return items.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      Number(a.isUserPlugin) - Number(b.isUserPlugin) ||
      (a.kind === 'command' ? byCodeUnits(a.category, b.category) : 0) ||
      byCodeUnits(a.id, b.id),
  );
}
