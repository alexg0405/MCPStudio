/** Catalogue of the procedurally generated drum kits (the engine implements the generators). */

/** The drum a kit piece is (the beat writer's sound names). */
export type KitSound =
  | 'kick'
  | 'snare'
  | 'clap'
  | 'hat'
  | 'open-hat'
  | 'tom-low'
  | 'tom-mid'
  | 'tom-high'
  | 'rim'
  | 'cowbell'
  | 'crash';

/** Genre kits (the stock kit is the default one). */
export const KIT_STYLES = ['trap', 'house', 'lofi', 'boombap', 'edm', 'bass', 'dnb'] as const;
/** One of `KIT_STYLES`: the genre a kit piece belongs to. */
export type KitStyle = (typeof KIT_STYLES)[number];

/** One drum of a kit: the generator that makes its sound and the names the UI shows for it. */
export interface KitPiece {
  generator: string;
  name: string;
  /** Short name for channel buttons. */
  short: string;
  /** The drum it is. */
  sound: KitSound;
  /** The genre kit it belongs to (none: the stock kit). */
  kit?: KitStyle;
}

/**
 * The version of the generated kit sounds stored with their samples; bump it (and keep the old generator) if a sound
 * ever changes.
 */
export const KIT_VERSION = 1;

/** The stock drum kit, one piece per drum the beat writer knows. */
export const KIT: readonly KitPiece[] = [
  { generator: 'kit/kick', name: 'Kick', short: 'Kick', sound: 'kick' },
  { generator: 'kit/snare', name: 'Snare', short: 'Snare', sound: 'snare' },
  { generator: 'kit/clap', name: 'Clap', short: 'Clap', sound: 'clap' },
  { generator: 'kit/hat-closed', name: 'Closed hat', short: 'Hat', sound: 'hat' },
  { generator: 'kit/hat-open', name: 'Open hat', short: 'Open hat', sound: 'open-hat' },
  { generator: 'kit/tom-low', name: 'Low tom', short: 'Tom L', sound: 'tom-low' },
  { generator: 'kit/tom-mid', name: 'Mid tom', short: 'Tom M', sound: 'tom-mid' },
  { generator: 'kit/tom-high', name: 'High tom', short: 'Tom H', sound: 'tom-high' },
  { generator: 'kit/rim', name: 'Rim shot', short: 'Rim', sound: 'rim' },
  { generator: 'kit/cowbell', name: 'Cowbell', short: 'Cowbell', sound: 'cowbell' },
  { generator: 'kit/crash', name: 'Crash', short: 'Crash', sound: 'crash' },
];

const KIT_LABELS: Record<KitStyle, string> = {
  trap: 'Trap',
  house: 'House',
  lofi: 'Lo-fi',
  boombap: 'Boom bap',
  edm: 'Festival',
  bass: 'Bass music',
  dnb: 'Drum & bass',
};

/** The pieces every genre kit has; the others come from the stock kit. */
export const GENRE_SOUNDS = ['kick', 'snare', 'clap', 'hat', 'open-hat'] as const satisfies readonly KitSound[];

/**
 * Genre kits: `kit/<style>/<piece>`, rendered from the SDK drum models with the Drum Synth's preset
 * values for the genre (peaks matched to the stock kit's), e.g. `kit/trap/kick`, `kit/lofi/open-hat`.
 */
export const GENRE_KITS: Readonly<Record<KitStyle, readonly KitPiece[]>> = {
  trap: genreKit('trap'),
  house: genreKit('house'),
  lofi: genreKit('lofi'),
  boombap: genreKit('boombap'),
  edm: genreKit('edm'),
  bass: genreKit('bass'),
  dnb: genreKit('dnb'),
};

function genreKit(kit: KitStyle): KitPiece[] {
  return GENRE_SOUNDS.map((sound): KitPiece => {
    const stock = KIT.find((k) => k.sound === sound)!;
    return { generator: `kit/${kit}/${sound}`, name: `${KIT_LABELS[kit]} ${stock.name.toLowerCase()}`, short: stock.short, sound, kit };
  });
}

const ALL: ReadonlyMap<string, KitPiece> = new Map(
  [...KIT, ...Object.values(GENRE_KITS).flat()].map((k) => [k.generator, k] as const),
);

/** A kit piece (stock or genre) by its generator name. */
export function kitPiece(generator: string): KitPiece | undefined {
  return ALL.get(generator);
}

/** The piece that plays `sound` in a kit: the genre kit's own, else the stock one. */
export function kitPieceFor(sound: KitSound, kit?: KitStyle | null): KitPiece | undefined {
  return (kit ? GENRE_KITS[kit].find((k) => k.sound === sound) : undefined) ?? KIT.find((k) => k.sound === sound);
}
