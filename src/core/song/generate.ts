/**
 * The offline song generator, version 2: a request becomes a whole song with no model call. It picks a progression for the
 * style and mood and lays it on the chord track, voices the chords, writes a bass from them (an 808 on the kick for trap, an
 * offbeat bass for trance, rolling 16ths for house), builds a melody from a two-bar motif that is stated, answered and
 * developed, takes the drums from the style's grooves, and arranges all of it in sections. The planner of `core/arrange`
 * then adds the fills, transitions and FX, and the mix setup balances it (both run when the plan is applied).
 *
 * Deterministic: the same request and seed give the same song; another seed gives another progression, motif and groove.
 */
import type { ShapeSection } from '../arrange/shapes';
import { GROOVE, STYLE_LABELS } from '../beat/style';
import { formatChord, keyUsesFlats } from '../harmony/chord';
import type { BeatSpec, BeatTrack } from '../beat/spec';
import { energyFactor, makeBand, scaleVelocities, type BandKind } from './bands';
import { songCounter } from './colour';
import { chooseHarmony, PATTERN_BARS, type HarmonyKind, type SongHarmony } from './harmony';
import { makeSongMotifs, songMelody, type MelodyPlan, type SongMotifs } from './melody';
import { PROFILES, type StyleProfile } from './profiles';
import { readSongRequest } from './request';
import { sectionsFor } from './shape';
import type { ChordLine, PlacedChord, SongPattern, SongPlan, SongRequest, SongSection } from './types';

/** The plan of a pattern: what it is called, what kind it is, which chord loop it plays over and how to build its tracks. */
interface PatternRecipe {
  title: string;
  kind: SongPattern['kind'];
  loop: HarmonyKind;
  tracks: (chords: readonly PlacedChord[], energy: number) => BeatTrack[];
}

/** What the generator knows while it builds one song. */
interface Context {
  request: SongRequest;
  profile: StyleProfile;
  harmony: SongHarmony;
  motifs: SongMotifs;
}

/** The band recipes by pattern reference. */
const BANDS: Record<string, { title: string; band: BandKind; loop: HarmonyKind }> = {
  '@intro': { title: 'Intro', band: 'intro', loop: 'verse' },
  '@verse': { title: 'Verse', band: 'verse', loop: 'verse' },
  '@build': { title: 'Build', band: 'build', loop: 'build' },
  '@chorus': { title: 'Chorus', band: 'chorus', loop: 'chorus' },
  '@chorus-final': { title: 'Chorus final', band: 'chorusFinal', loop: 'chorus' },
  '@break': { title: 'Break', band: 'break', loop: 'break' },
};

/** The melody recipes by pattern reference. */
const MELODIES: Record<string, { title: string; plan: MelodyPlan; loop: HarmonyKind; counter: boolean }> = {
  '@verse-melody': { title: 'Verse melody', plan: 'verse', loop: 'verse', counter: false },
  '@verse-melody-2': { title: 'Verse melody 2', plan: 'verse2', loop: 'verse', counter: false },
  '@hook': { title: 'Hook', plan: 'hook', loop: 'chorus', counter: false },
  '@hook-2': { title: 'Hook 2', plan: 'hook2', loop: 'chorus', counter: true },
  '@hook-final': { title: 'Hook final', plan: 'hookFinal', loop: 'chorus', counter: true },
  '@bridge-melody': { title: 'Bridge melody', plan: 'bridge', loop: 'break', counter: false },
};

/** The recipe of a pattern reference. */
function recipeFor(ref: string, context: Context): PatternRecipe {
  const { request, profile, motifs } = context;
  const band = BANDS[ref];
  if (band) {
    return {
      title: band.title,
      kind: 'band',
      loop: band.loop,
      tracks: (chords, energy) => makeBand({ kind: band.band, request, profile, chords, motifs, energy }),
    };
  }
  const melody = MELODIES[ref] as (typeof MELODIES)[string];
  return {
    title: melody.title,
    kind: 'melody',
    loop: melody.loop,
    tracks: (chords, energy) => {
      const lead = songMelody({
        plan: melody.plan,
        key: request.key,
        chords,
        profile,
        motifs,
        seed: request.seed,
        energy,
      });
      const tracks: BeatTrack[] = [{ name: 'Lead', sound: profile.lead.sound, notes: lead }];
      if (melody.counter && profile.colour === 'counter') {
        tracks.push({ name: 'Counter', sound: profile.lead.sound, notes: songCounter(chords, lead, 0.62) });
      }
      for (const track of tracks) scaleVelocities(track, energyFactor(energy));
      return tracks;
    },
  };
}

/** The patterns each section plays and the parts it leaves out; `seen` counts the sections of each kind so far. */
function playFor(entry: ShapeSection, seen: Record<string, number>): { play: string[]; without: string[] } {
  const without = [...(entry.without ?? [])];
  const turn = seen[entry.role] ?? 0;
  seen[entry.role] = turn + 1;
  const keepsMusic = !without.includes('music');
  switch (entry.role) {
    case 'intro':
    case 'outro':
      return { play: [keepsMusic ? '@intro' : '@verse'], without };
    case 'verse':
      return { play: ['@verse', turn === 0 ? '@verse-melody' : '@verse-melody-2'], without };
    case 'pre':
    case 'build':
      return { play: ['@build'], without };
    case 'break':
    case 'bridge': {
      // A break that keeps its drums (it leaves out only the kick, say) plays the groove band; the others play the quiet one.
      const keepsDrums = without.length > 0 && !without.includes('drums');
      return { play: [keepsDrums ? '@verse' : '@break', '@bridge-melody'], without };
    }
    default: {
      const peak =
        turn === 0 ? ['@chorus', '@hook'] : turn === 1 ? ['@chorus', '@hook-2'] : ['@chorus-final', '@hook-final'];
      return { play: peak, without };
    }
  }
}

/** The chord loop a section plays over, by what its first pattern is. */
function loopOfSection(play: readonly string[], context: Context): HarmonyKind {
  return recipeFor(play[0] as string, context).loop;
}

/** The chord names of the whole song, a name for each bar with a dot where the chord holds. */
function chordLineOf(sections: readonly SongSection[], loops: readonly HarmonyKind[], context: Context): ChordLine {
  const { key } = context.request;
  const flats = keyUsesFlats(key.root, key.minor ? 'minor' : 'major');
  const names: string[] = [];
  let previous = '';
  sections.forEach((entry, index) => {
    const loop = context.harmony.loops[loops[index] as HarmonyKind];
    for (let bar = 0; bar < entry.bars; bar++) {
      const step = (bar % PATTERN_BARS) * 16;
      const placed =
        loop.find((chord) => step >= chord.step && step < chord.step + chord.length) ?? (loop[0] as PlacedChord);
      const name = formatChord(placed.chord, flats);
      names.push(name === previous ? '.' : name);
      previous = name;
    }
  });
  return { text: names.join(' | '), barsPerChord: 1 };
}

/** The sentence that says what was made. */
function messageOf(plan: Omit<SongPlan, 'message'>, bars: number): string {
  const { request, key } = plan;
  const flats = keyUsesFlats(key.root, key.minor ? 'minor' : 'major');
  const tonic = formatChord({ root: key.root, quality: key.minor ? 'min' : 'maj' }, flats).replace(/m$/, '');
  const seconds = Math.round((bars * 240) / plan.bpm);
  const length = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const sections = plan.sections.map((entry) => `${entry.name} ${entry.bars}`).join(' · ');
  const styleName = STYLE_LABELS[request.style].replace(' and riddim', '').toLowerCase();
  return `Wrote ${article(request.mood)} ${request.mood} ${styleName} song in ${tonic} ${key.minor ? 'minor' : 'major'} at ${plan.bpm} BPM, ${bars} bars (about ${length}). Chords: ${plan.progression.name}. ${sections}.`;
}

const article = (word: string): string => (/^[aeiou]/.test(word) ? 'an' : 'a');

/** Builds a whole song from a request. */
export function generateSong(request: SongRequest): SongPlan {
  const profile = PROFILES[request.style];
  const harmony = chooseHarmony(request);
  const motifs = makeSongMotifs(profile, request.seed);
  const context: Context = { request, profile, harmony, motifs };
  const shape = sectionsFor(request.style, request.bars);
  const seen: Record<string, number> = {};
  const sections: SongSection[] = shape.map((entry) => ({
    name: entry.name,
    role: entry.role,
    bars: entry.bars,
    energy: entry.energy,
    ...playFor(entry, seen),
  }));
  const loops = sections.map((entry) => loopOfSection(entry.play, context));
  const patterns: SongPattern[] = [];
  for (const entry of sections) {
    for (const ref of entry.play) {
      if (patterns.some((pattern) => pattern.ref === ref)) continue;
      const recipe = recipeFor(ref, context);
      const chords = harmony.loops[recipe.loop];
      const spec: BeatSpec = {
        title: recipe.title,
        bars: PATTERN_BARS,
        style: request.style,
        tracks: recipe.tracks(chords, entry.energy),
      };
      patterns.push({ ref, spec, chords: [...chords], kind: recipe.kind });
    }
  }
  const bars = sections.reduce((sum, entry) => sum + entry.bars, 0);
  const plan: Omit<SongPlan, 'message'> = {
    title: `${STYLE_LABELS[request.style]} song`,
    request,
    style: request.style,
    bpm: request.bpm,
    swing: GROOVE[request.style].swing,
    key: request.key,
    progression: { id: harmony.progression.id, name: harmony.progression.name },
    patterns,
    sections,
    chordLine: chordLineOf(sections, loops, context),
  };
  return { ...plan, message: messageOf(plan, bars) };
}

/** Reads a request in words and builds the song (the seed is the words unless another is given). */
export function generateSongFromPrompt(prompt: string, options: { seed?: number; variation?: number } = {}): SongPlan {
  return generateSong(readSongRequest(prompt, options));
}
