/** Catalogue of the procedurally generated drum kit (the engine implements the generators). */
export interface KitPiece {
  generator: string;
  name: string;
  /** Short name for channel buttons. */
  short: string;
}

export const KIT_VERSION = 1;

export const KIT: readonly KitPiece[] = [
  { generator: 'kit/kick', name: 'Kick', short: 'Kick' },
  { generator: 'kit/snare', name: 'Snare', short: 'Snare' },
  { generator: 'kit/clap', name: 'Clap', short: 'Clap' },
  { generator: 'kit/hat-closed', name: 'Closed hat', short: 'Hat' },
  { generator: 'kit/hat-open', name: 'Open hat', short: 'Open hat' },
  { generator: 'kit/tom-low', name: 'Low tom', short: 'Tom L' },
  { generator: 'kit/tom-mid', name: 'Mid tom', short: 'Tom M' },
  { generator: 'kit/tom-high', name: 'High tom', short: 'Tom H' },
  { generator: 'kit/rim', name: 'Rim shot', short: 'Rim' },
  { generator: 'kit/cowbell', name: 'Cowbell', short: 'Cowbell' },
  { generator: 'kit/crash', name: 'Crash', short: 'Crash' },
];

export function kitPiece(generator: string): KitPiece | undefined {
  return KIT.find((k) => k.generator === generator);
}
