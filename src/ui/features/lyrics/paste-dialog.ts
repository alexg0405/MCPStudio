/** The "Paste lyrics…" dialog: the words, where to put them (on notes, on a singer's notes, or evenly) and from which bar. */
import { pianoRollSlots } from '@app/lyrics/slots';
import { pasteLyrics } from '@app/lyrics/actions';
import { songPosition } from '@app/actions/markers';
import type { Services } from '@app/services';
import type { LyricAlign } from '@core/lyrics/plan';
import type { Tick } from '@core/model/types';
import { ticksPerBar } from '@core/time/ppq';
import { showFormDialog } from '../../controls/FormDialog';

/** What the dialog starts from. */
export interface PasteDialogOptions {
  /** Where the lyrics start (default: the song position). */
  fromTick?: Tick;
  /** The words already typed (the Lyrics window passes what it has). */
  text?: string;
}

/** The layout the dialog offers first: the selected notes, else the selected audio clip, else even spacing. */
function defaultAlign(s: Services): LyricAlign {
  if (pianoRollSlots(s)?.isSelection) return 'notes';
  const project = s.doc.getState().project;
  const hasAudioClip = [...s.editor.getState().clipSelection].some((id) => project.playlist.clips[id]?.kind === 'audio');
  return hasAudioClip ? 'clip' : 'even';
}

/** The first bar of the selected audio clip (where its singing starts), else the given tick's bar. */
function startBar(s: Services, fromTick: Tick, align: LyricAlign): number {
  const project = s.doc.getState().project;
  const barTicks = ticksPerBar(project.transport.timeSig);
  if (align === 'clip') {
    const clip = [...s.editor.getState().clipSelection].map((id) => project.playlist.clips[id]).find((c) => c?.kind === 'audio');
    if (clip) return Math.floor(clip.start / barTicks) + 1;
  }
  return Math.floor(fromTick / barTicks) + 1;
}

/** Asks for the lyrics and where they go, then places them (one undo step) and says what happened. */
export async function pasteLyricsDialog(s: Services, options: PasteDialogOptions = {}): Promise<void> {
  const align = defaultAlign(s);
  const fromTick = options.fromTick ?? songPosition(s);
  const values = await showFormDialog({
    title: 'Paste lyrics',
    message:
      'One lyric line per line. Hyphens split syllables: beau-ti-ful is three. The words are spread over the notes you choose and replace any lyrics under them.',
    fields: [
      { kind: 'text', key: 'text', label: 'Lyrics', multiline: true, placeholder: 'What a beau-ti-ful day\nThe sun is shi-ning' },
      {
        kind: 'choice',
        key: 'align',
        label: 'Put them',
        options: [
          { value: 'notes', label: 'on the notes selected in the piano roll (one syllable per note)' },
          { value: 'clip', label: 'on the notes sung in the selected audio clip' },
          { value: 'even', label: 'evenly from the bar below (one line per bar)' },
        ],
      },
      { kind: 'number', key: 'bar', label: 'From bar', min: 1, max: 9999, step: 1 },
      { kind: 'number', key: 'barsPerLine', label: 'Bars per line (evenly)', min: 0.25, max: 16, step: 'any' },
    ],
    values: { text: options.text ?? '', align, bar: startBar(s, fromTick, align), barsPerLine: 1 },
    okLabel: 'Place lyrics',
  });
  if (!values) return;
  const chosen = values.align as LyricAlign;
  const barTicks = ticksPerBar(s.doc.getState().project.transport.timeSig);
  const result = await pasteLyrics(s, {
    text: String(values.text),
    align: chosen,
    fromTick: Math.max(0, Math.round((Number(values.bar) - 1) * barTicks)),
    barsPerLine: Number(values.barsPerLine),
  });
  s.session.getState().toast(result.message, result.ok ? 'info' : 'error');
  if (result.ok && s.editor.getState().lyricsLane === null) s.editor.getState().setLyricsLane(true);
}
