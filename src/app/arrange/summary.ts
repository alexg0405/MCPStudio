/**
 * The arrangement in words: for the AI's view of the project (sections with their energy, which
 * patterns are variants of which, what the arrangement check finds) and for the chat after an
 * arrange ("Arranged 76 bars: Intro 1–8 · Verse 9–24 · … · 6 fills, 2 builds (riser, gap, impact),
 * 1 breakdown, outro fade").
 */
import { inferSections } from '@core/arrange/infer';
import { notesHash } from '@core/arrange/notes';
import type { ArrangementPlan } from '@core/arrange/plan';
import { stepLabel } from '@core/arrange/variants';
import { inferStyle } from '@core/beat/style';
import type { Pattern, Project } from '@core/model/types';
import { songLength } from '@core/query/playlist';
import { ticksPerBar } from '@core/time/ppq';
import { variantEnvFor } from './env';

/** 'variant of “Drop”: fill + slide' (and whether it was edited by hand), or null for ordinary patterns. */
export function derivedLabel(p: Project, pattern: Pattern): string | null {
  const d = pattern.derived;
  if (!d) return null;
  const source = p.patterns[d.from];
  if (!source) return null;
  const names = (id: string) => p.channels[id as never]?.name;
  const labels = [...new Set(d.steps.map((s) => stepLabel(s, names)))];
  const edited = notesHash(pattern.notes) !== d.hash;
  return `variant of “${source.name}”: ${labels.join(' + ') || 'changed'}${edited ? ' (edited by hand: kept as it is)' : ''}`;
}

/** Bar ranges as "1–8" (inclusive). */
const bars = (from: number, to: number, bar: number) => {
  const a = from / bar + 1;
  const b = to / bar;
  return a === b ? `${a}` : `${a}–${b}`;
};

/** The arrangement as the AI reads it: sections with energies, and how many patterns are variants. */
export function arrangementLines(p: Project): string[] {
  if (songLength(p) === 0) return [];
  const bar = ticksPerBar(p.transport.timeSig);
  const env = variantEnvFor(p, inferStyle(p));
  const sections = inferSections(p, env);
  const variants = Object.values(p.patterns).filter((x) => x.derived && p.patterns[x.derived.from]);
  const lines: string[] = [];
  if (sections.length && (Object.keys(p.playlist.markers).length || variants.length))
    lines.push(
      `Arrangement (sections, energy 1–5 as heard): ${sections.map((s) => `${s.name} ${bars(s.from, s.to, bar)} (${s.energy})`).join(' · ')}`,
    );
  if (variants.length) {
    const sources = new Set(variants.map((v) => v.derived!.from));
    lines.push(
      `Variants: ${variants.length} pattern${variants.length === 1 ? ' is a variant' : 's are variants'} of ${sources.size} pattern${sources.size === 1 ? '' : 's'} (fills, slides, gaps the arranger made). Edit the source pattern: its variants follow it. vary/transition/develop add more.`,
    );
  }
  return lines;
}

/** The chat line after an arrange. */
export function arrangeSummary(plan: ArrangementPlan): string {
  const bar = plan.barTicks;
  const total = (plan.to - plan.from) / bar;
  const parts = plan.sections.map((s) => `${s.name} ${bars(s.from, s.to, bar)}`);
  const extras: string[] = [];
  if (plan.counts.fills) extras.push(`${plan.counts.fills} fill${plan.counts.fills === 1 ? '' : 's'}`);
  const builds = plan.counts.builds;
  if (builds.length) {
    const what = [builds.some((b) => b.riser) ? 'riser' : '', builds.some((b) => b.gap) ? 'gap' : '', builds.some((b) => b.impact) ? 'impact' : ''].filter(Boolean);
    extras.push(`${builds.length} build${builds.length === 1 ? '' : 's'}${what.length ? ` (${what.join(', ')})` : ''}`);
  }
  if (plan.counts.breakdowns) extras.push(`${plan.counts.breakdowns} breakdown${plan.counts.breakdowns === 1 ? '' : 's'}`);
  extras.push(`outro ${plan.ending.kind}`);
  return `Arranged ${total} bar${total === 1 ? '' : 's'}: ${parts.join(' · ')} · ${extras.join(', ')}`;
}
