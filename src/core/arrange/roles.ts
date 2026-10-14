/**
 * What each channel plays in the song (kick, hats, 808, chords, lead, FX…), from its sample, its
 * plugin, its name and, failing those, its notes. The arranger, the fills and the mix setup work by
 * role, so a song built from any mix of samplers, kits and synths gets the same treatment.
 */
import type { ChannelId, InstrumentChannel, Project } from '../model/types';

export const ROLES = [
  'kick',
  'snare',
  'clap',
  'rim',
  'hat',
  'open-hat',
  'perc',
  'tom',
  'crash',
  /** A channel that plays a whole drum kit on its keys (Drum Pads, Drum Synth): see `gmDrumRole`. */
  'kit',
  '808',
  'bass',
  'chords',
  'pad',
  'keys',
  'lead',
  'pluck',
  'arp',
  'vox',
  'fx',
  'other',
] as const;
export type Role = (typeof ROLES)[number];

export type RoleGroup = 'drums' | 'bass' | 'music' | 'fx' | 'other';

export const ROLE_GROUP: Record<Role, RoleGroup> = {
  kick: 'drums',
  snare: 'drums',
  clap: 'drums',
  rim: 'drums',
  hat: 'drums',
  'open-hat': 'drums',
  perc: 'drums',
  tom: 'drums',
  crash: 'drums',
  kit: 'drums',
  '808': 'bass',
  bass: 'bass',
  chords: 'music',
  pad: 'music',
  keys: 'music',
  lead: 'music',
  pluck: 'music',
  arp: 'music',
  vox: 'music',
  fx: 'fx',
  other: 'other',
};

/** A role a plugin implies on its own (the app knows plugin ids; core doesn't). */
export type RoleHint = (pluginId: string) => Role | undefined;

/** General MIDI drum keys (Drum Pads uses this layout on keys 36–51). */
export const GM_DRUMS = {
  kick: [35, 36],
  rim: [37],
  snare: [38, 40],
  clap: [39],
  hat: [42, 44],
  'open-hat': [46],
  tom: [41, 43, 45, 47, 48, 50],
  crash: [49, 52, 55, 57],
  perc: [51, 53, 54, 56, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 75, 76, 77],
} as const satisfies Partial<Record<Role, readonly number[]>>;

/** The drum a key plays on a GM kit channel. */
export function gmDrumRole(key: number): Role {
  for (const [role, keys] of Object.entries(GM_DRUMS) as [Role, readonly number[]][]) if (keys.includes(key)) return role;
  return 'perc';
}

const FX_NAME = /\b(riser|uplifter|downlifter|down ?lifter|sweep|whoosh|impact|sub ?drop|reverse|rev ?crash|noise ?fx|fx)\b/i;

/** A built-in sample's generator name → the drum it is ("kit/hat-closed", "kit/trap/kick", "fx/riser/…"). */
function sampleRole(generator: string): Role | undefined {
  if (generator.startsWith('fx/')) return 'fx';
  if (!generator.startsWith('kit/')) return undefined;
  const piece = generator.split('/').pop() ?? '';
  if (piece === 'kick') return 'kick';
  if (piece === 'snare') return 'snare';
  if (piece === 'clap') return 'clap';
  if (piece === 'rim') return 'rim';
  if (piece === 'hat-open' || piece === 'open-hat') return 'open-hat';
  if (piece.startsWith('hat')) return 'hat';
  if (piece.startsWith('tom')) return 'tom';
  if (piece === 'crash' || piece === 'ride') return 'crash';
  return 'perc';
}

const NAME_RULES: [RegExp, Role][] = [
  [/\b808\b/i, '808'],
  [/\b(kick|bd|bass ?drum)\b/i, 'kick'],
  [/\b(snare|sd)\b/i, 'snare'],
  [/\bclap\b/i, 'clap'],
  [/\brim/i, 'rim'],
  [/\b(open ?hat|oh|open hi-?hat)\b/i, 'open-hat'],
  [/\b(hat|hats|hh|hi-?hats?|hihats?)\b/i, 'hat'],
  [/\btoms?\b/i, 'tom'],
  [/\b(crash|cymbal|ride|china|splash)\b/i, 'crash'],
  [/\b(perc|percussion|shaker|conga|bongo|tamb|tambourine|cowbell|timbal|clave|snap|log ?drum)\b/i, 'perc'],
  [/\b(drums?|kit|break|loop)\b/i, 'kit'],
  [/\b(sub|bass|reese)\b/i, 'bass'],
  [/\b(pad|pads|strings?|choir|atmos|atmosphere|drone|texture)\b/i, 'pad'],
  [/\b(chords?|stab)\b/i, 'chords'],
  [/\b(keys|piano|ep|rhodes|organ|wurli|epiano|e-piano)\b/i, 'keys'],
  [/\barp/i, 'arp'],
  [/\bpluck/i, 'pluck'],
  [/\b(vox|vocal|vocals|voice|chop)\b/i, 'vox'],
  [/\b(lead|melody|synth|bell|bells|flute|guitar|horn|brass|sax|whistle)\b/i, 'lead'],
];

/** From a channel's notes across every pattern: low and one at a time = bass; 3+ at once = chords. */
function noteRole(p: Project, id: ChannelId): Role | undefined {
  const keys: number[] = [];
  let maxAtOnce = 0;
  for (const pat of Object.values(p.patterns)) {
    const notes = Object.values(pat.notes[id] ?? {}).sort((a, b) => a.tick - b.tick);
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i]!;
      keys.push(n.key);
      let atOnce = 1;
      for (let j = i + 1; j < notes.length && notes[j]!.tick < n.tick + n.length; j++) if (notes[j]!.tick < n.tick + 30) atOnce++;
      maxAtOnce = Math.max(maxAtOnce, atOnce);
    }
  }
  if (keys.length === 0) return undefined;
  if (maxAtOnce >= 3) return 'chords';
  const sorted = [...keys].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return median < 48 ? 'bass' : 'lead';
}

/** The role of one channel. */
export function channelRole(p: Project, id: ChannelId, hint?: RoleHint): Role {
  const ch = p.channels[id];
  if (!ch) return 'other';
  if (ch.kind === 'automation') return 'other';
  if (FX_NAME.test(ch.name)) return 'fx';
  if (ch.kind === 'audioClip') {
    const src = p.samples[ch.sampleId]?.source;
    const fromSample = src?.kind === 'builtin' ? sampleRole(src.generator) : undefined;
    return fromSample ?? NAME_RULES.find(([re]) => re.test(ch.name))?.[1] ?? 'other';
  }
  const inst = ch as InstrumentChannel;
  const main = inst.plugin.samples?.main;
  const src = main ? p.samples[main]?.source : undefined;
  const fromSample = src?.kind === 'builtin' ? sampleRole(src.generator) : undefined;
  if (fromSample) return fromSample;
  const fromPlugin = hint?.(inst.plugin.pluginId);
  if (fromPlugin) return fromPlugin;
  const fromName = NAME_RULES.find(([re]) => re.test(ch.name))?.[1];
  if (fromName) return fromName;
  return noteRole(p, id) ?? 'other';
}

/** Every channel's role. */
export function channelRoles(p: Project, hint?: RoleHint): Map<ChannelId, Role> {
  const out = new Map<ChannelId, Role>();
  for (const id of p.channelOrder) out.set(id, channelRole(p, id, hint));
  return out;
}
