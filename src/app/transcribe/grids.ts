/** The quantize grids "Convert to MIDI" offers, in musicians' words, and the ways of naming one in a request. */

/** One grid: an id, a label, the ticks between its lines. */
export interface GridChoice {
  id: string;
  label: string;
  /** Ticks between grid lines (960 per quarter note); 0 = no quantizing. */
  ticks: number;
}

/** The grid choices in the order the dialog lists them. */
export const GRID_CHOICES: readonly GridChoice[] = [
  { id: 'off', label: 'Off: as played', ticks: 0 },
  { id: '1/32', label: '1/32 note', ticks: 120 },
  { id: '1/16t', label: '1/16 triplet', ticks: 160 },
  { id: '1/16', label: '1/16 note (one step)', ticks: 240 },
  { id: '1/8t', label: '1/8 triplet', ticks: 320 },
  { id: '1/8', label: '1/8 note', ticks: 480 },
  { id: '1/4', label: '1/4 note (a beat)', ticks: 960 },
];

/** The grid id for a number of ticks (the nearest choice). */
export function gridIdOfTicks(ticks: number): string {
  return GRID_CHOICES.reduce((best, g) => (Math.abs(g.ticks - ticks) < Math.abs(best.ticks - ticks) ? g : best)).id;
}

/** Other ways of saying a grid in a request ("step", "beat", "sixteenth", "1/16 triplet"). */
const ALIASES: Readonly<Record<string, string>> = {
  none: 'off',
  'as played': 'off',
  step: '1/16',
  sixteenth: '1/16',
  '1/16 note': '1/16',
  '1/16 triplet': '1/16t',
  eighth: '1/8',
  '1/8 note': '1/8',
  '1/8 triplet': '1/8t',
  beat: '1/4',
  quarter: '1/4',
  '1/4 note': '1/4',
  '1/32 note': '1/32',
};

/** The grid a request names (an id, an alias, or a number of ticks), or null when it is none of them. */
export function parseGrid(value: unknown): GridChoice | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const id = gridIdOfTicks(value);
    return GRID_CHOICES.find((g) => g.id === id) ?? null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  const id = ALIASES[text] ?? text;
  return GRID_CHOICES.find((g) => g.id === id) ?? null;
}
