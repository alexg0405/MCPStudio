/**
 * Moving between parts: smoother transitions, a riser or a crash into a section, more variation through the song. They use the
 * arranger's `develop` (fills, gaps, risers, impacts, crashes, sweeps between sections) and `transition` (one spot).
 */
import { isPeak, type SectionRole } from '../../arrange/sections';
import { describeRange } from '../song-facts';
import type { OfflineAction, Rule, RuleContext, RuleResult } from '../types';

const SMOOTHER =
  /\b(?:smooth(?:er|ly)?|transitions?|flow(?:s|ing)?\b|join(?:ed)? (?:the )?(?:parts|sections)|glue (?:the )?(?:parts|sections)|abrupt|jarring|jump(?:y|s)?|blend)\b/;
const VARIATION =
  /\b(?:more variation|variation|vary|varied|variety|less (?:repetitive|boring|samey|static|loopy)|repetitive|boring|samey|switch(?:ing)? it up|mix(?:ing)? it up|change it up|keep it interesting|add (?:some )?(?:life|movement|interest|dynamics)|too (?:repetitive|static|loopy)|loopy|develop it|develop the)\b/;
/** The one-spot elements a request can name, and the transition kind each is. */
const ELEMENTS: readonly (readonly [RegExp, string, string])[] = [
  [/\breverse crash(?:es)?\b|\breversed? cymbal\b/, 'reverse_crash', 'a reverse crash'],
  [/\bdown ?lifters?\b|\bdown sweeps?\b/, 'downlifter', 'a downlifter'],
  [/\b(?:risers?|uplifters?|up ?lifters?|build[- ]?up sweep|sweep up)\b/, 'riser', 'a riser'],
  [/\bimpacts?\b/, 'impact', 'an impact'],
  [/\bcrash(?:es)?\b|\bcymbals?\b/, 'crash', 'a crash'],
  [/\breverb throw\b|\bthrow (?:the )?reverb\b|\becho throw\b/, 'reverb_throw', 'a reverb throw'],
  [/\b(?:filter )?sweeps?\b|\bfilter (?:open|opens|opening)\b/, 'filter_open', 'a filter sweep'],
  [/\b(?:gap|silence|pause|breath|dropout)\b/, 'gap', 'a gap'],
  [/\bfills?\b(?=.*\b(?:into|leading into|before)\b)/, 'fill', 'a fill'],
];
/** Most spots one request puts an element at. */
const MAX_SPOTS = 6;

/** The element the words name, as a transition kind. */
function elementIn(text: string): { kind: string; label: string } | null {
  for (const [pattern, kind, label] of ELEMENTS) if (pattern.test(text)) return { kind, label };
  return null;
}

/** Whether the words name a spot and an element ("a riser into the chorus", "a crash at bar 17"). */
function isElementRequest(_text: string, clause: string): boolean {
  if (!elementIn(clause)) return false;
  // "the riser is too loud" is a mix request.
  return !/\b(?:louder|quieter|too (?:loud|quiet)|turn (?:it )?(?:up|down)|volume|level|softer|more reverb|less reverb)\b/.test(clause);
}

/** The bars an element leads into: the start of each part named, the bar after the end of a part, or (nothing named) each loud section. */
function spotsFor(context: RuleContext): number[] {
  const { scope, facts } = context;
  if (scope.isNamed) {
    const bars = scope.ranges.map((range) => (scope.anchor === 'end' ? range.toBar + 1 : range.fromBar));
    return bars.filter((bar) => bar >= 1 && bar <= facts.totalBars).slice(0, MAX_SPOTS);
  }
  const peaks = facts.sections.filter((section) => section.role && isPeak(section.role as SectionRole) && section.range.fromBar > 1);
  const starts = (peaks.length > 0 ? peaks : facts.sections.slice(1)).map((section) => section.range.fromBar);
  return starts.slice(0, MAX_SPOTS);
}

function addElement(context: RuleContext): RuleResult {
  const element = elementIn(context.clause);
  if (!element) return { reply: 'Say which transition sound to add: a riser, an impact, a crash, a reverse crash, a downlifter, a filter sweep, a gap or a fill.' };
  const spots = spotsFor(context);
  if (spots.length === 0) return { reply: 'There is no part boundary to put that on: name a bar ("a riser into bar 17") or a part ("into the chorus").' };
  const actions: OfflineAction[] = spots.map((bar) => ({ op: 'transition', bar, kind: element.kind }));
  const where = spots.length === 1 ? `into bar ${spots[0]}` : `into bars ${spots.join(', ')}`;
  return { message: `Asked for ${element.label} ${where} (a spot that has one already stays as it is).`, actions };
}

function smoothTransitions(context: RuleContext): RuleResult {
  const { scope, facts } = context;
  if (facts.sections.length === 0 && facts.totalBars === 0) return { reply: 'The playlist is empty: there are no transitions to smooth yet.' };
  const actions: OfflineAction[] = scope.ranges.map((range) => ({
    op: 'develop',
    from_bar: range.fromBar,
    to_bar: range.toBar,
    fills: false,
    transitions: true,
    fx: true,
    cleanup: false,
  }));
  return { message: `Smoothed the transitions in ${scope.label}: gaps, risers, impacts, crashes and sweeps between the parts, kept where they already are.`, actions };
}

function moreVariation(context: RuleContext): RuleResult {
  const { scope } = context;
  const actions: OfflineAction[] = scope.ranges.map((range) => ({
    op: 'develop',
    from_bar: range.fromBar,
    to_bar: range.toBar,
    fills: true,
    transitions: false,
    fx: false,
    cleanup: false,
  }));
  const where = scope.isNamed ? describeRange(scope.ranges[0] ?? { fromBar: 1, toBar: 1 }) : 'the song';
  return { message: `Added variation to ${scope.isNamed ? scope.label : where}: a fill every 8 bars and a small change every 4, as variants (the original loops stay as they were).`, actions };
}

/** A riser, an impact, a crash or another sound into a part. */
export const ELEMENT_RULES: readonly Rule[] = [{ id: 'transition-element', matches: isElementRequest, run: addElement }];

/** Smoother transitions and more variation through a part of the song. */
export const FLOW_RULES: readonly Rule[] = [
  { id: 'smoother', matches: (text) => SMOOTHER.test(text), run: smoothTransitions },
  { id: 'variation', matches: (text) => VARIATION.test(text), run: moreVariation },
];
