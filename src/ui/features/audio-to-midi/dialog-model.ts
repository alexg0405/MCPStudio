/**
 * The "Convert to MIDI" dialog as plain data: the choices it offers (grids, instruments), which controls each mode shows, and
 * how its state turns into the settings and the request the app runs. No React, so it is unit tested.
 */
import type { ConvertSpec, TranscribeTarget } from '@app/transcribe/convert';
import { GRID_CHOICES, gridIdOfTicks } from '@app/transcribe/grids';
import { settingsFor, type Articulation, type TranscribeMode, type TranscribeSettings } from '@core/audio/transcribe';
import { COMP_RHYTHMS, type CompRhythm } from '@core/harmony/voicing';
import type { ChannelId, ClipId, Project } from '@core/model/types';

export { GRID_CHOICES, gridIdOfTicks };

/** Everything the dialog lets the musician set. */
export interface DialogState {
  mode: TranscribeMode;
  /** True while the mode is the suggestion nobody has changed: the dialog follows a new suggestion when it arrives. */
  modeIsSuggested: boolean;
  sensitivity: number;
  gridId: string;
  /** 0–100 */
  strength: number;
  swing: 'straighten' | 'keep';
  articulation: Articulation;
  legatoGapMs: number;
  keepCents: boolean;
  chordResolution: TranscribeSettings['chordResolution'];
  chordRhythm: CompRhythm;
  chordBass: boolean;
  fillChordTrack: boolean;
  /** `new` + `plugin` (a plugin id, '' = the mode's suggestion), or an existing channel. */
  target: { kind: 'new'; plugin: string } | { kind: 'channel'; channel: ChannelId | '' };
  place: boolean;
  muteOriginal: boolean;
  slicePads: boolean;
}

/** The state a dialog opens with for a mode. */
export function initialState(mode: TranscribeMode = 'melody'): DialogState {
  const defaults = settingsFor(mode);
  return {
    mode,
    modeIsSuggested: true,
    sensitivity: Math.round(defaults.sensitivity * 100),
    gridId: gridIdOfTicks(defaults.quantize.gridTicks),
    strength: Math.round(defaults.quantize.strength * 100),
    swing: defaults.quantize.swing,
    articulation: defaults.articulation,
    legatoGapMs: defaults.legatoGapMs,
    keepCents: defaults.keepCents,
    chordResolution: defaults.chordResolution,
    chordRhythm: defaults.chordRhythm,
    chordBass: defaults.chordBass,
    fillChordTrack: true,
    target: { kind: 'new', plugin: '' },
    place: true,
    muteOriginal: false,
    slicePads: true,
  };
}

/** The settings the planner reads, from the dialog's state. */
export function settingsOf(state: DialogState): TranscribeSettings {
  const grid = GRID_CHOICES.find((g) => g.id === state.gridId) ?? (GRID_CHOICES[3] as (typeof GRID_CHOICES)[number]);
  return settingsFor(state.mode, {
    sensitivity: state.sensitivity / 100,
    quantize: { gridTicks: grid.ticks, strength: state.strength / 100, swing: state.swing },
    articulation: state.articulation,
    legatoGapMs: state.legatoGapMs,
    keepCents: state.keepCents,
    chordResolution: state.chordResolution,
    chordRhythm: state.chordRhythm,
    chordBass: state.chordBass,
    fillChordTrack: state.mode === 'chords' && state.fillChordTrack,
  });
}

/** The request the app runs, or a plain-words problem (an existing-channel target with no channel chosen). */
export function specOf(clip: ClipId, state: DialogState): ConvertSpec | { problem: string } {
  let target: TranscribeTarget;
  if (state.target.kind === 'channel') {
    if (!state.target.channel) return { problem: 'Choose the channel to write the notes to.' };
    target = { kind: 'channel', channel: state.target.channel };
  } else target = { kind: 'new', ...(state.target.plugin ? { plugin: state.target.plugin } : {}) };
  return { clip, settings: settingsOf(state), target, place: state.place, muteOriginal: state.muteOriginal, slicePads: state.slicePads };
}

/** Which groups of controls a mode uses. */
export interface ModeFields {
  /** Melody and bass: the note ends (legato, natural, staccato) and the cents. */
  noteEnds: boolean;
  /** Chords: how finely to look, how to play them, the bass note, the chord track. */
  chords: boolean;
  /** Drums, with a new channel: use the recording's own hits on the pads. */
  pads: boolean;
  /** Everything but chords listens with a sensitivity. */
  sensitivity: boolean;
}

/** The controls a mode shows. */
export function fieldsFor(mode: TranscribeMode, state: Pick<DialogState, 'target'>): ModeFields {
  return {
    noteEnds: mode === 'melody' || mode === 'bass',
    chords: mode === 'chords',
    pads: mode === 'drums' && state.target.kind === 'new',
    sensitivity: mode !== 'chords',
  };
}

/** How each way of ending notes is named. */
export const ARTICULATIONS: readonly { id: Articulation; label: string; hint: string }[] = [
  { id: 'natural', label: 'As played', hint: 'Each note lasts as long as you hear it' },
  { id: 'legato', label: 'Legato', hint: 'Short gaps between notes are closed, so each note runs into the next' },
  { id: 'staccato', label: 'Staccato', hint: 'Each note is cut to half its length' },
];

/** How finely chords are read. */
export const CHORD_RESOLUTIONS: readonly { id: TranscribeSettings['chordResolution']; label: string }[] = [
  { id: 'beat', label: 'Every beat' },
  { id: 'half', label: 'Every half bar' },
  { id: 'bar', label: 'Every bar' },
];

/** How a chord is played, in words. */
export const RHYTHM_LABELS: Readonly<Record<CompRhythm, string>> = {
  hold: 'Held for the whole chord',
  beats: 'On every beat',
  offbeats: 'On the off-beats',
  eighths: 'Every eighth note',
};

/** The rhythms in the order the menu lists them. */
export const RHYTHMS: readonly CompRhythm[] = COMP_RHYTHMS;

/** The instrument channels of the project, for "an existing channel". */
export function instrumentChannels(project: Project): { id: ChannelId; name: string }[] {
  return project.channelOrder.flatMap((id) => {
    const channel = project.channels[id];
    return channel?.kind === 'instrument' ? [{ id, name: channel.name }] : [];
  });
}
