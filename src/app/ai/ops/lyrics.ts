/**
 * Lyrics actions: `set_lyrics` puts lyrics on the lyrics lane (on a channel's notes, on the notes sung in an audio clip,
 * or evenly over bars) and `clear_lyrics` removes them. They use the same planner as the "Paste lyrics…" dialog
 * (`core/lyrics/plan.ts`), reading a snapshot of the draft so notes written earlier in the same answer are seen.
 */
import { current } from 'immer';
import { describePlan, LYRIC_ALIGNS, planLyrics, type LyricAlign } from '@core/lyrics/plan';
import type { ClipId, Project, Tick } from '@core/model/types';
import { clearLyrics, placeLyricWords } from '@core/ops/lyrics';
import { lastLineNumber } from '@core/query/lyrics';
import { barSpan } from '@core/time/bars';
import { channelSongSlots, clipSungSlotsNow } from '../../lyrics/slots';
import * as S from '../schema/parts';
import { fail, type OpContext, type OpModule } from './context';
import { num, str } from './values';

/** The project as plain data (a snapshot of the draft). */
const snapshot = (context: OpContext): Project => current(context.draft) as Project;

/** Which layout the action asks for: `align`, else notes for a channel, the sung notes for a clip, evenly otherwise. */
function alignOf(action: Record<string, unknown>): LyricAlign {
  const text = str(action.align)?.toLowerCase();
  if (text !== undefined) return LYRIC_ALIGNS.find((align) => align === text) ?? fail(`align must be one of ${LYRIC_ALIGNS.join(', ')}`);
  if (action.clip !== undefined) return 'clip';
  if (action.channel !== undefined) return 'notes';
  return 'even';
}

/** The slots of the notes the layout uses, or a failure that says what is missing. */
function slotsFor(action: Record<string, unknown>, context: OpContext, align: LyricAlign, from: Tick, to: Tick | undefined) {
  if (align === 'even') return [];
  const project = snapshot(context);
  if (align === 'notes') {
    const channelId = context.channel(action.channel ?? fail('align notes needs channel (the instrument whose notes carry the words)'));
    return channelSongSlots(project, channelId, from, to);
  }
  const clipId = (str(action.clip) ?? fail('align clip needs clip (the id of the audio clip with the singing)')) as ClipId;
  const clip = project.playlist.clips[clipId];
  if (clip?.kind !== 'audio') fail(`there is no audio clip "${clipId}"`);
  return clipSungSlotsNow(project, clipId) ?? fail('that clip’s sung notes are not known yet: analyse it first (the pitch action, or open it in the Pitch editor)');
}

function setLyrics(action: Record<string, unknown>, context: OpContext): string {
  const text = str(action.text) ?? fail('set_lyrics needs text (lines of words; "beau-ti-ful" is three syllables)');
  const bar = context.bar();
  const fromBar = num(action.from_bar) ?? 1;
  const from = Math.max(0, Math.round(fromBar - 1) * bar);
  const toBar = num(action.to_bar);
  const to = toBar !== undefined ? Math.round(toBar) * bar : undefined;
  const align = alignOf(action);
  const barsPerLine = num(action.bars_per_line);
  const plan = planLyrics({
    text,
    align,
    fromTick: from,
    barTicks: bar,
    slots: slotsFor(action, context, align, from, to),
    firstLine: lastLineNumber(snapshot(context)) + 1,
    ...(to !== undefined ? { toTick: to } : {}),
    ...(barsPerLine !== undefined ? { barsPerLine } : {}),
  });
  if (plan.words.length === 0) fail(describePlan(plan, align).replace(/^No lyrics placed: /, '').replace(/\.$/, ''));
  const end = Math.max(...plan.words.map((word) => word.tick + word.length));
  const start = Math.min(...plan.words.map((word) => word.tick));
  context.focus.span(start, end, 'set lyrics');
  placeLyricWords(context.draft, plan.words, { replaceSpan: true });
  context.touch(start, end);
  return `Lyrics ${barSpan(start, end, context.draft.transport.timeSig)}: ${describePlan(plan, align).replace(/^Placed /, 'placed ')}`;
}

function clearTrack(action: Record<string, unknown>, context: OpContext): string {
  const bar = context.bar();
  const fromBar = num(action.from_bar);
  const from = fromBar !== undefined ? Math.max(0, Math.round(fromBar - 1) * bar) : undefined;
  const toBar = num(action.to_bar);
  const to = from !== undefined ? Math.round(toBar ?? fromBar!) * bar : undefined;
  context.focus.span(from ?? 0, to ?? Number.POSITIVE_INFINITY, 'clear lyrics');
  const removed = clearLyrics(context.draft, from, to);
  if (removed === 0 && from === undefined) fail('there are no lyrics');
  return `Removed ${removed} lyric word${removed === 1 ? '' : 's'}${from !== undefined ? ` (${barSpan(from, to!, context.draft.transport.timeSig)})` : ''}`;
}

export const lyrics: OpModule = {
  schemas: [
    S.op(
      'set_lyrics',
      'Puts lyrics on the lyrics lane from a bar, replacing the lyrics under them. text is the words, one lyric line per line; "beau-ti-ful" is three syllables. align: notes puts one syllable on each note of channel from from_bar (notes with no word stay empty, extra words are left out and reported); clip puts them on the notes sung in the audio clip (analysed first); even spreads them evenly, one line per bar (or bars_per_line), or all between from_bar and to_bar.',
      {
        text: S.str('The lyrics, lines separated by newlines (hyphens split syllables).'),
        from_bar: S.num('The 1-based bar where the lyrics start (fractions allowed; default 1).'),
        to_bar: S.num('The last bar (inclusive): even spreads all the words between from_bar and it; notes and clip ignore notes after it.'),
        align: { type: 'string', enum: [...LYRIC_ALIGNS], description: 'notes, clip or even (default: notes when channel is given, clip when clip is, else even).' },
        channel: S.CHANNEL,
        clip: S.str('align clip: the audio clip id (clip_…).'),
        bars_per_line: S.num('align even without to_bar: bars one line takes (default 1).'),
      },
      ['text'],
    ),
    S.op('clear_lyrics', 'Removes the lyrics, or only those in from_bar–to_bar.', {
      from_bar: S.num('The 1-based first bar to clear (default: all lyrics).'),
      to_bar: S.num('The 1-based last bar (inclusive; default: the same bar).'),
    }),
  ],
  prompt: {
    id: 'lyrics',
    order: 34,
    text: 'Lyrics: set_lyrics puts words on the lyrics lane from a bar, on the notes of a channel, on a sung clip’s notes or evenly (get_lyrics reads them back); clear_lyrics removes them.',
  },
  handlers: {
    set_lyrics: setLyrics,
    clear_lyrics: clearTrack,
  },
};
