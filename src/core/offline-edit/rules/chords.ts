/**
 * "Change the chords", "darker chords in bars 9–16", "use seventh chords": a new progression of the palette in the song key goes
 * on the chord track (the `chords` action), then the parts that follow the chord track are written again on it: the chord parts
 * keep their rhythm and register, the bass follows the kick, the leads are moved onto the new chord tones.
 */
import { mulberry32 } from '../../arrange/random';
import type { Role } from '../../arrange/roles';
import { inferStyle } from '../../beat/style';
import { formatChord, type ChordSymbol } from '../../harmony/chord';
import { harmonyKey, keyForMode } from '../../harmony/key';
import { PROGRESSIONS, progressionChords, type Mood, type Progression } from '../../harmony/progressions';
import { keyMode } from '../../harmony/scale';
import { projectUsesFlats, chordsBetween } from '../../query/chords';
import { symbolOf } from '../../ops/chords';
import { harmonyVoices } from '../../query/harmony-voices';
import { PROFILES } from '../../song/profiles';
import type { ChannelId, Note } from '../../model/types';
import { channelsPlaying, patternParts, skippedLine, type PatternPart } from '../rule-kit';
import { BASS_ROLES, CHORD_ROLES, LEAD_ROLES, patternBars, rangeTicks, type SongFacts } from '../song-facts';
import type { OfflineAction, Rule, RuleContext, RuleResult } from '../types';

const CHANGE_CHORDS =
  /\b(?:(?:change|swap|switch|replace|rewrite|re-?write|redo|re-?do|rework|alter|re-?harmoni[sz]e|try)\s+(?:up\s+)?(?:the\s+|these\s+|my\s+)?(?:\w+\s+){0,2}(?:chords?|progression|harmony|changes)|(?:new|different|another|fresh|better|other|alternative)\s+(?:\w+\s+){0,2}(?:chords?|progression|harmony|chord changes)|(?:chords?|progression|harmony)\s+(?:are |is |sound |sounds )?(?:boring|bland|dull|too plain|too simple|different|again)|(?:make|turn|give)\s+(?:the\s+)?(?:chords?|progression|harmony)\s+(?:a bit |a little |much |more )?(?:darker|brighter|sadder|happier|jazzier|moodier|richer|fuller|sweeter|dreamier|warmer|softer|different|sadder|more (?:jazzy|emotional|dramatic|uplifting|sad|dark|happy|chill|interesting|complex))|(?:use|add|with)\s+(?:some\s+)?(?:seventh|sevenths|7th|7ths|jazz|jazzy)\b|(?:darker|brighter|sadder|happier|jazzier|moodier|richer|fuller|sweeter|dreamier|warmer|more (?:jazzy|emotional|dramatic|interesting|complex)) (?:chords?|progression|harmony)|re-?harmoni[sz]e|jazz(?:y|ier) chords|(?:more|add) (?:jazzy|jazz) (?:chords|harmony)|(?:make|turn|give|get) (?:it|this|the (?:song|track|mood)) (?:a bit |a little |much |way |more )?(?:darker|sadder|brighter|happier|moodier|dreamier|more (?:dark|sad|happy|uplifting|emotional|dramatic|chill|epic)))\b/;

/** What the words say the new chords should feel like. */
function moodIn(text: string): Mood | null {
  if (/\b(?:darker|dark|moodier|moody|eerie|ominous|tense)\b/.test(text)) return 'dark';
  if (/\b(?:sadder|sad|melancholy|melancholic|emotional)\b/.test(text)) return 'sad';
  if (/\b(?:brighter|bright|happier|happy|sunnier|cheerful)\b/.test(text)) return 'happy';
  if (/\b(?:uplifting|hopeful|bigger|euphoric|anthemic)\b/.test(text)) return 'uplifting';
  if (/\b(?:chill|mellow|relaxed|calm|smooth)\b/.test(text)) return 'chill';
  if (/\b(?:dreamy|floaty|airy)\b/.test(text)) return 'dreamy';
  if (/\b(?:epic|cinematic|dramatic)\b/.test(text)) return 'epic';
  return null;
}

/** The chord names of a progression in a key, as the chord track would show them. */
function namesOf(progression: Progression, facts: SongFacts): string[] {
  const key = keyForMode(harmonyKey(facts.project, facts.roles, progression.mode), progression.mode);
  const flats = projectUsesFlats(facts.project);
  return progressionChords(progression, key).map((slot) => formatChord(slot.chord, flats));
}

/** The first chord names of what the chord track plays inside the part now (to avoid picking the same progression again). */
function currentNames(facts: SongFacts, from: number, to: number): string[] {
  const flats = projectUsesFlats(facts.project);
  const names: string[] = [];
  for (const entry of chordsBetween(facts.project, from, to)) {
    const chord: ChordSymbol = symbolOf(entry);
    const name = formatChord(chord, flats);
    if (names[names.length - 1] !== name) names.push(name);
  }
  return names;
}

/** The palette progression that fits the words best, and is not what is playing there now. */
function pickProgression(context: RuleContext, mood: Mood | null, wantsJazz: boolean): Progression {
  const { facts } = context;
  const key = harmonyKey(facts.project, facts.roles);
  const mode = keyMode(key.scale);
  const span = rangeTicks(facts, context.scope.ranges[0] ?? { fromBar: 1, toBar: Math.max(1, facts.totalBars) });
  const now = currentNames(facts, span.from, span.to).slice(0, 4).join(' ');
  const genres = PROFILES[inferStyle(facts.project)].genres;
  const random = mulberry32(context.seed);
  const scored = PROGRESSIONS.filter((progression) => progression.mode === mode)
    .map((progression) => {
      let score = random() * 2;
      if (mood && (progression.moods as readonly string[]).includes(mood)) score += 4;
      if (wantsJazz && (progression.genres as readonly string[]).includes('jazz')) score += 3;
      for (const genre of genres) if ((progression.genres as readonly string[]).includes(genre)) score += 1.2;
      const names = namesOf(progression, facts).slice(0, 4).join(' ');
      if (names === now) score -= 10;
      return { progression, score };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored[0]?.progression;
  return best ?? (PROGRESSIONS.find((progression) => progression.mode === mode) as Progression);
}

type CompRhythm = 'hold' | 'beats' | 'offbeats' | 'eighths';
type Register = 'low' | 'mid' | 'high';

/** The rhythm of a chord part as `voice_chords` knows it: how often it strikes and whether it plays the off-beats. */
function rhythmOf(notes: readonly Note[], bars: number): CompRhythm {
  const onsets = [...new Set(notes.map((note) => note.tick))];
  if (onsets.length === 0) return 'hold';
  const offbeats = onsets.filter((tick) => tick % 960 === 480).length;
  if (offbeats / onsets.length >= 0.5) return 'offbeats';
  const perBar = onsets.length / Math.max(1, bars);
  if (perBar <= 1.5) return 'hold';
  return perBar <= 5 ? 'beats' : 'eighths';
}

/** Where on the keyboard a chord part sits. */
function registerOf(notes: readonly Note[]): Register {
  if (notes.length === 0) return 'mid';
  const middle = notes.reduce((sum, note) => sum + note.key, 0) / notes.length;
  if (middle < 56) return 'low';
  return middle > 70 ? 'high' : 'mid';
}

/** The actions that write one part again on the new chords. */
function rewriteActions(context: RuleContext, parts: readonly PatternPart[]): OfflineAction[] {
  const { facts } = context;
  const actions: OfflineAction[] = [];
  for (const part of parts) {
    const role = facts.roles.get(part.channel);
    const notes = Object.values(facts.project.patterns[part.pattern]?.notes[part.channel] ?? {}) as Note[];
    if (role && CHORD_ROLES.has(role)) {
      actions.push({
        op: 'voice_chords',
        pattern: part.pattern,
        channel: part.channel,
        register: registerOf(notes),
        rhythm: rhythmOf(notes, patternBars(facts, part.pattern)),
      });
    } else if (role && BASS_ROLES.has(role)) {
      actions.push({ op: 'bassline', pattern: part.pattern, channel: part.channel, style: role === '808' ? '808' : 'roots' });
    } else if (role && LEAD_ROLES.has(role)) {
      actions.push({ op: 'fit_melody', pattern: part.pattern, channel: part.channel, strength: 1 });
    }
  }
  return actions;
}

/** The roles of the parts that follow the chord track. */
const FOLLOWERS: ReadonlySet<Role> = new Set([...CHORD_ROLES, ...BASS_ROLES, ...LEAD_ROLES]);

function changeChords(context: RuleContext): RuleResult {
  const { facts, scope, text, clause } = context;
  if (facts.totalBars === 0) return { reply: 'The playlist is empty: there is no song to change the chords of yet.' };
  const mood = moodIn(clause);
  const wantsJazz = /\bjazz/.test(clause);
  const sevenths = wantsJazz || /\b(?:seventh|sevenths|7th|7ths)\b/.test(text);
  const progression = pickProgression(context, mood, wantsJazz);
  const names = namesOf(progression, facts);
  const actions: OfflineAction[] = scope.ranges.map((range) => ({
    op: 'chords',
    action: 'progression',
    progression: progression.id,
    from_bar: range.fromBar,
    bars: range.toBar - range.fromBar + 1,
    ...(sevenths ? { sevenths: true } : {}),
  }));
  const channels: ChannelId[] = channelsPlaying(facts, FOLLOWERS);
  const { parts, skipped } = patternParts(context, channels);
  const rewrites = rewriteActions(context, parts);
  actions.push(...rewrites);
  if (harmonyVoices(facts.project).length > 0) actions.push({ op: 'update_harmonies' });
  const followed = rewrites.length > 0 ? ` and wrote the chord parts, the bass and the lead again on them (${rewrites.length} ${rewrites.length === 1 ? 'part' : 'parts'})` : '';
  const key = harmonyKey(facts.project, facts.roles);
  return {
    message: `Changed the chords in ${scope.label} to ${progression.name} in ${keyMode(key.scale)} (${names.slice(0, 4).join(' | ')})${sevenths ? ' with seventh chords' : ''}${followed}.${skippedLine(skipped)}`,
    actions,
  };
}

/** "Change the chords", "darker chords", "use seventh chords". */
export const CHORD_RULES: readonly Rule[] = [{ id: 'change-chords', matches: (_text, clause) => CHANGE_CHORDS.test(clause), run: changeChords }];
