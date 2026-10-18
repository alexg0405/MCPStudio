/** The chord lane's right-click menus: on a chord, and on an empty spot. */
import { addChordAt, clearChordTrack, deleteChord, nextChordSuggestions, splitChordAt } from '@app/harmony/chord-track';
import { detectChords } from '@app/harmony/detect';
import type { Services } from '@app/services';
import { formatChord, qualityOf, type ChordSymbol } from '@core/harmony/chord';
import type { ChordId, Tick } from '@core/model/types';
import { editChord, symbolOf } from '@core/ops/chords';
import { projectUsesFlats } from '@core/query/chords';
import { ticksPerBar } from '@core/time/ppq';
import type { MenuEntry } from '../../controls/ContextMenu';
import { openWindow } from '../../workspace/registry';

/** Qualities offered under "Change to": the ones songs are mostly made of. */
const COMMON_QUALITIES = ['maj', 'min', '7', 'maj7', 'm7', 'sus2', 'sus4', 'add9', '9', 'dim', 'm7b5', 'aug'] as const;

/** Ideas for the chord that could start at `tick`, each adding that chord there (a bar long). */
function nextIdeas(s: Services, tick: Tick, length: Tick): MenuEntry[] {
  const flats = projectUsesFlats(s.doc.getState().project);
  return nextChordSuggestions(s, tick).map((idea): MenuEntry => ({
    label: `${formatChord(idea.chord, flats)}  ${idea.roman}`,
    hint: `${idea.reason} (${idea.function === 'other' ? 'borrowed' : idea.function})`,
    onSelect: () => void addChordAt(s, tick, length, idea.chord),
  }));
}

/** Right-click on a chord. */
export function chordMenu(s: Services, id: ChordId, tick: Tick, retype: () => void): MenuEntry[] {
  const project = s.doc.getState().project;
  const event = project.chords?.[id];
  if (!event) return [];
  const flats = projectUsesFlats(project);
  const symbol = symbolOf(event);
  const bar = ticksPerBar(project.transport.timeSig);
  const canSplit = tick > event.tick && tick < event.tick + event.length;
  return [
    { kind: 'label', label: `${formatChord(symbol, flats)}: ${qualityOf(event.quality).label}` },
    { label: 'Retype…', hint: 'Type a new chord name over this one (or double-click it)', onSelect: retype },
    {
      kind: 'submenu',
      label: 'Change to',
      hint: 'Keep the root, change the kind of chord',
      items: () =>
        COMMON_QUALITIES.map((quality): MenuEntry => {
          const next: ChordSymbol = { root: event.root, quality, ...(event.bass !== undefined ? { bass: event.bass } : {}) };
          return {
            label: `${formatChord(next, flats)}  ${qualityOf(quality).label}`,
            checked: event.quality === quality,
            onSelect: () => s.history.transact('Edit chord', (draft) => editChord(draft, id, next)),
          };
        }),
    },
    {
      label: 'Split in two here',
      disabled: !canSplit,
      hint: canSplit ? 'Cut this chord at the pointer so each half can change' : 'Right-click inside the chord, away from its edges',
      onSelect: () => splitChordAt(s, id, tick),
    },
    {
      kind: 'submenu',
      label: 'Chord ideas to follow it',
      hint: 'Chords that fit after this one in the song key, ranked by how well they lead on',
      items: () => nextIdeas(s, event.tick + event.length, Math.min(event.length, bar)),
    },
    { kind: 'separator' },
    {
      label: 'Delete chord',
      danger: true,
      onSelect: () => deleteChord(s, id),
    },
  ];
}

/** Right-click on an empty spot of the lane. */
export function laneMenu(s: Services, tick: Tick, startTyping: () => void): MenuEntry[] {
  const project = s.doc.getState().project;
  const hasChords = !!project.chords;
  const bar = ticksPerBar(project.transport.timeSig);
  return [
    { label: 'Add a chord here…', hint: 'Type a chord name at this spot (or click the lane)', onSelect: startTyping },
    {
      kind: 'submenu',
      label: 'Chord ideas here',
      hint: 'Chords that fit at this spot in the song key, from the chord before it',
      items: () => nextIdeas(s, Math.floor(tick / bar) * bar, bar),
    },
    { kind: 'separator' },
    {
      label: 'Detect chords from the song',
      hint: 'Read the chords the chord, pad, keys and bass parts play and fill the chord track',
      onSelect: () => void detectChords(s).then((result) => s.session.getState().toast(result.message, result.ok ? 'info' : 'error')),
    },
    { label: 'Open the Chords window', hint: 'Progressions, detection, and writing chords, a bassline and a melody from the chord track', onSelect: () => void openWindow(s, 'chords') },
    { kind: 'separator' },
    { label: 'Hide the chord lane', onSelect: () => s.editor.getState().setChordLane(false) },
    {
      label: 'Clear the chord track',
      danger: true,
      disabled: !hasChords,
      hint: hasChords ? 'Remove every chord (one undo step)' : 'The chord track is empty',
      onSelect: () => void clearChordTrack(s),
    },
  ];
}
