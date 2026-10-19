/**
 * The arrangement check: what song mode actually plays, read for the problems that make a song
 * sound unfinished. Bugs are what the arranger must never leave (it reports them as warnings);
 * notes are worth a look.
 * - stacked: the same clips play two or three times at once;
 * - static-loop: the drums and bass repeat a 1- or 2-bar loop unchanged for more than 4 bars;
 * - no-fill: a section's 8-bar phrase (16 in house/EDM) ends without a fill or change;
 * - layered-fill: a fill on its own track plays on top of the full groove;
 * - no-gap: drums or bass play through the last beat before a rise into a drop;
 * - no-riser / no-impact: a rise without a riser ending on it, or nothing hitting on it (notes);
 * - crash-spam: crashes less than 4 bars apart;
 * - curve-not-neutral: automation ending before the song does, off where its control sits;
 * - abrupt-end: a loud song that just stops (no fade, stop or quiet outro) (note);
 * - silent: two bars or more where nothing but effects plays (sounds like the music stopped).
 */
import { ARRANGER_AUTOMATION } from '@core/arrange/apply';
import { existingFx, fillLikeClips, inferSections, layeredFills, type InferredSection } from '@core/arrange/infer';
import { playedNotes } from '@core/arrange/notes';
import { isBassRole, isDrumRole, noteRole } from '@core/arrange/roles';
import type { VariantEnv } from '@core/arrange/fills';
import { classifyBoundary } from '@core/arrange/transitions';
import { inferStyle, PHRASE, type Style } from '@core/beat/style';
import { resolveTarget } from '@core/automation/targets';
import { curveAt } from '@core/automation/curve';
import type { Project, Tick } from '@core/model/types';
import { songCheck } from '@core/query/arrangement';
import { mutedLanes, songLength } from '@core/query/playlist';
import { barSpan } from '@core/time/bars';
import { ticksPerBar } from '@core/time/ppq';
import type { Services } from '../services';
import { specsResolver, variantEnvFor } from './env';

export type CheckCode =
  | 'stacked'
  | 'static-loop'
  | 'no-fill'
  | 'layered-fill'
  | 'no-gap'
  | 'no-riser'
  | 'no-impact'
  | 'crash-spam'
  | 'curve-not-neutral'
  | 'abrupt-end'
  | 'silent';

export interface Finding {
  code: CheckCode;
  severity: 'bug' | 'note';
  from: Tick;
  to: Tick;
  message: string;
}

const BEAT = 960;

export interface CheckOptions {
  style?: Style;
  /** The sections as planned (else read from the song). */
  sections?: readonly Pick<InferredSection, 'name' | 'role' | 'from' | 'to' | 'bars' | 'energy'>[];
}

type Section = NonNullable<CheckOptions['sections']>[number];
type PlayedNote = ReturnType<typeof playedNotes>[number];
type Fx = ReturnType<typeof existingFx>;

/** Everything the individual checks read, worked out once. */
interface CheckContext {
  s: Services;
  p: Project;
  env: VariantEnv;
  /** Ticks in one bar. */
  bar: Tick;
  /** The song's length in ticks (more than zero here). */
  end: Tick;
  /** A tick range as bar words, e.g. "bars 5–8". */
  span: (from: Tick, to: Tick) => string;
  /** The role a note plays: a drum part, bass, and so on. */
  roleOf: (channelId: string, key: number) => ReturnType<typeof noteRole>;
}

type AddFinding = (code: CheckCode, severity: Finding['severity'], from: Tick, to: Tick, message: string) => void;

/** Checks what the song plays. */
export function checkArrangement(s: Services, p: Project, opts: CheckOptions = {}): Finding[] {
  const style = opts.style ?? inferStyle(p);
  const env = variantEnvFor(p, style);
  const ts = p.transport.timeSig;
  const end = songLength(p);
  const out: Finding[] = [];
  if (end === 0) return out;
  const ctx: CheckContext = {
    s,
    p,
    env,
    bar: ticksPerBar(ts),
    end,
    span: (from, to) => barSpan(from, to, ts),
    roleOf: (channelId, key) => noteRole(env.roles.get(channelId as never) ?? 'other', key),
  };
  const add: AddFinding = (code, severity, from, to, message) => out.push({ code, severity, from, to, message });

  // The order of the checks is the order of equal-position findings in the result (the sort below is stable).
  addStackedFindings(ctx, add);
  const notes = playedNotes(p);
  addSilenceFindings(ctx, notes, add);
  const groove = grooveNotes(ctx, notes);
  addStaticLoopFindings(ctx, groove, add);
  const sections = opts.sections ?? inferSections(p, env);
  addNoFillFindings(ctx, groove, sections, style, add);
  addLayeredFillFindings(ctx, add);
  const fx = existingFx(p, env);
  addRiseFindings(ctx, groove, sections, fx, add);
  addCrashSpamFindings(ctx, fx, add);
  addCurveFindings(ctx, add);
  addAbruptEndFinding(ctx, groove, sections, add);
  return out.sort((a, b) => a.from - b.from || a.code.localeCompare(b.code));
}

/** Clips that play twice or more at once, or a pattern on top of itself (the song check's own list). */
function addStackedFindings({ p, span }: CheckContext, add: AddFinding): void {
  for (const issue of songCheck(p)) {
    if (issue.kind === 'stacked') add('stacked', 'bug', issue.from, issue.to, `${span(issue.from, issue.to)} play the same clips ${issue.times} times at once`);
    if (issue.kind === 'doubled') add('stacked', 'bug', issue.from, issue.to, `“${p.patterns[issue.patternId]?.name ?? '?'}” plays on top of itself at ${span(issue.from, issue.to)}`);
  }
}

/** Two bars or more where only effects (risers, impacts) or nothing play. */
function addSilenceFindings(ctx: CheckContext, notes: readonly PlayedNote[], add: AddFinding): void {
  const { p, env, bar, end, span } = ctx;
  const heard = new Uint8Array(Math.ceil(end / bar));
  const mark = (from: Tick, to: Tick) => {
    for (let b = Math.floor(from / bar); b < Math.min(heard.length, Math.ceil(to / bar)); b++) heard[b] = 1;
  };
  for (const n of notes) if ((env.roles.get(n.channelId as never) ?? 'other') !== 'fx') mark(n.tick, n.tick + Math.max(1, n.length));
  const silentLanes = mutedLanes(p.playlist);
  for (const c of Object.values(p.playlist.clips))
    if (c.kind === 'audio' && !c.muted && !silentLanes.has(c.laneId) && (env.roles.get(c.channelId) ?? 'other') !== 'fx') mark(c.start, c.start + c.length);
  for (let b = 0; b < heard.length; b++) {
    if (heard[b]) continue;
    let last = b;
    while (last + 1 < heard.length && !heard[last + 1]) last++;
    // A tail of effects past the last music (an impact ringing out after a stop) is the ending, not a gap.
    const isEndingTail = last === heard.length - 1 && b > 0;
    if (last - b + 1 >= 2 && !isEndingTail) {
      add('silent', 'bug', b * bar, (last + 1) * bar, `nothing but effects plays over ${span(b * bar, (last + 1) * bar)} (it sounds like the music stopped): play a beat or a layer there`);
    }
    b = last;
  }
}

/** The drum and bass notes: what the loop, fill and gap checks listen to. */
function grooveNotes({ env, roleOf }: CheckContext, notes: readonly PlayedNote[]): PlayedNote[] {
  return notes.filter((n) => isDrumRole(roleOf(n.channelId, n.key)) || isBassRole(env.roles.get(n.channelId) ?? 'other'));
}

/** A text fingerprint of the groove in each bar (sorted, so only what plays counts, not the order). */
function barFingerprints({ bar, end }: CheckContext, groove: readonly PlayedNote[]): string[] {
  const lists: string[][] = Array.from({ length: Math.ceil(end / bar) }, () => []);
  for (const n of groove) {
    const b = Math.floor(n.tick / bar);
    if (b < lists.length) lists[b]!.push(`${n.channelId}:${n.tick - b * bar}:${n.key}:${Math.round(n.velocity * 100)}:${n.length}`);
  }
  return lists.map((list) => list.sort().join('|'));
}

/** Drums and bass that repeat a 1- or 2-bar loop unchanged for more than 4 bars. */
function addStaticLoopFindings(ctx: CheckContext, groove: readonly PlayedNote[], add: AddFinding): void {
  const { bar, span } = ctx;
  const prints = barFingerprints(ctx, groove);
  const repeatsEarlierBar = (b: number, period: number) => prints[b] && prints[b] === prints[b - period];
  for (const period of [1, 2]) {
    let run = 0;
    let flaggedUntil = -1;
    for (let b = period; b < prints.length; b++) {
      if (repeatsEarlierBar(b, period)) run++;
      else run = 0;
      if (run + period <= 4 || b <= flaggedUntil) continue;
      let last = b;
      while (last + 1 < prints.length && repeatsEarlierBar(last + 1, period)) last++;
      const from = (b - run - period + 1) * bar;
      add('static-loop', 'bug', from, (last + 1) * bar, `the drums and bass repeat the same ${period === 1 ? 'bar' : '2 bars'} unchanged over ${span(from, (last + 1) * bar)}`);
      flaggedUntil = last;
    }
  }
}

/** The drum hits in the last `beats` beats of bar `b`, as a sorted fingerprint (empty when there are none). */
function drumsBeforeBarline({ bar, roleOf }: CheckContext, groove: readonly PlayedNote[], b: number, beats: number): string {
  return groove
    .filter((n) => n.tick >= (b + 1) * bar - beats * BEAT && n.tick < (b + 1) * bar && isDrumRole(roleOf(n.channelId, n.key)))
    .map((n) => `${n.channelId}:${n.tick - b * bar}:${n.key}:${Math.round(n.velocity * 100)}`)
    .sort()
    .join('|');
}

/** A section's phrase ends without a fill: its last 2 beats sound like those 1 or 2 bars before. */
function addNoFillFindings(ctx: CheckContext, groove: readonly PlayedNote[], sections: readonly Section[], style: Style, add: AddFinding): void {
  const { bar, end } = ctx;
  const bars = Math.ceil(end / bar);
  const period = PHRASE[style].fill;
  const lastTwoBeats = (b: number) => drumsBeforeBarline(ctx, groove, b, 2);
  for (const sec of sections) {
    const first = Math.round(sec.from / bar);
    for (let k = period; k <= sec.bars; k += period) {
      const b = first + k - 1;
      if (b < 2 || b >= bars - 1) continue;
      const here = lastTwoBeats(b);
      if (!here) continue;
      if (here === lastTwoBeats(b - 1) || here === lastTwoBeats(b - 2)) {
        add('no-fill', 'bug', b * bar, (b + 1) * bar, `bar ${b + 1} ends ${sec.name}'s ${k}-bar phrase with no fill or change`);
      }
    }
  }
}

/** A fill on its own track that plays on top of the full drums. */
function addLayeredFillFindings({ p, env, span }: CheckContext, add: AddFinding): void {
  for (const l of layeredFills(p, env)) {
    add('layered-fill', 'bug', l.fill.from, l.fill.to, `the fill at ${span(l.fill.from, l.fill.to)} plays on top of the full drums`);
  }
}

/** Rises: a gap before the drop (a fill played from its own clip may lead in), a riser, something on the downbeat. */
function addRiseFindings(ctx: CheckContext, groove: readonly PlayedNote[], sections: readonly Section[], fx: Fx, add: AddFinding): void {
  const { p, env, bar } = ctx;
  const leadIns = new Set(fillLikeClips(p, env).map((f) => f.clipId));
  const hasFxNear = (kinds: readonly string[], at: Tick) => fx.some((f) => kinds.includes(f.kind) && Math.abs(f.at - at) <= BEAT);
  for (let i = 1; i < sections.length; i++) {
    const before = sections[i - 1]!;
    const after = sections[i]!;
    if (classifyBoundary(before, after) !== 'rise') continue;
    const downbeat = after.from;
    const where = `“${after.name}” at bar ${downbeat / bar + 1}`;
    const playsThrough = groove.some((n) => !leadIns.has(n.clipId) && n.tick < downbeat && n.tick + n.length > downbeat - BEAT + 30);
    if (playsThrough) add('no-gap', 'bug', downbeat - BEAT, downbeat, `drums or bass play right up to ${where} (a gap before it makes it hit)`);
    if (!hasFxNear(['riser'], downbeat)) add('no-riser', 'note', downbeat - 2 * bar, downbeat, `nothing rises into ${where}`);
    if (!hasFxNear(['impact', 'crash', 'sub-drop'], downbeat)) add('no-impact', 'note', downbeat, downbeat + bar, `nothing hits on the downbeat of ${where}`);
  }
}

/** Crashes closer than 4 bars to each other. */
function addCrashSpamFindings({ bar, span }: CheckContext, fx: Fx, add: AddFinding): void {
  const minGap = 4 * bar;
  const crashes = [...new Set(fx.filter((f) => f.kind === 'crash').map((f) => f.at))].sort((a, b) => a - b);
  for (let i = 1; i < crashes.length; i++) {
    if (crashes[i]! - crashes[i - 1]! >= minGap) continue;
    let last = i;
    while (last + 1 < crashes.length && crashes[last + 1]! - crashes[last]! < minGap) last++;
    add('crash-spam', 'bug', crashes[i - 1]!, crashes[last]! + bar, `${last - i + 2} crashes within ${span(crashes[i - 1]!, crashes[last]! + bar)} (one per 4 bars at most)`);
    i = last;
  }
}

/** Curves that end off their control's own value while the song goes on. */
function addCurveFindings({ s, p, bar, end }: CheckContext, add: AddFinding): void {
  const off = mutedLanes(p.playlist);
  const specs = specsResolver(s);
  for (const c of Object.values(p.playlist.clips)) {
    if (c.kind !== 'automation' || c.muted || off.has(c.laneId)) continue;
    const ch = p.channels[c.channelId];
    if (ch?.kind !== 'automation' || !ch.target || ch.target.kind === 'tempo' || ch.muted) continue;
    const clipEnd = c.start + c.length;
    if (clipEnd >= end) continue;
    const res = resolveTarget(p, ch.target, specs, ch.range);
    const v = curveAt(ch.points, c.length + c.offset);
    if (!res || v === null) continue;
    if (Math.abs(v - res.toNormalized(res.base)) <= 0.01) continue;
    const severity = ARRANGER_AUTOMATION.test(ch.name) ? 'bug' : 'note';
    add('curve-not-neutral', severity, c.start, clipEnd, `“${ch.name}” ends at bar ${clipEnd / bar + 1} away from where its control sits, so it stays there for the rest of the song`);
  }
}

/** A loud last section with no fade, stop or quiet outro. */
function addAbruptEndFinding({ p, bar, end }: CheckContext, groove: readonly PlayedNote[], sections: readonly Section[], add: AddFinding): void {
  const last = sections[sections.length - 1];
  if (!last || last.energy < 4) return;
  const fades = Object.values(p.playlist.clips).some((c) => {
    if (c.kind !== 'automation' || c.start + c.length < end - bar) return false;
    const ch = p.channels[c.channelId];
    return ch?.kind === 'automation' && ch.target?.kind === 'insert' && ch.target.param === 'volume';
  });
  const lastBar = end - bar;
  const stops = !groove.some((n) => n.tick >= lastBar + BEAT);
  if (!fades && !stops) add('abrupt-end', 'note', lastBar, end, `the song ends at full energy (“${last.name}”) with no fade or stop`);
}

/** The findings as lines for the chat or a toast. */
export function findingLines(findings: readonly Finding[], severity?: Finding['severity']): string[] {
  return findings.filter((f) => !severity || f.severity === severity).map((f) => f.message);
}
