/**
 * The plugin catalog as the AI sees it: every instrument and effect with its params (id, type, range,
 * unit, default) and preset names. Sent at the start of a conversation and whenever it changes.
 */
import type { ParamSpec, PluginDef } from '@agstudio/sdk';
import type { PluginRegistry } from '@app/plugins/registry';
import type { PresetLibrary } from '@app/presets';
import { chainChoices, type ChainChoice } from '@app/chains';

/** A param's kind and range without its name or default: "float 20..20000 Hz log". */
function shape(spec: ParamSpec): string {
  switch (spec.type) {
    case 'float':
    case 'int': {
      const unit = spec.unit === '%' ? ' (0–1, shown as %)' : spec.unit ? ` ${spec.unit}` : '';
      const scale = spec.type === 'float' && spec.scale === 'log' ? ' log' : '';
      return `${spec.type} ${spec.min}..${spec.max}${unit}${scale}`;
    }
    case 'enum': {
      const labels = spec.labels as Record<string, string | undefined> | undefined;
      const opts = spec.options.map((o) => (labels?.[o] && labels[o] !== o ? `${o} (${labels[o]})` : o));
      return `one of ${opts.join(' | ')}`;
    }
    case 'bool':
      return 'on/off';
  }
}

const defaultText = (spec: ParamSpec): string =>
  spec.type === 'bool' ? (spec.default ? 'on' : 'off') : String(spec.default);

const labelPart = (id: string, label: string | undefined) =>
  label && label.toLowerCase() !== id.toLowerCase() ? ` "${label}"` : '';

/**
 * The params, one per line, except numbered families (pad1Sound … pad16Sound with the same range and
 * labels "Pad 1 sound" … "Pad 16 sound") which take one line: `pad1..16Sound "Pad N sound": … = kick, rim, …`.
 */
function describeParams(params: Record<string, ParamSpec>): { lines: string[]; families: boolean } {
  const ids = Object.keys(params);
  const family = new Map<string, { n: number; id: string }[]>();
  const keyOf = new Map<string, string>();
  for (const id of ids) {
    const m = /^(\D*?)(\d+)(\D\w*)?$/.exec(id);
    if (!m) continue;
    const spec = params[id] as ParamSpec;
    const n = Number(m[2]);
    const label = (spec.label ?? '').replace(new RegExp(`(^|\\D)${n}(?!\\d)`), '$1N');
    const key = `${m[1]}#${m[3] ?? ''}|${shape(spec)}|${label}`;
    keyOf.set(id, key);
    family.set(key, [...(family.get(key) ?? []), { n, id }]);
  }
  // A family is two or more members numbered one after another.
  const isFamily = (members: { n: number }[]) =>
    members.length >= 2 && members.every((m, i) => i === 0 || m.n === (members[i - 1]?.n ?? 0) + 1);
  const lines: string[] = [];
  const done = new Set<string>();
  let families = false;
  for (const id of ids) {
    const spec = params[id] as ParamSpec;
    const key = keyOf.get(id);
    const members = key ? family.get(key) : undefined;
    if (!key || !members || !isFamily(members)) {
      lines.push(`${id}${labelPart(id, spec.label)}: ${shape(spec)} = ${defaultText(spec)}`);
      continue;
    }
    if (done.has(key)) continue;
    done.add(key);
    families = true;
    const m = /^(\D*?)(\d+)(\D\w*)?$/.exec(id) as RegExpExecArray;
    const first = members[0] as { n: number };
    const last = members[members.length - 1] as { n: number };
    const name = `${m[1]}${first.n}..${last.n}${m[3] ?? ''}`;
    const defaults = members.map((x) => defaultText(params[x.id] as ParamSpec));
    const label = (spec.label ?? '').replace(new RegExp(`(^|\\D)${first.n}(?!\\d)`), '$1N');
    lines.push(
      `${name}${labelPart(name, label)}: ${shape(spec)} = ${defaults.every((d) => d === defaults[0]) ? defaults[0] : defaults.join(', ')}`,
    );
  }
  return { lines, families };
}

function describePlugin(def: PluginDef, presets?: PresetLibrary): { text: string; families: boolean } {
  const head = `- ${def.id} "${def.name}"${def.category ? ` [${def.category}]` : ''}${
    def.kind === 'effect' && def.sidechain ? ' (has a sidechain input)' : ''
  }${def.description ? `: ${def.description}` : ''}`;
  const params = describeParams(def.params as Record<string, ParamSpec>);
  const lines = [head];
  if (params.lines.length) lines.push(`  params: ${params.lines.join('; ')}`);
  if (def.sampleSlots?.length) lines.push(`  plays a sample (set it with "sample" when adding the channel)`);
  if (def.presets?.length) lines.push(`  presets: ${def.presets.map((p) => p.name).join(', ')}`);
  const mine = presets?.forPlugin(def.id) ?? [];
  if (mine.length) lines.push(`  the musician's own presets: ${mine.map((p) => p.name).join(', ')}`);
  return { text: lines.join('\n'), families: params.families };
}

/** One chain: its name, what it is for and its effects in order (a send marks where a return takes over). */
function describeChain(c: ChainChoice): string {
  const steps = c.steps.map((x) => (x.send ? `${x.label} (a send to the ${x.send.to} return when the song has one)` : x.label));
  return `- "${c.name}"${c.source === 'user' ? " (the musician's own)" : ''}${c.description ? `: ${c.description}` : ''}\n  effects, in order: ${steps.join('; ')}`;
}

/** The catalog text and a key that changes when it does. */
export function pluginCatalog(registry: PluginRegistry, presets?: PresetLibrary): { text: string; key: string } {
  const instruments = registry.list('instrument').map((e) => describePlugin(e.def, presets));
  const effects = registry.list('effect').map((e) => describePlugin(e.def, presets));
  const scripts = registry.scripts().map((e) => {
    const params = describeParams(e.def.params as Record<string, ParamSpec>).lines;
    const head = `- ${e.def.id} "${e.def.name}"${e.def.description ? `: ${e.def.description}` : ''}`;
    return params.length ? `${head}\n  params: ${params.join('; ')}` : head;
  });
  const families = [...instruments, ...effects].some((d) => d.families);
  const text = [
    ...(families
      ? [
          'A numbered range such as pad1..16Sound stands for one setting per number (pad1Sound, pad2Sound … pad16Sound); its defaults are listed in order.',
          '',
        ]
      : []),
    'Instruments (for channels):',
    ...instruments.map((d) => d.text),
    '',
    'Effects (for mixer track slots, up to 10 per track):',
    ...effects.map((d) => d.text),
    '',
    'Effect chains (add_chain action: the whole row on a mixer track at once; save_chain keeps a track’s effects as one):',
    ...chainChoices(presets?.chains() ?? []).map(describeChain),
    ...(scripts.length ? ['', 'Piano-roll tools (note_tool action):', ...scripts] : []),
  ].join('\n');
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return { text, key: (h >>> 0).toString(36) };
}
