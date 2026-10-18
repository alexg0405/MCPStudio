/**
 * Reference track matching: the musician names a song they own as a reference (set_reference), and
 * match_reference shapes their own song after its measurements: tempo, key, section lengths and energy
 * arc, loudness and tonal balance. Only measurements cross over; the reference's melodies, chords and audio
 * never enter the song.
 */
import { current, isDraft } from 'immer';
import { inferStyle } from '@core/beat/style';
import type { ReferenceTrack, SampleRef } from '@core/model/types';
import { loudnessTarget, referenceFacts } from '@core/reference/track';
import { findSongs } from '../../dj/library';
import { sampleHash } from '../../dj/analyzer';
import { peekReference } from '../../reference/analyze';
import { clearReferenceInDraft, setReferenceInDraft } from '../../reference/doc';
import { matchInDraft } from '../../reference/match';
import * as S from '../schema/parts';
import { fail, type OpContext, type OpModule } from './context';
import type { AnswerState } from './context';
import type { ReferenceMatchOptions } from './types';
import { bool, str } from './values';

/** Whether this answer set a reference that is still to be analyzed after it. */
const analyzing = (state: AnswerState): boolean => state.bag.get('reference') === true;

const plainRef = (r: ReferenceTrack | undefined): ReferenceTrack | null => (r ? (isDraft(r) ? (current(r) as ReferenceTrack) : r) : null);

/** The song file a set_reference names: a library song, or a sample the project already has. */
function sourceOf(action: Record<string, unknown>, context: OpContext): { ref: SampleRef; title: string } | 'file' {
  const song = str(action.song);
  const sample = str(action.sample);
  if (song) {
    const { found } = findSongs([song]);
    const hit = found[0];
    if (!hit) return fail(`there is no song "${song}" in the music library (the musician adds songs in the DJ window, View → DJ mix → Add files)`);
    return { ref: hit.ref, title: hit.label };
  }
  if (sample) {
    const own = Object.values(context.project.samples).filter((x) => x.source.kind === 'embedded');
    const t = sample.toLowerCase();
    const hit = own.find((x) => x.id === sample) ?? own.find((x) => x.name.toLowerCase() === t) ?? (own.filter((x) => x.name.toLowerCase().includes(t)).length === 1 ? own.find((x) => x.name.toLowerCase().includes(t)) : undefined);
    if (!hit) return fail(`there is no song file called "${sample}" among this project's samples`);
    return { ref: hit as SampleRef, title: hit.name };
  }
  if (action.choose_file === true) return 'file';
  return fail('say where the reference comes from: song (a title from the music library), sample (a sample of the project), or choose_file (the musician picks a file)');
}

const optionsOf = (action: Record<string, unknown>): ReferenceMatchOptions => {
  const given = { tempo: bool(action.tempo), key: bool(action.key), arrangement: bool(action.arrangement), loudness: bool(action.loudness), tone: bool(action.tone) };
  const any = Object.values(given).some((v) => v !== undefined);
  // Nothing named: everything ("make it sound like my reference").
  const pick = (v: boolean | undefined) => (any ? v === true : true);
  return { tempo: pick(given.tempo), key: pick(given.key), arrangement: pick(given.arrangement), loudness: pick(given.loudness), tone: pick(given.tone) };
};

export const reference: OpModule = {
  schemas: [
    S.op(
      'set_reference',
      'Sets the reference song: a song the musician owns that their own song should be shaped after. It is analyzed (tempo, key, sections, energy, loudness, tonal balance) and only those measurements are kept. Give a song from the music library, a sample of the project, or ask for a file. One undo step with the answer.',
      {
        song: S.str('A song from <music-library> (its title or “Artist – Title”).'),
        sample: S.str('A song file among the project’s samples (its name or id).'),
        choose_file: S.bool('The musician is asked to choose an audio file (one click in the chat).'),
        clear: S.bool('Remove the reference.'),
      },
    ),
    S.op(
      'match_reference',
      'Shapes the musician’s own song after the reference’s measurements, in one undo step with the answer. Name what to match; with none named, all of it. tempo and key: the song’s tempo and key (pitched notes move to the key; drums stay); arrangement: the reference’s section lengths and energy arc, played by the musician’s own patterns (through the arranger); loudness: the master’s loudness to the reference’s LUFS; tone: listens to the mix and reports the bands more than 3 dB off the reference, with plain suggestions (nothing is changed).',
      {
        tempo: S.bool('Set the tempo to the reference’s.'),
        key: S.bool('Move the song into the reference’s key (and set the song key).'),
        arrangement: S.bool('Arrange the song with the reference’s section lengths and energy.'),
        loudness: S.bool('Level the mix so the master plays at the reference’s loudness.'),
        tone: S.bool('Compare the mix’s tonal balance with the reference’s and report the differences.'),
      },
    ),
  ],
  prompt: {
    id: 'reference',
    order: 26,
    text: `Reference track (set_reference, match_reference, get_reference):
- The musician can give a song they own as a REFERENCE: they drop a file on the Reference window (View → Reference), or it is a song of their music library or a sample of the project. The <reference> block in the project lists what it measured: tempo, key, sections as bar counts with energy, loudness (LUFS), true peak, tonal balance per band and stereo width. Use only those numbers.
- "Make it sound like my reference", "match my reference", "like that song": match_reference with nothing named (tempo, key, arrangement, loudness and tone all at once). A single wish matches only that: "same tempo and key" tempo and key; "same structure" arrangement; "as loud as" loudness; "same tone", "brighter/darker than my reference" tone, then fix the bands with the numbers it reports (an EQ band on the master, or the bus that carries it).
- With no reference set: set_reference first. With a song title from <music-library> use song; with a sample name use sample; when the musician has a file, set_reference with choose_file and tell them to pick it, then match on the next turn. A new reference is analyzed after your answer (a minute for a long song); match_reference in the same answer waits for it.
- Never copy the reference: no melodies, chords, drum patterns, samples or lyrics from it, and never place or play its audio. Its measurements steer tempo, key, section lengths, energy, loudness and tone only; the notes stay the musician's own. If they ask to copy the actual melody or chords, say you only use measurements and offer to write something new in the same key and tempo.
- match_reference arrangement needs patterns to arrange (a beat first for a new song) and replaces the song's arrangement (one undo step). It does not rebuild the mixer; leveling uses the master's Limiter, so set up the mix first when it has none.`,
  },
  handlers: {
    set_reference: (action, context) => {
      if (action.clear === true) return clearReferenceInDraft(context.draft) ? 'Cleared the reference' : 'There was no reference to clear';
      const src = sourceOf(action, context);
      if (src === 'file') {
        context.state.after.push({ kind: 'command', id: 'reference.chooseFile', gesture: true });
        return null;
      }
      const hash = sampleHash(src.ref);
      if (!hash) return fail('the reference must be a song file the musician added, not a built-in sound');
      const cached = peekReference(hash);
      if (cached) {
        const stored = setReferenceInDraft(context.draft, { ...cached, title: src.title }, src.ref);
        return `Reference set: “${src.title}” (${referenceFacts(stored).slice(0, 4).join(', ')})`;
      }
      context.state.bag.set('reference', true);
      context.state.after.push({ kind: 'set_reference', ref: src.ref, title: src.title });
      return `The reference “${src.title}” is analyzed after this answer`;
    },
    match_reference: (action, context) => {
      const o = optionsOf(action);
      const ref = plainRef(context.draft.reference);
      if (!ref && !analyzing(context.state))
        return fail('there is no reference song yet: set_reference first (a song of the music library or a sample), or choose_file to ask the musician for one');
      if (o.arrangement && context.focus.range()) fail('arranging like the reference reshapes the whole song: ask without a part of the song selected');
      if (!ref) {
        context.state.after.push({ kind: 'match_reference', options: o });
        return 'Matching the reference once it is analyzed';
      }
      const res = matchInDraft(context.draft, context.services, context.base, ref, { tempo: o.tempo, key: o.key, arrangement: o.arrangement }, (f, t, what) => context.focus.span(f, t, what));
      for (const w of res.warnings) context.warn(w);
      if (res.touched) {
        context.touch(res.touched.from, res.touched.to, res.clipIds);
        context.state.after.push({ kind: 'mode', mode: 'song' });
      }
      for (const line of res.changes) context.note(line);
      if (o.loudness) context.state.after.push({ kind: 'level_mix', style: inferStyle(context.project), targetLufs: loudnessTarget(ref) });
      if (o.tone) context.state.after.push({ kind: 'reference_tone' });
      return res.changes.length || res.warnings.length ? null : 'The song already matches the reference';
    },
  },
};
