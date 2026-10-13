/**
 * The plugin catalog as the AI sees it: every instrument and effect with its params (id, type, range,
 * unit, default) and preset names. Sent at the start of a conversation and whenever it changes.
 */
import type { ParamSpec, PluginDef } from '@agstudio/sdk';
import type { PluginRegistry } from '@app/plugins/registry';

function describeParam(id: string, spec: ParamSpec): string {
  const label = spec.label && spec.label.toLowerCase() !== id.toLowerCase() ? ` "${spec.label}"` : '';
  switch (spec.type) {
    case 'float':
    case 'int': {
      const unit = spec.unit === '%' ? ' (0–1, shown as %)' : spec.unit ? ` ${spec.unit}` : '';
      const scale = spec.type === 'float' && spec.scale === 'log' ? ' log' : '';
      return `${id}${label}: ${spec.type} ${spec.min}..${spec.max}${unit}${scale} = ${spec.default}`;
    }
    case 'enum': {
      const labels = spec.labels as Record<string, string | undefined> | undefined;
      const opts = spec.options.map((o) => (labels?.[o] && labels[o] !== o ? `${o} (${labels[o]})` : o));
      return `${id}${label}: one of ${opts.join(' | ')} = ${spec.default}`;
    }
    case 'bool':
      return `${id}${label}: on/off = ${spec.default ? 'on' : 'off'}`;
  }
}

function describePlugin(def: PluginDef): string {
  const head = `- ${def.id} "${def.name}"${def.category ? ` [${def.category}]` : ''}${
    def.kind === 'effect' && def.sidechain ? ' (has a sidechain input)' : ''
  }${def.description ? `: ${def.description}` : ''}`;
  const params = Object.entries(def.params).map(([id, spec]) => describeParam(id, spec as ParamSpec));
  const lines = [head];
  if (params.length) lines.push(`  params: ${params.join('; ')}`);
  if (def.sampleSlots?.length) lines.push(`  plays a sample (set it with "sample" when adding the channel)`);
  if (def.presets?.length) lines.push(`  presets: ${def.presets.map((p) => p.name).join(', ')}`);
  return lines.join('\n');
}

/** The catalog text and a key that changes when it does. */
export function pluginCatalog(registry: PluginRegistry): { text: string; key: string } {
  const instruments = registry.list('instrument').map((e) => describePlugin(e.def));
  const effects = registry.list('effect').map((e) => describePlugin(e.def));
  const scripts = registry
    .scripts()
    .map((e) => `- ${e.def.id} "${e.def.name}"${e.def.description ? `: ${e.def.description}` : ''}`);
  const text = [
    'Instruments (for channels):',
    ...instruments,
    '',
    'Effects (for mixer track slots, up to 10 per track):',
    ...effects,
    ...(scripts.length ? ['', 'Piano-roll tools (note scripts):', ...scripts] : []),
  ].join('\n');
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return { text, key: (h >>> 0).toString(36) };
}
