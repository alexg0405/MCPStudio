/**
 * Adding a part to the song: a breakdown, a build, a drop, an outro. The part is made from bars that are already there (the
 * drums leave, the hats double, a crash and a riser mark the entry) with the arranger's own variations and transitions, and a
 * marker names it; an outro is new bars after the song's end, laid out by the arranger. Nothing is deleted.
 */
import { isPeak, roleFromName, type SectionRole } from '../../arrange/sections';
import { patternsIn, sourceOf, type SongFacts } from '../song-facts';
import { describeRange } from '../song-facts';
import type { BarRange, OfflineAction, Rule, RuleContext, RuleResult, SectionInfo } from '../types';

type PartKind = 'breakdown' | 'build' | 'drop' | 'outro' | 'intro';

const STRUCTURE_NOUN =
  /\b(?:an?|some|another|new|bigger|big|longer|shorter|short|proper|real)\s+(?:(\d+)[- ]bars?\s+)?(break ?down|build[- ]?up|build|drop|outro|ending|intro)\b/;
const END_THE_SONG = /\b(?:end|finish|close|wrap up) (?:the |this )?(?:song|track)\b|\bgive (?:it|the song|this) an ending\b/;
/** The parts a breakdown takes out. */
const BREAKDOWN_WITHOUT = ['drums', '808', 'bass'];
/** How long each part is when the words give no length (bars). */
const DEFAULT_BARS: Record<PartKind, number> = { breakdown: 4, build: 4, drop: 8, outro: 8, intro: 4 };
/** A song this short gets a short outro (bars). */
const SHORT_SONG_BARS = 32;
const SHORT_OUTRO_BARS = 4;

function kindIn(clause: string): { kind: PartKind; bars: number | null } | null {
  if (END_THE_SONG.test(clause)) return { kind: 'outro', bars: null };
  const found = STRUCTURE_NOUN.exec(clause);
  if (!found) return null;
  const noun = found[2] as string;
  const bars = found[1] ? Number(found[1]) : null;
  if (/^break/.test(noun)) return { kind: 'breakdown', bars };
  if (/^build/.test(noun)) return { kind: 'build', bars };
  if (noun === 'drop') return { kind: 'drop', bars };
  if (noun === 'intro') return { kind: 'intro', bars };
  return { kind: 'outro', bars };
}

/** The last loud section (a chorus, hook or drop): where a build or a breakdown leads. */
function lastPeak(facts: SongFacts): SectionInfo | undefined {
  const peaks = facts.sections.filter((section) => section.role && isPeak(section.role as SectionRole));
  return peaks[peaks.length - 1];
}

/** The bars before a section, as many as asked (cut at the song's start); null when the section starts the song. */
function barsBefore(section: BarRange, length: number): BarRange | null {
  if (section.fromBar <= 1) return null;
  return { fromBar: Math.max(1, section.fromBar - length), toBar: section.fromBar - 1 };
}

/** The bars a breakdown, build or drop is made of: the part named, the bars before a section, or (nothing named) the song's last peak. */
function rangesFor(context: RuleContext, kind: PartKind, length: number): { ranges: BarRange[]; reply?: string } {
  const { scope, facts } = context;
  const leadsIn = scope.anchor === 'into' || scope.anchor === 'before';
  if (scope.isNamed) {
    if (!leadsIn) return { ranges: scope.ranges };
    const before = scope.ranges.map((range) => barsBefore(range, length)).filter((range): range is BarRange => range !== null);
    return before.length > 0 ? { ranges: before } : { ranges: [], reply: 'That part starts the song, so there are no bars before it.' };
  }
  const peak = lastPeak(facts);
  if (!peak) return { ranges: [], reply: `Say where to put the ${kind}: name the bars ("make bars 25–32 a ${kind}") or a part ("a ${kind} before the chorus"). The song has no marked chorus to lead into.` };
  if (kind === 'drop') return { ranges: [peak.range] };
  const before = barsBefore(peak.range, length);
  return before ? { ranges: [before] } : { ranges: [], reply: 'The last chorus starts the song, so there are no bars before it.' };
}

/** The section that already is this kind of part over (most of) the range, if there is one. */
function existingPart(facts: SongFacts, kind: PartKind, range: BarRange): SectionInfo | undefined {
  const roleOf: Record<PartKind, readonly string[]> = { breakdown: ['break'], build: ['build'], drop: ['drop'], outro: ['outro'], intro: ['intro'] };
  return facts.sections.find((section) => {
    if (!roleOf[kind].includes(section.role ?? '')) return false;
    const overlap = Math.min(section.range.toBar, range.toBar) - Math.max(section.range.fromBar, range.fromBar) + 1;
    return overlap >= (range.toBar - range.fromBar + 1) / 2;
  });
}

/** A marker naming the part, or renaming the marker that sits at its start. */
function nameTheStart(facts: SongFacts, range: BarRange, name: string): OfflineAction[] {
  const startTick = (range.fromBar - 1) * facts.barTicks;
  const existing = Object.values(facts.project.playlist.markers).find((marker) => marker.tick === startTick);
  if (!existing) return [{ op: 'marker', action: 'add', name, bar: range.fromBar }];
  // A bridge, break or build already says what it is: its name stays.
  const keepsName = ['break', 'bridge', 'build', 'pre', 'intro', 'outro'].includes(roleFromName(existing.name) ?? '');
  return keepsName ? [] : [{ op: 'marker', action: 'edit', marker: existing.id, name }];
}

/** When the part ends in the middle of a section, a marker puts that section's name back after it. */
function nameTheRest(facts: SongFacts, range: BarRange): OfflineAction[] {
  const section = facts.sections.find((other) => range.fromBar >= other.range.fromBar && range.fromBar <= other.range.toBar);
  if (!section || range.toBar >= section.range.toBar) return [];
  const restTick = range.toBar * facts.barTicks;
  const hasMarker = Object.values(facts.project.playlist.markers).some((marker) => marker.tick === restTick);
  return hasMarker ? [] : [{ op: 'marker', action: 'add', name: section.name, bar: range.toBar + 1 }];
}

function breakdownActions(facts: SongFacts, range: BarRange): OfflineAction[] {
  const actions: OfflineAction[] = [{ op: 'vary', kind: 'without', from_bar: range.fromBar, to_bar: range.toBar, channels: BREAKDOWN_WITHOUT }];
  actions.push(...nameTheStart(facts, range, 'Breakdown'), ...nameTheRest(facts, range));
  if (range.fromBar > 1) actions.push({ op: 'transition', bar: range.fromBar, kind: 'dip' });
  if (range.toBar < facts.totalBars) actions.push({ op: 'transition', bar: range.toBar + 1, kind: 'rise' });
  return actions;
}

function buildActions(facts: SongFacts, range: BarRange): OfflineAction[] {
  const actions: OfflineAction[] = [
    { op: 'vary', kind: 'double_hats', from_bar: range.fromBar, to_bar: range.toBar },
    { op: 'vary', kind: 'hat_roll', bar: range.toBar },
  ];
  actions.push(...nameTheStart(facts, range, 'Build'), ...nameTheRest(facts, range));
  if (range.toBar < facts.totalBars) actions.push({ op: 'transition', bar: range.toBar + 1, kind: 'rise' });
  return actions;
}

function dropActions(facts: SongFacts, range: BarRange): OfflineAction[] {
  const actions: OfflineAction[] = [];
  if (range.fromBar > 1) actions.push({ op: 'transition', bar: range.fromBar, kind: 'rise' });
  actions.push({ op: 'vary', kind: 'crash', bar: range.fromBar });
  actions.push(...nameTheStart(facts, range, 'Drop'), ...nameTheRest(facts, range));
  return actions;
}

function introActions(facts: SongFacts, range: BarRange): OfflineAction[] {
  const actions: OfflineAction[] = [{ op: 'vary', kind: 'without', from_bar: range.fromBar, to_bar: range.toBar, channels: ['drums', '808'] }];
  actions.push(...nameTheStart(facts, range, 'Intro'), ...nameTheRest(facts, range));
  return actions;
}

const BUILDERS: Record<Exclude<PartKind, 'outro'>, (facts: SongFacts, range: BarRange) => OfflineAction[]> = {
  breakdown: breakdownActions,
  build: buildActions,
  drop: dropActions,
  intro: introActions,
};

const NAMES: Record<PartKind, string> = { breakdown: 'a breakdown', build: 'a build', drop: 'a drop', outro: 'an outro', intro: 'an intro' };

/** An outro: new bars after the end, playing what the intro plays (or the first part), quiet, fading out. */
function outro(context: RuleContext, bars: number | null): RuleResult {
  const { facts } = context;
  const existing = facts.sections.find((section) => section.role === 'outro');
  if (existing) return { reply: `The song already ends with an outro (“${existing.name}”, ${describeRange(existing.range)}). To change it, name its bars, for example "make bars ${existing.range.fromBar}–${existing.range.toBar} simpler".` };
  const source = facts.sections.find((section) => section.role === 'intro') ?? facts.sections[0];
  const playing = source ? patternsIn(facts, [source.range]) : patternsIn(facts, [{ fromBar: 1, toBar: Math.min(facts.totalBars, DEFAULT_BARS.outro) }]);
  const play = [...new Set(playing.map((id) => sourceOf(facts.project, id)))];
  if (play.length === 0) return { reply: 'There is nothing on the playlist to make an outro from.' };
  const length = bars ?? (facts.totalBars < SHORT_SONG_BARS ? SHORT_OUTRO_BARS : DEFAULT_BARS.outro);
  const action: OfflineAction = {
    op: 'arrange',
    from_bar: facts.totalBars + 1,
    replace: false,
    fx: 'auto',
    mix: 'keep',
    outro: 'fade',
    sections: [{ name: 'Outro', bars: length, role: 'outro', energy: 1, play, vary: 'none' }],
  };
  return { message: `Added a ${length}-bar outro after the end (bars ${facts.totalBars + 1}–${facts.totalBars + length}): ${source ? `it plays what “${source.name}” plays` : 'the opening parts'}, quietly, and fades out.`, actions: [action] };
}

function addPart(context: RuleContext): RuleResult {
  const { facts, clause } = context;
  const wanted = kindIn(clause);
  if (!wanted) return { reply: 'Say which part to add: a breakdown, a build, a drop or an outro.' };
  if (wanted.kind === 'outro') return outro(context, wanted.bars);
  const length = wanted.bars ?? DEFAULT_BARS[wanted.kind];
  if (wanted.kind === 'intro' && !context.scope.isNamed) {
    return { reply: 'An intro before the first bar would move the whole song, which I can not do here. Name the bars to turn into an intro instead, for example "make bars 1–4 an intro" (the drums leave them).' };
  }
  const found = rangesFor(context, wanted.kind, length);
  if (found.reply) return { reply: found.reply };
  // A part that is already what was asked for is left as it is.
  const already = found.ranges.map((range) => existingPart(facts, wanted.kind, range)).filter((section): section is SectionInfo => section !== undefined);
  const ranges = found.ranges.filter((range) => existingPart(facts, wanted.kind, range) === undefined);
  if (ranges.length === 0) {
    const names = already.map((section) => `“${section.name}” (${describeRange(section.range)})`).join(' and ');
    return { reply: `${names} already ${already.length === 1 ? 'is' : 'are'} ${NAMES[wanted.kind]}. Name other bars to make one somewhere else, for example "make bars 25–32 ${NAMES[wanted.kind]}".` };
  }
  const actions = ranges.flatMap((range) => BUILDERS[wanted.kind as Exclude<PartKind, 'outro'>](facts, range));
  const where = ranges.map(describeRange).join(' and ');
  const what = NAMES[wanted.kind];
  const detail: Record<Exclude<PartKind, 'outro'>, string> = {
    breakdown: 'the drums and bass leave, a riser leads back in',
    build: 'the hats double, with a roll and a riser into what follows',
    drop: 'a riser leads in and a crash hits on its first beat',
    intro: 'the drums and 808 leave',
  };
  return { message: `Made ${where} ${what}: ${detail[wanted.kind]}. It is named with a marker; nothing was deleted.`, actions };
}

/** Breakdown, build, drop, outro, intro. */
export const STRUCTURE_RULES: readonly Rule[] = [
  { id: 'add-part', matches: (_text, clause) => kindIn(clause) !== null, run: addPart },
];
