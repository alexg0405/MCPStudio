/** The lyrics lane's right-click menus: on a word, and on an empty spot. */
import { clearLyricTrack, deleteLyrics, joinLineAt, startLineAt } from '@app/lyrics/actions';
import type { Services } from '@app/services';
import { wordLabel } from '@core/lyrics/lines';
import type { LyricId, Tick } from '@core/model/types';
import { lyricLines } from '@core/query/lyrics';
import type { MenuEntry } from '../../controls/ContextMenu';
import { openWindow } from '../../workspace/registry';
import { pasteLyricsDialog } from './paste-dialog';

/** Right-click on a word. */
export function wordMenu(s: Services, id: LyricId, retype: () => void): MenuEntry[] {
  const project = s.doc.getState().project;
  const word = project.lyrics?.[id];
  if (!word) return [];
  const lines = lyricLines(project);
  const lineIndex = lines.findIndex((line) => line.words.some((entry) => entry.id === id));
  const isFirstOfLine = lines[lineIndex]?.words[0]?.id === id;
  return [
    { kind: 'label', label: `“${wordLabel(word)}”` },
    { label: 'Retype…', hint: 'Type another word over this one (or double-click it); beau-ti-ful makes three syllables that share its time', onSelect: retype },
    {
      label: 'Start a new line here',
      disabled: isFirstOfLine,
      hint: isFirstOfLine ? 'This word already starts its line' : 'The line breaks before this word (the Lyrics window and the exports show the break)',
      onSelect: () => startLineAt(s, id),
    },
    {
      label: 'Join this line to the one before',
      disabled: lineIndex <= 0,
      hint: lineIndex <= 0 ? 'This is the first line' : 'Make this line and the one before it a single line',
      onSelect: () => joinLineAt(s, id),
    },
    { kind: 'separator' },
    { label: 'Delete word', danger: true, onSelect: () => void deleteLyrics(s, [id]) },
  ];
}

/** Right-click on an empty spot of the lane. */
export function laneMenu(s: Services, tick: Tick, startTyping: () => void): MenuEntry[] {
  const hasLyrics = !!s.doc.getState().project.lyrics;
  return [
    { label: 'Add a word here…', hint: 'Type a word or syllable at this spot (or click the lane)', onSelect: startTyping },
    {
      label: 'Paste lyrics…',
      hint: 'Paste or type the words of a section: they are split into words and syllables and spread over the selected notes, a singer’s notes, or evenly from here',
      onSelect: () => void pasteLyricsDialog(s, { fromTick: tick }),
    },
    { label: 'Open the Lyrics window', hint: 'Big text that follows playback like karaoke, plus export as text or LRC', onSelect: () => void openWindow(s, 'lyrics') },
    { kind: 'separator' },
    { label: 'Hide the lyrics lane', onSelect: () => s.editor.getState().setLyricsLane(false) },
    {
      label: 'Clear the lyrics',
      danger: true,
      disabled: !hasLyrics,
      hint: hasLyrics ? 'Remove every word (one undo step)' : 'There are no lyrics',
      onSelect: () => void clearLyricTrack(s),
    },
  ];
}
