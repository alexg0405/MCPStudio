/**
 * Note values the MIDI effects are synced to (an arpeggiator's rate, an echo's delay, a note length): each is a whole number
 * of ticks at PPQ 960, so a step on the grid is exact. A triplet is two thirds of the straight value, a dotted note one and
 * a half times it.
 */

/** One note value: its id (the option stored in a project), a plain label and its length in ticks. */
export interface NoteValue {
  readonly id: string;
  readonly label: string;
  readonly ticks: number;
}

/** Every note value, longest first. */
export const NOTE_VALUES: readonly NoteValue[] = [
  { id: '1/1', label: 'Whole note (1 bar in 4/4)', ticks: 3840 },
  { id: '1/2', label: '1/2 note', ticks: 1920 },
  { id: '1/4.', label: 'Dotted 1/4', ticks: 1440 },
  { id: '1/4', label: '1/4 note', ticks: 960 },
  { id: '1/4t', label: '1/4 triplet', ticks: 640 },
  { id: '1/8.', label: 'Dotted 1/8', ticks: 720 },
  { id: '1/8', label: '1/8 note', ticks: 480 },
  { id: '1/8t', label: '1/8 triplet', ticks: 320 },
  { id: '1/16.', label: 'Dotted 1/16', ticks: 360 },
  { id: '1/16', label: '1/16 note', ticks: 240 },
  { id: '1/16t', label: '1/16 triplet', ticks: 160 },
  { id: '1/32', label: '1/32 note', ticks: 120 },
  { id: '1/32t', label: '1/32 triplet', ticks: 80 },
  { id: '1/64', label: '1/64 note', ticks: 60 },
];

const byId = new Map(NOTE_VALUES.map((value) => [value.id, value]));

/** The note values an arpeggiator can run at: from a quarter note down to a 1/32, with triplets and dotted notes. */
export const ARP_RATE_IDS: readonly string[] = ['1/4', '1/4t', '1/8.', '1/8', '1/8t', '1/16.', '1/16', '1/16t', '1/32', '1/32t'];
/** The note values a roll (note repeat) can run at: fast ones, down to a 1/64. */
export const ROLL_RATE_IDS: readonly string[] = ['1/8', '1/8t', '1/16', '1/16t', '1/32', '1/32t', '1/64'];
/** The note values an echo's delay can be: a 1/32 up to a half note. */
export const ECHO_DELAY_IDS: readonly string[] = ['1/2', '1/4.', '1/4', '1/4t', '1/8.', '1/8', '1/8t', '1/16.', '1/16', '1/16t', '1/32'];
/** The note values a fixed note length can be: a 1/64 up to a bar. */
export const LENGTH_IDS: readonly string[] = ['1/64', '1/32', '1/16', '1/8', '1/4', '1/2', '1/1'];

/** The length in ticks of a note value id (an unknown id reads as a 1/16 note). */
export function noteValueTicks(id: string): number {
  return byId.get(id)?.ticks ?? 240;
}

/** Labels for an enum param made of note value ids. */
export function noteValueLabels(ids: readonly string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const id of ids) labels[id] = byId.get(id)?.label ?? id;
  return labels;
}
