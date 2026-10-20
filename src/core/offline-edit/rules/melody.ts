/**
 * "A new melody for the chorus", "write a different hook": the song generator's melody writer (`core/song/melody`) makes the lead
 * again from the chord track with a new motif seed, so the new line still sits on the chords. Each lead pattern in the part is
 * written with `write_notes`, which keeps undo, the focus guard and the follow-up variations working as for any other edit.
 */
import { DEFAULT_ENERGY, isPeak, type SectionRole } from '../../arrange/sections';
import { inferStyle } from '../../beat/style';
import { keyMode } from '../../harmony/scale';
import { harmonyKey } from '../../harmony/key';
import type { PatternId, Project } from '../../model/types';
import { patternChords } from '../../query/chords';
import { makeSongMotifs, songMelody, type MelodyPlan } from '../../song/melody';
import { PROFILES } from '../../song/profiles';
import type { PlacedChord, SongKey } from '../../song/types';
import { TICKS_PER_STEP } from '../../time/ppq';
import { channelsPlaying, patternParts, skippedLine, type PatternPart } from '../rule-kit';
import { clipsIn, patternBars, type SongFacts } from '../song-facts';
import { readScope } from '../scope';
import type { OfflineAction, Rule, RuleContext, RuleResult, Scope, SectionInfo } from '../types';

const NEW_MELODY =
  /\b(?:(?:new|different|fresh|another|better|catchier|alternative|alternate|bigger)\s+(?:\w+\s+){0,2}(?:melody|melodies|hook|lead|tune|topline|top line|riff|motif|line)|(?:rewrite|re-?write|redo|re-?do|regenerate|replace|change|rework|re-?make|remake|reroll|re-?roll)\s+(?:the\s+|this\s+)?(?:\w+\s+){0,2}(?:melody|melodies|hook|lead|tune|topline|top line|riff|line)|write (?:me )?(?:a |another |the )?(?:new )?(?:melody|hook|lead|tune|riff|topline)|make (?:a |another )?(?:new |different )?(?:melody|hook|tune)|(?:melody|hook|lead|tune|topline) (?:is |sounds )?(?:boring|bland|dull|meh|too plain)|(?:melody|hook|lead|tune|topline)(?: again| differently| another way))\b/;

/** "the verse melody", "chorus lead": a section named by the kind of line it plays. */
const SECTION_LINE = /\b(verse|chorus|hook|drop|bridge|intro|outro|pre-?chorus)\s+(?:melody|melodies|lead|line|topline|tune|riff)\b/;

/** The scale steps' register shift applies in whole octaves so the new line stays where the instrument was played. */
const OCTAVE = 12;
/** Bars of one melody block: the generator writes four-bar phrases. */
const BLOCK_BARS = 4;

/** Which of the generator's melodies a section plays. */
function planFor(section: SectionInfo | undefined, facts: SongFacts): MelodyPlan {
  const role = section?.role;
  if (!section || !role) return 'hook';
  const sameRole = facts.sections.filter((other) => (isPeak(other.role as SectionRole) ? isPeak(role as SectionRole) : other.role === role));
  const position = sameRole.indexOf(section);
  if (isPeak(role as SectionRole)) {
    if (sameRole.length > 1 && position === sameRole.length - 1) return 'hookFinal';
    return position > 0 ? 'hook2' : 'hook';
  }
  if (role === 'verse') return position > 0 ? 'verse2' : 'verse';
  if (role === 'bridge' || role === 'break' || role === 'pre') return 'bridge';
  if (role === 'intro' || role === 'outro') return 'teaser';
  return 'verse2';
}

/** The section a pattern first plays in inside the ranges. */
function sectionOfPattern(context: RuleContext, pattern: PatternId): SectionInfo | undefined {
  const { facts, scope } = context;
  const clip = clipsIn(facts, scope.ranges.length > 0 ? scope.ranges : [{ fromBar: 1, toBar: facts.totalBars }]).find((x) => x.patternId === pattern);
  if (!clip) return undefined;
  const bar = Math.round(clip.start / facts.barTicks) + 1;
  return facts.sections.find((section) => bar >= section.range.fromBar && bar <= section.range.toBar);
}

/** The song key as the generator reads it. */
function songKeyOf(project: Project, facts: SongFacts): SongKey {
  const key = project.transport.key ?? harmonyKey(project, facts.roles);
  return { root: key.root, minor: keyMode(key.scale) === 'minor' };
}

/** The chords of a four-bar block of a pattern as the generator places them (steps from the block's start). */
function blockChords(project: Project, pattern: PatternId, block: number, barTicks: number): PlacedChord[] {
  const blockTicks = BLOCK_BARS * barTicks;
  const from = block * blockTicks;
  const placed: PlacedChord[] = [];
  for (const entry of patternChords(project, pattern)) {
    const start = Math.max(entry.tick, from);
    const end = Math.min(entry.tick + entry.length, from + blockTicks);
    if (end <= start) continue;
    placed.push({ step: (start - from) / TICKS_PER_STEP, length: (end - start) / TICKS_PER_STEP, chord: entry.chord });
  }
  return placed;
}

const average = (values: readonly number[]): number => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);

interface WrittenLine {
  action: OfflineAction;
  notes: number;
}

/** A new melody for one lead part of one pattern, or null when the pattern has no chords to write it on. */
function newLine(context: RuleContext, part: PatternPart, motifs: ReturnType<typeof makeSongMotifs>, key: SongKey): WrittenLine | null {
  const { facts } = context;
  const project = facts.project;
  const style = inferStyle(project);
  const profile = PROFILES[style];
  const section = sectionOfPattern(context, part.pattern);
  const plan = planFor(section, facts);
  const energy = DEFAULT_ENERGY[(section?.role as SectionRole | undefined) ?? 'hook'] ?? 4;
  const bars = patternBars(facts, part.pattern);
  const blocks = Math.ceil(bars / BLOCK_BARS);
  const notes: { step: number; len: number; key: number; vel: number }[] = [];
  let previousChords: PlacedChord[] = [];
  for (let block = 0; block < blocks; block++) {
    let chords = blockChords(project, part.pattern, block, facts.barTicks);
    if (chords.length === 0) chords = previousChords;
    if (chords.length === 0) return null;
    previousChords = chords;
    const line = songMelody({ plan, key, chords, profile, motifs, seed: context.seed + block * 7919, energy });
    for (const note of line) notes.push({ step: note.step + block * BLOCK_BARS * 16, len: note.len ?? 1, key: note.key ?? 60, vel: note.vel ?? 0.8 });
  }
  const lengthSteps = (bars * facts.barTicks) / TICKS_PER_STEP;
  const kept = notes.filter((note) => note.step < lengthSteps);
  if (kept.length === 0) return null;
  // Keep the instrument where it was played: the new line moves by whole octaves to the old line's middle.
  const before = Object.values(project.patterns[part.pattern]?.notes[part.channel] ?? {}).map((note) => note.key);
  const shift = before.length > 0 ? Math.round((average(before) - average(kept.map((note) => note.key))) / OCTAVE) * OCTAVE : 0;
  const moved = kept.map((note) => ({ step: note.step, len: note.len, key: note.key + shift, vel: note.vel }));
  return { action: { op: 'write_notes', pattern: part.pattern, channel: part.channel, replace: true, notes: moved }, notes: moved.length };
}

/** The scope a request that names only "the hook" or "the verse melody" means: that kind of section. */
function scopeForLine(context: RuleContext, clause: string): Scope {
  const { facts, scope } = context;
  if (scope.isNamed) return scope;
  const word = SECTION_LINE.exec(clause)?.[1] ?? (/\bhook\b/.test(clause) ? 'hook' : null);
  if (!word) return scope;
  const read = readScope(`in the ${word}`, facts, null);
  return read.missing ? scope : read.scope;
}

function newMelody(context: RuleContext): RuleResult {
  const { facts } = context;
  const scope = scopeForLine(context, context.input.text.toLowerCase());
  const scoped: RuleContext = { ...context, scope };
  const leads = channelsPlaying(facts, new Set(['lead', 'pluck'] as const));
  const { parts, skipped } = patternParts(scoped, leads);
  if (parts.length === 0) {
    return { reply: `There is no lead melody playing in ${scope.isNamed ? scope.label : 'this song'}, so there is nothing to rewrite.${skippedLine(skipped)}` };
  }
  const key = songKeyOf(facts.project, facts);
  const style = inferStyle(facts.project);
  const motifs = makeSongMotifs(PROFILES[style], context.seed);
  const lines: WrittenLine[] = [];
  for (const part of parts) {
    const line = newLine(scoped, part, motifs, key);
    if (line) lines.push(line);
  }
  if (lines.length === 0) return { reply: 'The song has no chords to write a melody on yet. Ask for new chords first, or have the chords read from the song ("detect the chords").' };
  const where = scope.isNamed ? scope.label : 'the song';
  const count = lines.length;
  return {
    message: `Wrote a new melody for ${where} (${count} ${count === 1 ? 'pattern' : 'patterns'}), on the chords of the chord track. Ask again for another.${skippedLine(skipped)}`,
    actions: lines.map((line) => line.action),
  };
}

/** "A new melody", "different hook for the chorus". */
export const MELODY_RULES: readonly Rule[] = [{ id: 'new-melody', matches: (_text, clause) => NEW_MELODY.test(clause), run: newMelody }];
