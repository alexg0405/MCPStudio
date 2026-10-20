/**
 * "Make it sound like house": the drums are written again in the style's own grid (the song generator's drum patterns), the swing
 * and, when the tempo is far from the style's range, the tempo follow, and the 808 is written again to follow the new kick.
 * Sounds keep their instruments: a restyle changes how the song plays, not which plugins it uses.
 */
import type { Role } from '../../arrange/roles';
import { parsePrompt } from '../../beat/local/prompt';
import { GROOVE, STYLE_LABELS, TEMPO, type Style } from '../../beat/style';
import type { BeatTrack } from '../../beat/spec';
import type { ChannelId, PatternId } from '../../model/types';
import { songDrums, type DrumTier } from '../../song/drums';
import { channelsPlaying, insertNamed, patternParts, skippedLine, slotOf } from '../rule-kit';
import { patternBars, BASS_ROLES, type SongFacts } from '../song-facts';
import type { OfflineAction, Rule, RuleContext, RuleResult } from '../types';

const RESTYLE_WORDS = /\b(?:like|into|style|genre|vibe|feel|sound|sounds|version|switch|convert|restyle|turn it|make it|more of a|flavou?r|groove)\b/;
/** The drum roles a restyle writes again. */
const STYLED_ROLES: ReadonlySet<Role> = new Set<Role>(['kick', 'snare', 'clap', 'hat', 'open-hat', 'rim']);
/** Steps in a four-bar pattern of the grid (16 per bar). */
const GRID_STEPS = 64;
const LOFI_EFFECT = 'agstudio.lofi';

/** Which strength of the style's drums a pattern gets, from its name ("Intro" is light, "Chorus final" is peak). */
function tierOf(name: string): DrumTier {
  const lower = name.toLowerCase();
  if (/final|peak|last/.test(lower)) return 'peak';
  if (/build|rise|riser/.test(lower)) return 'build';
  if (/intro|break|bridge|verse|outro|calm|quiet/.test(lower)) return 'light';
  return 'full';
}

/** The grid track a channel of this role plays: a kick plays the kick, the backbeat plays the snare or the clap the style has. */
function trackFor(role: Role, tracks: readonly BeatTrack[]): BeatTrack | undefined {
  const bySound = (sound: string) => tracks.find((track) => track.sound === sound);
  switch (role) {
    case 'kick':
      return bySound('kick');
    case 'snare':
      return bySound('snare') ?? bySound('clap');
    case 'clap':
      return bySound('clap') ?? bySound('snare');
    case 'hat':
      return bySound('hat');
    case 'open-hat':
      return bySound('open-hat');
    case 'rim':
      return bySound('rim');
    default:
      return undefined;
  }
}

/** A four-bar grid track's notes laid over a pattern of any length (repeated, or cut short). */
function tiled(track: BeatTrack, bars: number): { step: number; len: number; vel?: number }[] {
  const lengthSteps = bars * 16;
  const notes: { step: number; len: number; vel?: number }[] = [];
  for (let offset = 0; offset < lengthSteps; offset += GRID_STEPS) {
    for (const note of track.notes) {
      const step = note.step + offset;
      if (step >= lengthSteps) continue;
      notes.push({ step, len: note.len ?? 1, ...(note.vel !== undefined ? { vel: note.vel } : {}) });
    }
  }
  return notes;
}

/** The tempo to move to when the song is far from the style's range; null when it already fits. */
function tempoFor(style: Style, bpm: number): number | null {
  const range = TEMPO[style];
  return bpm >= range.min && bpm <= range.max ? null : range.default;
}

function bassFollows(facts: SongFacts, parts: readonly { pattern: PatternId; channel: ChannelId }[]): OfflineAction[] {
  const hasChords = Object.keys(facts.project.chords ?? {}).length > 0;
  if (!hasChords) return [];
  return parts.map((part) => ({ op: 'bassline', pattern: part.pattern, channel: part.channel, style: '808' }));
}

function restyle(context: RuleContext): RuleResult {
  const { facts, scope, clause } = context;
  const style = parsePrompt(clause).style;
  if (!style) return { reply: 'Say which style: trap, drill, boom bap, lo-fi, house, EDM, trance, drum & bass, dubstep, future bass, reggaeton, afro or pop.' };
  const label = STYLE_LABELS[style];
  const drumChannels = channelsPlaying(facts, STYLED_ROLES).filter((id) => facts.roles.get(id) !== 'kit');
  const { parts, skipped } = patternParts(context, drumChannels);
  if (parts.length === 0) return { reply: `There are no drum parts in ${scope.isNamed ? scope.label : 'this song'} to restyle (a drum kit on one channel is not rewritten).${skippedLine(skipped)}` };
  const actions: OfflineAction[] = [];
  const said: string[] = [];
  if (!scope.isNamed) {
    const bpm = tempoFor(style, facts.project.transport.bpm);
    const swing = GROOVE[style].swing;
    actions.push({ op: 'song', ...(bpm !== null ? { bpm } : {}), swing });
    said.push(`swing ${Math.round(swing * 100)} %${bpm !== null ? `, tempo ${bpm} BPM` : ''}`);
  }
  const tracksByPattern = new Map<PatternId, BeatTrack[]>();
  const written: { pattern: PatternId; channel: ChannelId }[] = [];
  for (const part of parts) {
    const name = facts.project.patterns[part.pattern]?.name ?? '';
    if (!tracksByPattern.has(part.pattern)) {
      tracksByPattern.set(part.pattern, songDrums({ style, tier: tierOf(name), seed: context.seed, label: name, density: 0, noHats: false }));
    }
    const track = trackFor(facts.roles.get(part.channel) ?? 'other', tracksByPattern.get(part.pattern) ?? []);
    if (!track) continue;
    actions.push({ op: 'write_notes', pattern: part.pattern, channel: part.channel, replace: true, notes: tiled(track, patternBars(facts, part.pattern)) });
    written.push(part);
  }
  if (written.length === 0) return { reply: `The ${label} drums have no part for the drum channels here.` };
  said.unshift(`${written.length} drum ${written.length === 1 ? 'part' : 'parts'} in the ${label} grid`);
  const bass = channelsPlaying(facts, BASS_ROLES).filter((id) => facts.roles.get(id) === '808');
  const bassParts = patternParts(context, bass).parts;
  const following = bassFollows(facts, bassParts);
  if (following.length > 0) {
    actions.push(...following);
    said.push('the 808 follows the new kick');
  }
  if (style === 'lofi' && !scope.isNamed) {
    const chords = insertNamed(facts.project, 'Chords');
    if (chords && !slotOf(chords, LOFI_EFFECT)) {
      actions.push({ op: 'add_effect', insert: chords.id, plugin: LOFI_EFFECT, mix: 0.35 });
      said.push('a lo-fi effect on the Chords bus');
    }
  }
  return { message: `Restyled ${scope.isNamed ? scope.label : 'the song'} like ${label}: ${said.join(', ')}.${skippedLine(skipped)}`, actions };
}

/** "Make it sound like trap", "turn it into house", "a lo-fi version". */
export const RESTYLE_RULES: readonly Rule[] = [
  {
    id: 'restyle',
    matches: (_text, clause) => parsePrompt(clause).style !== undefined && RESTYLE_WORDS.test(clause),
    run: restyle,
  },
];
