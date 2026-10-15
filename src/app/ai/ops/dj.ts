/** DJ mixes: make one from the musician's music library (dj_mix), change one transition (dj_transition). */
import { current } from 'immer';
import type { DjMixOptions, Project } from '@core/model/types';
import { TRANSITION_RECIPES, type TransitionRecipe, type TransitionTweak } from '@core/dj/plan';
import { findSongs, library, mixSongOf, songsToMix } from '../../dj/library';
import { peekAnalysis } from '../../dj/analyzer';
import { currentMixSongs, DEFAULT_DJ_OPTIONS, mixInDraft, replanInDraft, type MixSong } from '../../dj/mix';
import * as S from '../schema/parts';
import { fail, type OpContext, type OpModule } from './context';
import { num, str } from './values';

const ENERGY = ['party', 'build', 'peak-time', 'chill'] as const;
const STYLE = ['auto', 'smooth', 'quick', 'cut'] as const;

function optionsOf(a: Record<string, unknown>, base: DjMixOptions): DjMixOptions {
  const pick = <T extends string>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
  const tempo = num(a.mix_tempo);
  const len = num(a.length_min);
  const o: DjMixOptions = {
    order: pick(a.order, ['auto', 'keep'], base.order),
    energy: pick(a.energy, ENERGY, base.energy),
    transition: pick(a.transition, STYLE, base.transition),
    mixTempo: tempo !== undefined ? Math.min(250, Math.max(50, tempo)) : a.mix_tempo === 'follow' ? 'follow' : base.mixTempo,
  };
  const target = len !== undefined ? (len > 0 ? Math.min(600, len) : undefined) : base.lengthTargetMin;
  if (target) o.lengthTargetMin = target;
  if (typeof a.key_lock === 'boolean' ? a.key_lock : base.keyLock) o.keyLock = true;
  return o;
}

const NO_MUSIC =
  'the music library is empty: the musician adds their own song files (MP3, AAC, WAV, FLAC) in the DJ window (View → DJ mix → Add files). Streaming services like Spotify can’t be mixed: their audio is locked';

/** The songs a dj_mix means: names from the library, the selection, the library, or the mix that is there. */
function songsFor(raw: unknown, c: OpContext): MixSong[] {
  const st = library.getState();
  if (Array.isArray(raw) && raw.length) {
    const names = raw.map(str).filter((x): x is string => !!x);
    const { found, missing } = findSongs(names);
    if (missing.length) c.warn(`dj_mix: not in the music library: ${missing.map((m) => `“${m}”`).join(', ')}`);
    if (!found.length) fail(`none of those songs is in the music library (${st.songs.length} songs there)`);
    return found.map(mixSongOf);
  }
  if (raw === 'selection') {
    if (!st.selected.length) fail('no songs are selected in the DJ window');
    return songsToMix(st).map(mixSongOf);
  }
  if (raw === 'library' || st.songs.length) {
    if (!st.songs.length) fail(NO_MUSIC);
    return songsToMix(raw === 'library' ? { ...st, selected: [] } : st).map(mixSongOf);
  }
  const mix = currentMixSongs(c.project);
  if (mix?.length) return mix;
  return fail(NO_MUSIC);
}

/** A song of the mix by its 1-based number or (part of) its title; its index. */
function mixIndex(p: Project, raw: unknown, what: string): number {
  const songs = p.dj?.songs ?? [];
  const n = num(raw) ?? (typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : undefined);
  if (n !== undefined) {
    if (n < 1 || n > songs.length) fail(`${what}: the mix has songs 1–${songs.length}`);
    return Math.round(n) - 1;
  }
  const t = str(raw)?.toLowerCase() ?? fail(`which song (${what})?`);
  const i = songs.findIndex((x) => x.title.toLowerCase() === t);
  if (i >= 0) return i;
  const partial = songs.map((x, k) => [x, k] as const).filter(([x]) => x.title.toLowerCase().includes(t));
  if (partial.length === 1) return partial[0]![1];
  return fail(`${what}: no song “${raw as string}” in the mix${partial.length > 1 ? ' (more than one matches)' : ''}`);
}

export const dj: OpModule = {
  schemas: [
    S.op(
      'dj_mix',
      'Makes a DJ mix of the musician’s own songs (the music library): orders them, beat-matches them and builds every transition on the playlist (decks, tempo, bass swaps, markers). Replaces the previous mix; one undo step.',
      {
        songs: {
          anyOf: [
            { type: 'array', items: { type: 'string' }, description: 'Song titles from the music library, in order (with order "keep").' },
            { type: 'string', enum: ['library', 'selection'] },
          ],
          description: 'Which songs: titles from <music-library>, "selection" (selected in the DJ window), "library" (every song). Leave out: the selection, else every song (else the songs of the mix that is there).',
        },
        order: { type: 'string', enum: ['auto', 'keep'], description: 'auto (default): by key, tempo and energy; keep: the order given (or the library order).' },
        energy: { type: 'string', enum: [...ENERGY], description: 'The energy shape: party (default: warm up, peak, breather, bigger peak), build (calm → hot), peak-time (hot throughout), chill (gentle, long blends).' },
        transition: { type: 'string', enum: [...STYLE], description: 'auto (default, per pair), smooth (32 bars), quick (8 bars), cut.' },
        mix_tempo: { anyOf: [{ type: 'number' }, { type: 'string', enum: ['follow'] }], description: '"follow" (default: each song at its own tempo, gliding in the transitions) or one BPM for the whole mix.' },
        length_min: S.num('Aim for about this many minutes (songs mix out earlier); 0 = every song plays through.'),
        key_lock: S.bool('Songs keep their pitch while the tempo glides (time-stretch). Off (default): turntable style, sample-exact beats, the pitch bends a little in transitions.'),
      },
    ),
    S.op(
      'dj_transition',
      'Changes one transition of the DJ mix (the songs keep their order; later songs move if it gets longer or shorter). One undo step.',
      {
        from_song: S.str('The outgoing song: its number in the mix (1-based) or title.'),
        to_song: S.str('The incoming song (default: the song after from_song).'),
        length_bars: S.int('How long both play together: 4, 8, 16 or 32 bars; 0 = a cut.'),
        recipe: { type: 'string', enum: [...TRANSITION_RECIPES], description: 'bass-swap (the default blend), filter (the outgoing song filters out: energy drops), echo (it stops on a downbeat with an echo), cut.' },
        riser: S.bool('A riser into the moment the next song takes over.'),
        reset: S.bool('Back to what the planner chose for this transition.'),
      },
      ['from_song'],
    ),
  ],
  prompt: {
    id: 'dj',
    order: 22,
    text: `DJ mixes (dj_mix, dj_transition):
- DJ mode mixes the musician's OWN song files (MP3, AAC/M4A, WAV, FLAC, OGG) from the music library (<music-library> lists them). Spotify, Apple Music, YouTube, SoundCloud and other streaming services can't be used: their audio is locked (DRM). Say so plainly when asked, and suggest adding their own files in the DJ window (View → DJ mix → Add files…).
- "Make a party mix", "mix these songs", "a 30-minute set", "DJ this": one dj_mix. Songs by their library titles (order "keep" to play them as given), or leave songs out for the DJ window's selection (else every song). Energy: party for parties, build for a warm-up, peak-time for a hot set, chill for background; length_min for a set length. It replaces the previous mix and opens it in song mode.
- "Smoother transition between song 3 and 4", "cut into the next song", "longer blend into X": dj_transition with from_song (and to_song) as numbers or titles: smoother = length_bars 32 with bass-swap, quicker = 8, a hard change = cut, an energy drop = filter, an echo stop = echo; riser: true for a build-up into a drop.
- The DJ mix section of the project lists the mix's songs with their BPM, key (Camelot) and start bar. Never build a DJ mix by hand (audio clips, automation): use these actions.`,
  },
  handlers: {
    dj_mix: (a, c) => {
      const songs = songsFor(a.songs, c);
      const options = optionsOf(a, c.project.dj?.options ?? DEFAULT_DJ_OPTIONS);
      if (Array.isArray(a.songs) && a.order === undefined) options.order = 'keep';
      const analyses = new Map(songs.flatMap((x) => {
        const an = peekAnalysis(c.s, x.ref);
        return an ? [[x.ref.id, an] as const] : [];
      }));
      c.state.after.push({ kind: 'mode', mode: 'song' }, { kind: 'open', window: 'playlist' });
      if (analyses.size < songs.length) {
        // Some songs need analyzing: that runs after the answer, in its undo step.
        c.state.after.push({ kind: 'dj_mix', songs, options });
        return `The mix of ${songs.length} songs is made after ${songs.length - analyses.size} of them are analyzed`;
      }
      const res = mixInDraft(c.d, c.s, songs, analyses, options);
      for (const w of res.warnings) c.warn(`dj_mix: ${w}`);
      c.touch(0, res.plan.totalTicks);
      return res.changes.join('; ');
    },
    dj_transition: (a, c) => {
      const p = current(c.d) as Project;
      if (!p.dj) fail('there is no DJ mix in this project yet (dj_mix makes one)');
      const from = mixIndex(p, a.from_song, 'from_song');
      const to = a.to_song !== undefined ? mixIndex(p, a.to_song, 'to_song') : from + 1;
      if (to !== from + 1 || to >= p.dj!.songs.length) fail('to_song must be the song right after from_song in the mix');
      const sampleId = p.dj!.songs[to]!.sampleId;
      let tweak: TransitionTweak | null = null;
      if (a.reset !== true) {
        tweak = {};
        const bars = num(a.length_bars);
        if (bars !== undefined) tweak.bars = Math.max(0, Math.min(64, Math.round(bars)));
        if (typeof a.recipe === 'string' && (TRANSITION_RECIPES as readonly string[]).includes(a.recipe)) tweak.recipe = a.recipe as TransitionRecipe;
        if (typeof a.riser === 'boolean') tweak.riser = a.riser;
        if (!Object.keys(tweak).length) fail('say what to change: length_bars, recipe, riser or reset');
      }
      let res: ReturnType<typeof replanInDraft>;
      try {
        res = replanInDraft(c.d, c.s, p, { tweaks: { [sampleId]: tweak } });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
      const t = res.plan.transitions[from]!;
      c.touch(Math.max(0, t.start - 2 * 3840), t.start + t.length + 3840);
      const names = `“${p.dj!.songs[from]!.title}” → “${p.dj!.songs[to]!.title}”`;
      return `Transition ${from + 1} (${names}): ${t.bars ? `${t.bars} bars, ` : ''}${t.recipe}${t.riser ? ' with a riser' : ''}${t.why ? ` (${t.why})` : ''}`;
    },
  },
};
