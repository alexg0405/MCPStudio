import { clearLyricTrack, copyLyrics, pasteLyrics, saveLyricsFile, type ActionResult } from '@app/lyrics/actions';
import type { Services } from '@app/services';
import { LYRIC_ALIGNS, type LyricAlign } from '@core/lyrics/plan';
import type { ChannelId, ClipId, Project } from '@core/model/types';
import { ticksPerBar } from '@core/time/ppq';
import { addActionProvider } from '../../shell/actions';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { addContextMenuItems } from '../../context-menus';
import { lazyWindow } from '../../workspace/lazy';
import { openWindow, registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { setWindowHelp } from '../../workspace/window-help';
import { pasteLyricsDialog } from './paste-dialog';

/** Shows what an action did as a toast. */
function report(services: Services, result: ActionResult): void {
  services.session.getState().toast(result.message, result.ok ? 'info' : 'error');
}

const hasLyrics = (s: Services) => !!s.doc.getState().project.lyrics;

/** Whether the lane is on screen right now (the musician's choice, else whether there are lyrics). */
function laneShown(s: Services): boolean {
  return s.editor.getState().lyricsLane ?? hasLyrics(s);
}

/** What `lyrics.paste` takes when it is given something to place. */
interface PasteArgs {
  text?: string;
  align?: LyricAlign;
  from_bar?: number;
  to_bar?: number;
  channel?: string;
  clip?: string;
  bars_per_line?: number;
}

/** A channel by id or exact name. */
function channelOf(project: Project, ref: string): ChannelId | undefined {
  if (project.channels[ref as ChannelId]) return ref as ChannelId;
  return project.channelOrder.find((id) => project.channels[id]?.name === ref);
}

/**
 * Lyrics: the lyrics lane above the playlist (words and syllables in song time), pasting a song's words over notes or a
 * sung clip, the Lyrics window that follows playback like karaoke, and export as text, LRC and MIDI lyric events.
 * Studio has the same through the `set_lyrics` and `clear_lyrics` actions and the `get_lyrics` read.
 */
export function register(services: Services): void {
  registerLyricsWindow(services);
  registerLyricsCommands(services);
  registerLyricsMenus();
  registerLyricsHelp();
}

/** The Lyrics window and the command that opens it. */
function registerLyricsWindow(services: Services): void {
  registerWindowType({
    type: 'lyrics',
    title: () => 'Lyrics',
    component: lazyWindow(() => import('./LyricsWindow'), (m) => m.LyricsWindow),
    defaultRect: (ws) => ({ x: Math.max(0, Math.round(ws.w / 2 - 340)), y: 56, w: Math.min(680, ws.w), h: Math.min(560, ws.h - 80) }),
    minSize: { w: 320, h: 220 },
  });
  registerWindowToggle(services, {
    command: 'view.lyrics',
    type: 'lyrics',
    title: 'Lyrics',
    hint: 'The lyrics as big text that follows the song like karaoke, for reading along while you record; paste lyrics and export them as text or LRC',
    chords: ['Alt+Shift+Y'],
    menuOrder: 61,
  });
}

/** Lane, paste, clear and the exports. */
function registerLyricsCommands({ commands }: Services): void {
  commands.register({
    id: 'lyrics.showLane',
    title: 'Show the lyrics lane',
    category: 'Lyrics',
    hint: 'The lyrics lane above the playlist: words and syllables over time, typed or dragged, lined up with the bars',
    checked: laneShown,
    run: (s) => s.editor.getState().setLyricsLane(!laneShown(s)),
  });
  commands.register<PasteArgs>({
    id: 'lyrics.paste',
    title: 'Paste lyrics…',
    category: 'Lyrics',
    hint: 'Type or paste the words of a section: lines, words and syllables (beau-ti-ful) are spread over the selected notes, the notes sung in a clip, or evenly, replacing the lyrics under them',
    argsHint:
      '{ text (lines of words; hyphens split syllables), from_bar (1-based), to_bar, align: notes | clip | even, channel (name or id: its notes carry the words), clip (audio clip id), bars_per_line }; without text it opens the dialog',
    run: async (s, args) => {
      if (!args?.text) {
        await pasteLyricsDialog(s);
        return;
      }
      const project = s.doc.getState().project;
      const barTicks = ticksPerBar(project.transport.timeSig);
      const channelId = args.channel ? channelOf(project, args.channel) : undefined;
      if (args.channel && !channelId) {
        s.session.getState().toast(`There is no channel “${args.channel}”.`, 'error');
        return;
      }
      const align: LyricAlign = args.align && LYRIC_ALIGNS.includes(args.align) ? args.align : args.clip ? 'clip' : channelId ? 'notes' : 'even';
      const result = await pasteLyrics(s, {
        text: args.text,
        align,
        fromTick: Math.max(0, Math.round(((args.from_bar ?? 1) - 1) * barTicks)),
        ...(args.to_bar !== undefined ? { toTick: Math.round(args.to_bar * barTicks) } : {}),
        ...(channelId ? { channelId } : {}),
        ...(args.clip ? { clipId: args.clip as ClipId } : {}),
        ...(args.bars_per_line !== undefined ? { barsPerLine: args.bars_per_line } : {}),
      });
      report(s, result);
      if (result.ok && s.editor.getState().lyricsLane === null) s.editor.getState().setLyricsLane(true);
    },
  });
  commands.register<{ from_bar?: number; to_bar?: number }>({
    id: 'lyrics.clear',
    title: 'Clear the lyrics',
    category: 'Lyrics',
    hint: 'Remove every word from the lyrics lane (one undo step)',
    argsHint: 'optional { from_bar, to_bar } (1-based, inclusive) to clear only those bars',
    enabled: hasLyrics,
    run: (s, args) => report(s, clearLyricTrack(s, args?.from_bar, args?.to_bar)),
  });
  commands.register({
    id: 'lyrics.exportText',
    title: 'Export lyrics as text…',
    category: 'Lyrics',
    hint: 'Save the lyrics as a .txt file, one line per lyric line (syllables joined into words)',
    enabled: hasLyrics,
    run: (s) => report(s, saveLyricsFile(s, 'text')),
  });
  commands.register<{ words?: boolean }>({
    id: 'lyrics.exportLrc',
    title: 'Export lyrics as LRC…',
    category: 'Lyrics',
    hint: 'Save the lyrics as an .lrc file: each line with the time it is sung, which music players show as karaoke',
    argsHint: 'optional { words: true } to also time every word and syllable (enhanced LRC)',
    enabled: hasLyrics,
    run: (s, args) => report(s, saveLyricsFile(s, args?.words ? 'lrc-words' : 'lrc')),
  });
  commands.register({
    id: 'lyrics.copy',
    title: 'Copy the lyrics',
    category: 'Lyrics',
    hint: 'Put the lyrics on the clipboard as plain text',
    enabled: hasLyrics,
    run: async (s) => report(s, await copyLyrics(s)),
  });
}

/** Playlist, File and piano-roll menu entries, and the action search. */
function registerLyricsMenus(): void {
  addMenuItems('playlist', [sep(44), cmd('lyrics.showLane', 45), cmd('lyrics.paste', 46), cmd('lyrics.clear', 47), sep(48)]);
  addMenuItems('file', [cmd('lyrics.exportText', 77), cmd('lyrics.exportLrc', 78)]);
  addContextMenuItems('pianoRoll.note', (_ctx, s) => [
    {
      label: 'Paste lyrics on these notes…',
      hint: 'Type or paste the words: one syllable goes on each selected note, in order',
      onSelect: () => void s.commands.run('lyrics.paste'),
    },
  ]);
  addContextMenuItems('pianoRoll.empty', (_ctx, s) => [
    { kind: 'label', label: 'Lyrics' },
    { label: 'Paste lyrics…', hint: 'Spread the words of a section over the notes you select, or evenly', onSelect: () => void s.commands.run('lyrics.paste') },
    { label: 'Open the Lyrics window', onSelect: () => void openWindow(s, 'lyrics') },
  ]);
  addActionProvider('lyrics', (s) => [
    {
      key: 'lyrics.open',
      label: 'Lyrics: type, paste, follow and export',
      path: ['View', 'Lyrics'],
      hint: 'Put the words of a song on a lane over time, show them under the notes, follow them like karaoke while recording, export as text or LRC',
      keywords: ['lyrics', 'words', 'syllables', 'karaoke', 'lrc', 'sing', 'text', 'vocal', 'prompter'],
      run: () => openWindow(s, 'lyrics'),
    },
  ]);
}

/** What the window help panel says. */
function registerLyricsHelp(): void {
  setWindowHelp('lyrics', {
    intro: 'The words of the song as big text that follows playback, so you can read along while you record. The words live on the lyrics lane above the playlist.',
    moves: [
      ['Paste lyrics', 'One line per line; beau-ti-ful splits into syllables. They go on the notes you selected in the piano roll, on the notes sung in an audio clip, or evenly over bars'],
      ['The lyrics lane', 'Click to type a word, drag across to set its length, drag a word to move it, drag its edges to resize, double-click to retype, right-click for more'],
      ['Follow', 'The word being sung fills with colour and the line stays in the middle while the song plays (turn it off to scroll by hand)'],
      ['A− and A+', 'Make the text smaller or bigger'],
      ['Save text and Save LRC', 'Export the lyrics as plain text, or as an LRC file with the time of each line for music players'],
      ['MIDI export', 'File › Export song as MIDI includes the lyrics as lyric events on their own track'],
      ['In the editors', 'The piano roll writes each word under its note, and the pitch editor under the note it sits on'],
      ['Studio', 'Ask “put these lyrics on the lead melody from bar 5” and Studio places them in one undo step'],
    ],
  });
}
