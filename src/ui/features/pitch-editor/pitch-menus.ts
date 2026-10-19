/** The Pitch editor's menus: the right-click menu of a note (or of the empty grid) and the toolbar's "More" menu. */
import { clearClipPitch, mergeAt, moveNotes, renderNow, resetNotes, setNoteSettings, snapClip, splitAt } from '@app/actions/pitch';
import { pitchState, type ClipPitch } from '@app/pitch/state';
import type { Services } from '@app/services';
import { isNeutralEdit } from '@core/audio/pitch-edit';
import type { ClipId, PitchEdit } from '@core/model/types';
import type { MenuEntry } from '../../controls/ContextMenu';

/** Which notes an action applies to: the given indices, or all of them. */
export type NoteSelection = ReadonlySet<number> | 'all';

/** One octave, in semitones. */
const SEMITONES_PER_OCTAVE = 12;

/** The notes a menu action works on: the selection if there is one, else the note under the pointer, else every note. */
function targetNotes(selected: readonly number[], underPointer: number): NoteSelection {
  if (selected.length) return new Set(selected);
  return underPointer >= 0 ? new Set([underPointer]) : 'all';
}

/** The entries of the right-click menu on a note (`noteIndex` is 0 or more) or on empty grid (`noteIndex` is -1). */
export function noteMenuEntries(services: Services, clip: ClipPitch, noteIndex: number, atMs: number): MenuEntry[] {
  const { selected, keyRoot, keyScale, strength } = pitchState.getState();
  const key = { root: keyRoot, scale: keyScale };
  if (noteIndex < 0) {
    return [
      { label: 'Snap all to key', hint: 'Moves every note to the nearest note of the chosen key', onSelect: () => snapClip(services, clip, key, strength) },
      { label: 'Reset all notes', onSelect: () => resetNotes(services, clip, 'all') },
    ];
  }
  const which = targetNotes(selected, noteIndex);
  const moveTargets = selected.length ? selected : [noteIndex];
  return [
    { label: 'Split here', shortcut: 'S', hint: 'Cuts the note in two where you clicked', onSelect: () => splitAt(services, clip, atMs / 1000) },
    { label: 'Merge with the next note', shortcut: 'M', hint: 'Joins this note and the one after it', onSelect: () => mergeAt(services, clip, noteIndex) },
    { kind: 'separator' },
    { label: 'Snap to key', hint: 'Moves the note to the nearest note of the chosen key (at the Strength set in the toolbar)', onSelect: () => snapClip(services, clip, key, strength, which) },
    { label: 'Up a semitone', shortcut: '↑', onSelect: () => moveNotes(services, clip, moveTargets, 1) },
    { label: 'Down a semitone', shortcut: '↓', onSelect: () => moveNotes(services, clip, moveTargets, -1) },
    { label: 'Up an octave', onSelect: () => moveNotes(services, clip, moveTargets, SEMITONES_PER_OCTAVE) },
    { label: 'Down an octave', onSelect: () => moveNotes(services, clip, moveTargets, -SEMITONES_PER_OCTAVE) },
    { kind: 'separator' },
    { label: 'Flatten drift', hint: 'Takes the slow wandering out of the note’s pitch', onSelect: () => setNoteSettings(services, clip, which, { drift: 1 }, 'Flatten drift') },
    { label: 'Remove vibrato', hint: 'Takes the wobble out of the note', onSelect: () => setNoteSettings(services, clip, which, { vibrato: 0 }, 'Remove vibrato') },
    { label: 'Reset note', shortcut: 'Del', hint: 'Puts the note back as it was sung', onSelect: () => resetNotes(services, clip, which) },
  ];
}

/** What the toolbar's "More ▾" menu needs to know. */
interface MoreMenuInput {
  services: Services;
  clip: ClipPitch | null;
  clipId: ClipId | null;
  edit: PitchEdit | undefined;
  selected: readonly number[];
  /** The notes found and the clip ready (analysis done, at least one note). */
  isReady: boolean;
  /** The selection as the toolbar acts on it: the selected notes, or all of them. */
  which: NoteSelection;
}

/** The entries of the toolbar's "More ▾" menu: merge, reset, render again, remove all correction. */
export function moreMenuEntries({ services, clip, clipId, edit, selected, isReady, which }: MoreMenuInput): MenuEntry[] {
  const hasCorrection = !!edit && !isNeutralEdit(edit);
  return [
    {
      label: 'Merge selected note with the next',
      hint: 'Joins a note and the one after it into one (M)',
      disabled: !isReady || selected.length === 0,
      onSelect: () => clip && mergeAt(services, clip, selected[0] as number),
    },
    {
      label: 'Reset selected notes',
      hint: 'Puts the selected notes (or all of them when none is selected) back as sung (Delete)',
      disabled: !isReady,
      onSelect: () => clip && resetNotes(services, clip, which),
    },
    { kind: 'separator' },
    {
      label: 'Render the corrected audio now',
      hint: 'Makes the corrected audio again (it normally follows every change by itself)',
      disabled: !hasCorrection,
      onSelect: () => clipId && renderNow(clipId),
    },
    {
      label: 'Remove all pitch correction',
      hint: 'The clip plays its own audio again (one undo step)',
      danger: true,
      disabled: !edit,
      onSelect: () => clipId && clearClipPitch(services, clipId),
    },
  ];
}
