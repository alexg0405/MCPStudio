/**
 * Quick requests for a part of the song, one click each: what musicians usually ask about some bars,
 * clips or a section, or about selected notes.
 */
import type { AiFocus } from '@app/ai/focus';

/** For bars, clips or a section. */
export const TIME_CHIPS: readonly string[] = [
  'Smooth the transition in',
  'Smooth the transition out',
  'Add a fill at the end',
  'More variation',
  'Hit harder',
  'Strip it back',
];

/** For selected notes. */
export const NOTE_CHIPS: readonly string[] = ['Tighten the timing', 'More groove', 'Make it catchier'];

/** The quick requests that fit a focus (none without one). */
export function quickChips(focus: AiFocus | null | undefined): readonly string[] {
  if (!focus) return [];
  return focus.kind === 'notes' ? NOTE_CHIPS : TIME_CHIPS;
}

/** What a chip does, for its hint: "Ask the AI: “Hit harder” (only Verse · bars 17–32 changes)". */
export function chipHint(chip: string, label: string | null): string {
  return label ? `Ask Studio: “${chip}” (only ${label} changes)` : `Ask Studio: “${chip}”`;
}
