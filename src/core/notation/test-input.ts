/** Helpers for the notation tests: notes written in 1/16 steps, and a short way to engrave and print them. */
import type { ChannelId, NoteId } from '../model/types';
import { engrave } from './engrave';
import { formatNotation } from './text';
import type { EngraveInput, NotationNote, Score } from './types';

/** A note at `step` (1/16 steps) of `steps` long; `key` is a MIDI key. */
export function note(step: number, steps: number, key: number, id = `n_${step}_${key}`): NotationNote {
  return { id: id as NoteId, channelId: 'ch_test' as ChannelId, tick: Math.round(step * 240), length: Math.round(steps * 240), key, velocity: 0.8 };
}

/** A note placed by ticks. */
export function noteAt(tick: number, length: number, key: number, id = `n_${tick}_${key}`): NotationNote {
  return { id: id as NoteId, channelId: 'ch_test' as ChannelId, tick, length, key, velocity: 0.8 };
}

/** The default input: 4/4, 120 bpm, 1/16 grid, no key. */
export function input(notes: NotationNote[], extra: Partial<EngraveInput> = {}): EngraveInput {
  return {
    notes,
    isPercussion: false,
    lengthTicks: 3840,
    timeSig: { num: 4, den: 4 },
    bpm: 120,
    grid: '1/16',
    clef: 'auto',
    ...extra,
  };
}

/** Engraves notes with the default input. */
export function score(notes: NotationNote[], extra: Partial<EngraveInput> = {}): Score {
  return engrave(input(notes, extra));
}

/** The bars of a score as the compact text, without the header line. */
export function bars(notes: NotationNote[], extra: Partial<EngraveInput> = {}): string {
  return formatNotation(score(notes, extra), { header: false, barsPerLine: 100 });
}
