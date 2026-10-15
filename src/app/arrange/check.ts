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
 * - abrupt-end: a loud song that just stops (no fade, stop or quiet outro) (note).
 */
import { ARRANGER_AUTOMATION } from '@core/arrange/apply';
import { existingFx, fillLikeClips, inferSections, layeredFills, type InferredSection } from '@core/arrange/infer';
import { playedNotes } from '@core/arrange/notes';
import { isBassRole, isDrumRole, noteRole } from '@core/arrange/roles';
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
  | 'abrupt-end';

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

/** Checks what the song plays. */
export function checkArrangement(s: Services, p: Project, opts: CheckOptions = {}): Finding[] {
  const style = opts.style ?? inferStyle(p);
  const env = variantEnvFor(p, style);
  const ts = p.transport.timeSig;
  const bar = ticksPerBar(ts);
  const end = songLength(p);
  const out: Finding[] = [];
  if (end === 0) return out;
  const span = (a: Tick, b: Tick) => barSpan(a, b, ts);
  const add = (code: CheckCode, severity: Finding['severity'], from: Tick, to: Tick, message: string) =>
    out.push({ code, severity, from, to, message });

  for (const issue of songCheck(p)) {
    if (issue.kind === 'stacked') add('stacked', 'bug', issue.from, issue.to, `${span(issue.from, issue.to)} play the same clips ${issue.times} times at once`);
    if (issue.kind === 'doubled') add('stacked', 'bug', issue.from, issue.to, `“${p.patterns[issue.patternId]?.name ?? '?'}” plays on top of itself at ${span(issue.from, issue.to)}`);
  }

  // Drum and bass notes, bar by bar.
  const notes = playedNotes(p);
  const roleOf = (cid: string, key: number) => noteRole(env.roles.get(cid as never) ?? 'other', key);
  const groove = notes.filter((n) => {
    const r = roleOf(n.channelId, n.key);
    return isDrumRole(r) || isBassRole(env.roles.get(n.channelId) ?? 'other');
  });
  const bars = Math.ceil(end / bar);
  const prints: string[] = Array.from({ length: bars }, () => '');
  const lists: string[][] = Array.from({ length: bars }, () => []);
  for (const n of groove) {
    const b = Math.floor(n.tick / bar);
    if (b < bars) lists[b]!.push(`${n.channelId}:${n.tick - b * bar}:${n.key}:${Math.round(n.velocity * 100)}:${n.length}`);
  }
  lists.forEach((l, b) => (prints[b] = l.sort().join('|')));
  // Static loops: 1- or 2-bar repeats running past 4 bars.
  for (const period of [1, 2]) {
    let run = 0;
    let flaggedUntil = -1;
    for (let b = period; b < bars; b++) {
      if (prints[b] && prints[b] === prints[b - period]) run++;
      else run = 0;
      if (run + period > 4 && b > flaggedUntil) {
        let e = b;
        while (e + 1 < bars && prints[e + 1] && prints[e + 1] === prints[e + 1 - period]) e++;
        const from = (b - run - period + 1) * bar;
        add('static-loop', 'bug', from, (e + 1) * bar, `the drums and bass repeat the same ${period === 1 ? 'bar' : '2 bars'} unchanged over ${span(from, (e + 1) * bar)}`);
        flaggedUntil = e;
      }
    }
  }

  const sections = opts.sections ?? inferSections(p, env);
  const lastBeats = (b: number, beats: number) =>
    groove
      .filter((n) => n.tick >= (b + 1) * bar - beats * BEAT && n.tick < (b + 1) * bar && isDrumRole(roleOf(n.channelId, n.key)))
      .map((n) => `${n.channelId}:${n.tick - b * bar}:${n.key}:${Math.round(n.velocity * 100)}`)
      .sort()
      .join('|');
  // Phrase ends without a fill: the last 2 beats sound like those 1 and 2 bars before.
  const period = PHRASE[style].fill;
  for (const sec of sections) {
    const first = Math.round(sec.from / bar);
    for (let k = period; k <= sec.bars; k += period) {
      const b = first + k - 1;
      if (b < 2 || b >= bars - 1) continue;
      const here = lastBeats(b, 2);
      if (!here) continue;
      if (here === lastBeats(b - 1, 2) || here === lastBeats(b - 2, 2))
        add('no-fill', 'bug', b * bar, (b + 1) * bar, `bar ${b + 1} ends ${sec.name}'s ${k}-bar phrase with no fill or change`);
    }
  }

  for (const l of layeredFills(p, env))
    add('layered-fill', 'bug', l.fill.from, l.fill.to, `the fill at ${span(l.fill.from, l.fill.to)} plays on top of the full drums`);

  // Rises: a gap (a fill played from its own clip may lead in), a riser, something on the downbeat.
  const fx = existingFx(p, env);
  const leadIns = new Set(fillLikeClips(p, env).map((f) => f.clipId));
  for (let i = 1; i < sections.length; i++) {
    const a = sections[i - 1]!;
    const b = sections[i]!;
    if (classifyBoundary(a, b) !== 'rise') continue;
    const X = b.from;
    const through = groove.some((n) => !leadIns.has(n.clipId) && n.tick < X && n.tick + n.length > X - BEAT + 30);
    if (through) add('no-gap', 'bug', X - BEAT, X, `drums or bass play right up to “${b.name}” at bar ${X / bar + 1} (a gap before it makes it hit)`);
    if (!fx.some((f) => f.kind === 'riser' && Math.abs(f.at - X) <= BEAT))
      add('no-riser', 'note', X - 2 * bar, X, `nothing rises into “${b.name}” at bar ${X / bar + 1}`);
    if (!fx.some((f) => (f.kind === 'impact' || f.kind === 'crash' || f.kind === 'sub-drop') && Math.abs(f.at - X) <= BEAT))
      add('no-impact', 'note', X, X + bar, `nothing hits on the downbeat of “${b.name}” at bar ${X / bar + 1}`);
  }

  // Crashes closer than 4 bars.
  const crashes = [...new Set(fx.filter((f) => f.kind === 'crash').map((f) => f.at))].sort((a, b) => a - b);
  for (let i = 1; i < crashes.length; i++) {
    if (crashes[i]! - crashes[i - 1]! >= 4 * bar) continue;
    let j = i;
    while (j + 1 < crashes.length && crashes[j + 1]! - crashes[j]! < 4 * bar) j++;
    add('crash-spam', 'bug', crashes[i - 1]!, crashes[j]! + bar, `${j - i + 2} crashes within ${span(crashes[i - 1]!, crashes[j]! + bar)} (one per 4 bars at most)`);
    i = j;
  }

  // Curves that end off their control's own value while the song goes on.
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
    if (Math.abs(v - res.toNormalized(res.base)) > 0.01)
      add(
        'curve-not-neutral',
        ARRANGER_AUTOMATION.test(ch.name) ? 'bug' : 'note',
        c.start,
        clipEnd,
        `“${ch.name}” ends at bar ${clipEnd / bar + 1} away from where its control sits, so it stays there for the rest of the song`,
      );
  }

  // An ending.
  const last = sections[sections.length - 1];
  if (last && last.energy >= 4) {
    const fades = Object.values(p.playlist.clips).some((c) => {
      if (c.kind !== 'automation' || c.start + c.length < end - bar) return false;
      const ch = p.channels[c.channelId];
      return ch?.kind === 'automation' && ch.target?.kind === 'insert' && ch.target.param === 'volume';
    });
    const lastBar = end - bar;
    const stops = !groove.some((n) => n.tick >= lastBar + BEAT);
    if (!fades && !stops) add('abrupt-end', 'note', lastBar, end, `the song ends at full energy (“${last.name}”) with no fade or stop`);
  }
  return out.sort((a, b) => a.from - b.from || a.code.localeCompare(b.code));
}

/** The findings as lines for the chat or a toast. */
export function findingLines(findings: readonly Finding[], severity?: Finding['severity']): string[] {
  return findings.filter((f) => !severity || f.severity === severity).map((f) => f.message);
}
