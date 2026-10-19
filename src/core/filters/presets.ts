/**
 * Sound filters ("make bars 17–32 sound like a phone call", "nightcore it"): named recipes applied to
 * a part of the song. Each one is a speed (a vinyl-style resample: faster is higher), a reverse,
 * and a chain of built-in effects. Add a filter by adding a row here; the menus, the chooser, the
 * action search and the Studio pick it up.
 */
import type { ParamValue } from '@agstudio/sdk/params';

/** The two families of sound filters: ones that change speed and pitch, and ones that change the tone. */
export type FilterGroup = 'speed' | 'tone';

/** One effect of a filter's chain: a built-in effect id and the params that differ from its defaults. */
export interface FilterFx {
  plugin: string;
  params: Record<string, ParamValue>;
  /** Dry/wet of the slot (default 1). */
  mix?: number;
}

/**
 * One sound filter: its name and a plain description, its speed, whether it plays backwards, the effects it plays
 * through and other names people call it.
 */
export interface FilterPreset {
  id: string;
  name: string;
  group: FilterGroup;
  /** One plain sentence for the chooser and the menu hint. */
  description: string;
  /** Playback speed factor (1.25 = 25 % faster and about 4 semitones higher); absent = 1. */
  speed?: number;
  /** Plays the part backwards. */
  reverse?: boolean;
  /** Effects the part plays through, in order (on a mixer track of its own). */
  fx: readonly FilterFx[];
  /** Other words people use for it (the action search, the Studio). */
  aliases?: readonly string[];
}

const LOFI = 'agstudio.lofi';
const FILTER = 'agstudio.filter';
const EQ = 'agstudio.eq-pro';
const SATURATOR = 'agstudio.saturator';
const REVERB = 'agstudio.reverb';
const CHORUS = 'agstudio.chorus';
const STEREO = 'agstudio.stereo';
const DISTORTION = 'agstudio.distortion';

/** A big, washy reverb (slowed + reverb, dreamy). */
const WASH: FilterFx = {
  plugin: REVERB,
  params: { decay: 5, size: 0.95, damping: 0.55, preDelay: 0.03, mix: 0.42 },
};

/** EQ Pro with a low cut and a high cut (48 dB/oct: the band outside is really gone) and an optional bump. */
function band(low: number, high: number, bump?: { freq: number; gain: number }): FilterFx {
  return {
    plugin: EQ,
    params: {
      b1On: true,
      b1Type: 'lowCut48',
      b1Freq: low,
      b8On: true,
      b8Type: 'highCut48',
      b8Freq: high,
      ...(bump ? { b4On: true, b4Type: 'bell', b4Freq: bump.freq, b4Gain: bump.gain, b4Q: 0.8 } : {}),
    },
  };
}

/** Every sound filter the app offers; add a row here and the menus, chooser, action search and Studio pick it up. */
export const FILTERS: readonly FilterPreset[] = [
  // ---- Speed and pitch: the part plays faster or slower, its pitch follows (like a record).
  {
    id: 'nightcore',
    name: 'Nightcore',
    group: 'speed',
    speed: 1.25,
    fx: [],
    description: '25 % faster and about 4 semitones higher',
    aliases: ['nightcore it', 'nightcore version'],
  },
  {
    id: 'sped-up',
    name: 'Sped up',
    group: 'speed',
    speed: 1.15,
    fx: [],
    description: '15 % faster and a little higher (about 2½ semitones)',
    aliases: ['speed up', 'faster', 'sped up version'],
  },
  {
    id: 'slowed',
    name: 'Slowed',
    group: 'speed',
    speed: 0.85,
    fx: [],
    description: '15 % slower and a little lower (about 3 semitones)',
    aliases: ['slow down', 'slower'],
  },
  {
    id: 'slowed-reverb',
    name: 'Slowed + reverb',
    group: 'speed',
    speed: 0.85,
    fx: [WASH],
    description: '15 % slower and lower, in a big reverb wash',
    aliases: ['slowed and reverb', 'slowed reverb', 'slowed + reverbed'],
  },
  {
    id: 'daycore',
    name: 'Daycore / Chopped',
    group: 'speed',
    speed: 0.75,
    fx: [],
    description: '25 % slower and about 5 semitones lower: heavy and dragged',
    aliases: ['daycore', 'chopped', 'chopped and screwed', 'screwed'],
  },
  {
    id: 'chipmunk',
    name: 'Chipmunk',
    group: 'speed',
    speed: 1.5,
    fx: [],
    description: '50 % faster and 7 semitones higher: squeaky',
    aliases: ['chipmunk voice', 'helium'],
  },
  // ---- Tone: the timing stays as it is.
  {
    id: 'lofi',
    name: 'Lo-fi',
    group: 'tone',
    fx: [
      {
        plugin: LOFI,
        params: { bits: 10, rate: 22050, wow: 0.35, flutter: 0.15, crackle: 0.1, noise: 0.06, tone: 4500 },
      },
    ],
    description: 'Old sampler grit, a gentle low-pass and a wobbly tape',
    aliases: ['lofi', 'lo fi', 'lo-fi hip hop'],
  },
  {
    id: 'telephone',
    name: 'Telephone',
    group: 'tone',
    fx: [{ plugin: DISTORTION, params: { drive: 9, curve: 'soft', tone: 20000 } }, band(300, 3400, { freq: 1500, gain: 4 })],
    description: 'Only the 300 Hz–3.4 kHz band, a little driven: a phone call',
    aliases: ['phone', 'phone call', 'telephone voice', 'on the phone'],
  },
  {
    id: 'radio',
    name: 'Radio',
    group: 'tone',
    fx: [{ plugin: SATURATOR, params: { mode: 'tube', drive: 12 } }, band(250, 5000, { freq: 2000, gain: 3 })],
    description: 'An old radio: a narrow band (250 Hz–5 kHz) and warm saturation',
    aliases: ['old radio', 'am radio', 'transistor radio'],
  },
  {
    id: 'underwater',
    name: 'Underwater / Muffled',
    group: 'tone',
    fx: [{ plugin: FILTER, params: { type: 'lowpass', cutoff: 500, resonance: 1.2 } }, { plugin: FILTER, params: { type: 'lowpass', cutoff: 500 } }],
    description: 'Everything above 500 Hz muffled: through a wall, under water, next door',
    aliases: ['muffled', 'underwater', 'next room', 'through a wall', 'club next door'],
  },
  {
    id: 'vinyl',
    name: 'Vinyl',
    group: 'tone',
    fx: [
      { plugin: SATURATOR, params: { mode: 'tape', drive: 4 } },
      {
        plugin: EQ,
        params: { b1On: true, b1Type: 'lowCut12', b1Freq: 35, b8On: true, b8Type: 'highCut12', b8Freq: 12000 },
      },
    ],
    description: 'Warm like a record or a tape: highs rolled off above 12 kHz, slight saturation, no crackle',
    aliases: ['warm', 'tape', 'record', 'analog'],
  },
  {
    id: '8-bit',
    name: '8-bit',
    group: 'tone',
    fx: [
      {
        plugin: LOFI,
        params: { bits: 6, rate: 11025, wow: 0, flutter: 0, crackle: 0, noise: 0, tone: 20000 },
      },
    ],
    description: 'Crushed to 6 bits at 11 kHz: a game console',
    aliases: ['8bit', 'bitcrush', 'bitcrushed', 'chiptune', 'game boy', 'retro game'],
  },
  {
    id: 'dreamy',
    name: 'Dreamy',
    group: 'tone',
    fx: [{ plugin: CHORUS, params: { depth: 0.6, rate: 0.4, mix: 0.45 } }, WASH],
    description: 'A soft chorus and a big reverb: floating and far away',
    aliases: ['dream', 'ethereal', 'spacey', 'washed out', 'ambient'],
  },
  {
    id: 'wide',
    name: 'Wide',
    group: 'tone',
    fx: [{ plugin: STEREO, params: { width: 1.7 } }],
    description: 'Wider stereo: the sides spread out',
    aliases: ['wider', 'stereo widen', 'widen'],
  },
  {
    id: 'mono',
    name: 'Mono',
    group: 'tone',
    fx: [{ plugin: STEREO, params: { width: 0 } }],
    description: 'Both speakers play the same: narrow and centred',
    aliases: ['narrow', 'mono it'],
  },
  {
    id: 'reverse',
    name: 'Reverse',
    group: 'tone',
    reverse: true,
    fx: [],
    description: 'The part plays backwards',
    aliases: ['backwards', 'reversed', 'backward'],
  },
];

const BY_ID = new Map(FILTERS.map((f) => [f.id, f]));

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, ' ')
    .replace(/\band\b/g, '+')
    .replace(/\s*\+\s*/g, '+')
    .trim();

/** A filter by id, name or alias (case and punctuation don't matter); undefined when none matches. */
export function findFilter(raw: string): FilterPreset | undefined {
  const exact = BY_ID.get(raw);
  if (exact) return exact;
  const q = norm(raw);
  if (!q) return undefined;
  for (const f of FILTERS) if (norm(f.id) === q || norm(f.name) === q || f.aliases?.some((a) => norm(a) === q)) return f;
  // "Daycore" matches "Daycore / Chopped".
  const parts = FILTERS.filter((f) => norm(f.name).split(' ').includes(q));
  return parts.length === 1 ? parts[0] : undefined;
}

/** The speed factor (1 = unchanged). */
export const speedOf = (f: FilterPreset): number => f.speed ?? 1;

/** Pitch change of a speed factor, in cents (a resample: 1.25 → +386). */
export function speedCents(speed: number): number {
  return 1200 * Math.log2(speed);
}

/** What a filter does to the song's length, for hints. */
export function lengthNote(f: FilterPreset): string {
  const v = speedOf(f);
  if (v === 1) return 'The timing stays the same.';
  return v > 1
    ? `The part's tempo goes up ${Math.round((v - 1) * 100)} %, so the song gets shorter; the bars stay where they are.`
    : `The part's tempo goes down ${Math.round((1 - v) * 100)} %, so the song gets longer; the bars stay where they are.`;
}
