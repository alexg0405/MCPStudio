/**
 * What the note tools share: the param builders (grid, gap, key name, seed, voicing, root and scale) and the small
 * helpers that turn their values into ticks, keys and bar ranges.
 */
import { p, type NoteScriptContext, type ParamSpecs } from '@agstudio/sdk';
import { noteName, PITCH_NAMES, SCALES, span, VOICINGS, type KeyLike } from '@agstudio/sdk/notes';

/** Note values in quarter notes. */
const NOTE_VALUES = {
  '1/64': 1 / 16,
  '1/32': 1 / 8,
  '1/16': 1 / 4,
  '1/8': 1 / 2,
  '1/4': 1,
  '1/2': 2,
  '1/32t': 1 / 12,
  '1/16t': 1 / 6,
  '1/8t': 1 / 3,
  '1/4t': 2 / 3,
} as const;
type NoteValue = keyof typeof NOTE_VALUES;
const VALUE_IDS = Object.keys(NOTE_VALUES) as NoteValue[];

const VALUE_LABELS = {
  snap: 'Piano roll snap',
  bar: '1 bar',
  '1/64': '1/64 note',
  '1/32': '1/32 note',
  '1/16': '1/16 note (1 step)',
  '1/8': '1/8 note',
  '1/4': '1/4 note (1 beat)',
  '1/2': '1/2 note',
  '1/32t': '1/32 triplet',
  '1/16t': '1/16 triplet',
  '1/8t': '1/8 triplet',
  '1/4t': '1/4 triplet',
};

export const gridParam = (def: 'snap' | NoteValue | 'bar', label = 'Grid', hint = 'The note value to use') =>
  p.enum(['snap', ...VALUE_IDS, 'bar'], def, { label, labels: VALUE_LABELS, hint });

/** Ticks for a grid param value ('0' = none). */
export function ticks(value: string, ctx: NoteScriptContext<ParamSpecs>): number {
  if (value === '0') return 0;
  if (value === 'snap') return ctx.grid > 1 ? ctx.grid : ctx.ppq / 4;
  if (value === 'bar') return ctx.bar;
  return Math.max(1, Math.round(ctx.ppq * (NOTE_VALUES[value as NoteValue] ?? 0.25)));
}

/** A small time amount as a note value, with "none" first. */
export const gapParam = (
  def: '0' | '1/64' | '1/32' | '1/16' | '1/8' | '1/4',
  label: string,
  none: string,
  hint: string,
) =>
  p.enum(['0', '1/64', '1/32', '1/16', '1/8', '1/4'], def, {
    label,
    labels: { ...VALUE_LABELS, '0': none },
    hint,
  });

/** A key as a note name ("C5" = 60, FL's octave numbering). */
const KEY_NAMES = Array.from({ length: 128 }, (_, k) => noteName(k));
export const noteParam = (def: number, label: string, hint: string) =>
  p.enum(KEY_NAMES, KEY_NAMES[def] as string, { label, hint });
export const keyOfName = (name: string) => Math.max(0, KEY_NAMES.indexOf(name));

export const seedParam = () =>
  p.int(1, 999, 1, { label: 'Seed', hint: 'Change the seed for a different random result' });

export const voicingParam = () =>
  p.enum(VOICINGS, 'close', {
    label: 'Voicing',
    labels: {
      close: 'Close (stacked)',
      open: 'Open (spread out)',
      drop2: 'Drop 2',
      drop3: 'Drop 3',
      bass: 'Close + bass note',
      spread: 'Open + bass note',
    },
    hint: 'How the chord notes are spread over the octaves',
  });

/** The song's key, or C major when none is set. */
export const keyOf = (ctx: NoteScriptContext<ParamSpecs>): KeyLike => ctx.key ?? { root: 0, scale: 'major' };

const ROOTS = ['song', ...PITCH_NAMES] as const;
export const rootParam = () =>
  p.enum(ROOTS, 'song', { label: 'Key root', labels: { song: 'Song key' }, hint: 'The scale’s root note' });
export const scaleParam = () =>
  p.enum(['song', ...SCALES.map((s) => s.id)], 'song', {
    label: 'Scale',
    labels: { song: 'Song key', ...Object.fromEntries(SCALES.map((s) => [s.id, s.label])) },
    hint: 'The scale to snap to ("Song key" uses the piano roll’s key)',
  });

/** A key from root/scale params that default to the song's key. */
export function chosenKey(ctx: NoteScriptContext<ParamSpecs>, root: string, scale: string): KeyLike {
  const song = keyOf(ctx);
  return {
    root: root === 'song' ? song.root : PITCH_NAMES.indexOf(root as (typeof PITCH_NAMES)[number]),
    scale: scale === 'song' ? song.scale : scale,
  };
}

/** Where generated notes go: the bars the notes cover, or the whole pattern when there are none (ticks). */
export function barSpan(ctx: NoteScriptContext<ParamSpecs>): { start: number; end: number } {
  const s = span(ctx.notes);
  if (!s) return { start: 0, end: ctx.length };
  return { start: Math.floor(s.start / ctx.bar) * ctx.bar, end: Math.ceil(s.end / ctx.bar) * ctx.bar };
}
