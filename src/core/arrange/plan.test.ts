import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PHRASE, STYLES, type Style } from '../beat/style';
import type { PatternId } from '../model/types';
import { BAR, BEAT, HINT, kitProject, notes, trapGroove } from '../../../test/helpers/arrange';
import { planArrangement, type ArrangementPlan, type ArrangeRequest } from './plan';
import { DEFAULT_ENERGY, SECTION_ROLES, type SectionRole, type SectionSpec } from './sections';
import { FILL_KINDS, variantEnv } from './variants';

function song() {
  return kitProject((k) => ({
    Beat: { notes: trapGroove(k) },
    Drums: {
      notes: {
        [k.kick]: notes([[0, 60], [10, 60]]),
        [k.snare]: notes([[8, 60]]),
        [k.hat]: notes(Array.from({ length: 8 }, (_, i) => [i * 2, 60] as [number, number])),
      } as never,
      bars: 1,
    },
    Keys: { notes: { [k.pad]: notes([[0, 53, 32], [0, 60, 32]]) } as never, bars: 2 },
    Melody: { notes: { [k.lead]: notes([[0, 72, 4], [4, 75, 4], [8, 77, 8], [16, 72, 16]]) } as never, bars: 2 },
  }));
}

const spec = (name: string, role: SectionRole, bars: number, play: PatternId[], patch: Partial<SectionSpec> = {}): SectionSpec => ({
  name,
  role,
  bars,
  energy: DEFAULT_ENERGY[role],
  play,
  without: [],
  vary: 'auto',
  transitionIn: 'auto',
  fill: 'auto',
  ...patch,
});

function plan(s: ReturnType<typeof song>, req: Omit<ArrangeRequest, 'from' | 'fx'> & Partial<ArrangeRequest>): ArrangementPlan {
  const env = { variant: variantEnv(s.project, { style: req.style, hint: HINT }) };
  return planArrangement(s.project, { from: 0, fx: 'auto', ...req }, env);
}

/** Problems with a plan that the arranger promises never to have. */
function violations(p: ArrangementPlan, drumPatterns: ReadonlySet<PatternId>): string[] {
  const out: string[] = [];
  const overlap = (list: { start: number; end: number; lane: string }[], what: string) => {
    const by = new Map<string, { start: number; end: number }[]>();
    for (const x of list) by.set(x.lane, [...(by.get(x.lane) ?? []), x]);
    for (const [lane, xs] of by) {
      xs.sort((a, b) => a.start - b.start);
      for (let i = 1; i < xs.length; i++) if (xs[i]!.start < xs[i - 1]!.end) out.push(`${what} overlap on ${lane} at ${xs[i]!.start / BAR}`);
    }
  };
  overlap(p.clips.map((c) => ({ start: c.start, end: c.start + c.length, lane: c.source })), 'clips');
  overlap(p.fx.map((f) => ({ start: f.start, end: f.start + f.length, lane: f.lane })), 'fx');
  overlap(p.automation.map((a) => ({ start: a.start, end: a.start + a.length, lane: a.lane })), 'automation');
  // Crashes at least 4 bars apart.
  const crashes = p.crashes.map((c) => c.at).sort((a, b) => a - b);
  for (let i = 1; i < crashes.length; i++) if (crashes[i]! - crashes[i - 1]! < 4 * BAR) out.push(`crashes at ${crashes[i - 1]! / BAR} and ${crashes[i]! / BAR}`);
  // Every rise: a gap, a riser and an impact.
  for (const b of p.boundaries.filter((x) => x.kind === 'rise')) {
    if (!b.end.some((e) => e.kind === 'gap')) out.push(`no gap at ${b.at / BAR}`);
    if (!b.fx.some((f) => f.kind === 'riser' && f.start + f.beats * BEAT === b.at)) out.push(`no riser at ${b.at / BAR}`);
    if (!b.fx.some((f) => f.kind === 'impact' && f.start === b.at)) out.push(`no impact at ${b.at / BAR}`);
  }
  // Every drum section's phrase ends carry a fill (the song's last bar may be a stop instead).
  const period = PHRASE[p.style].fill;
  for (const s of p.sections) {
    if (!s.play.some((pid) => drumPatterns.has(pid))) continue;
    for (let b = period; b <= s.bars; b += period) {
      const end = s.from + b * BAR;
      if (s === p.sections[p.sections.length - 1] && b === s.bars && p.ending.kind === 'stop') continue;
      const ok = p.clips.some(
        (c) => c.section === s.index && c.steps.some((st) => FILL_KINDS.has(st.kind) && c.start + st.to >= end - 2 * BEAT && c.start + st.to <= end),
      );
      if (!ok) out.push(`no fill at the end of bar ${end / BAR}`);
    }
  }
  // Curves end where their control sits, except the fade at the end; one clip at a time per control.
  for (const a of p.automation)
    if (a.purpose !== 'fade' && a.points[a.points.length - 1]!.value !== 'neutral') out.push(`${a.purpose} at ${a.start / BAR} ends off its control's value`);
  const targets = new Map<string, [number, number][]>();
  for (const a of p.automation) {
    const key = JSON.stringify(a.target);
    const spans = targets.get(key) ?? [];
    if (spans.some(([x, y]) => x < a.start + a.length && a.start < y)) out.push(`two curves on ${key} at ${a.start / BAR}`);
    spans.push([a.start, a.start + a.length]);
    targets.set(key, spans);
  }
  return out;
}

describe('planning a song', () => {
  it('lays out a trap song: sections, clips, transitions and the counts', () => {
    const s = song();
    const { Beat, Keys, Drums, Melody } = s.patterns as Record<string, PatternId>;
    const p = plan(s, {
      style: 'trap',
      ending: 'auto',
      sections: [
        spec('Intro', 'intro', 8, [Keys!]),
        spec('Verse', 'verse', 16, [Drums!, Keys!]),
        spec('Build', 'build', 4, [Drums!]),
        spec('Drop', 'drop', 16, [Beat!, Melody!]),
        spec('Break', 'break', 8, [Keys!]),
        spec('Drop 2', 'drop', 16, [Beat!, Melody!]),
        spec('Outro', 'outro', 8, [Keys!]),
      ],
    });
    expect(p.to).toBe(76 * BAR);
    expect(p.markers.map((m) => [m.name, m.tick / BAR + 1])).toEqual([
      ['Intro', 1],
      ['Verse', 9],
      ['Build', 25],
      ['Drop', 29],
      ['Break', 45],
      ['Drop 2', 53],
      ['Outro', 69],
    ]);
    expect(p.boundaries.map((b) => b.kind)).toEqual(['intro', 'rise', 'same', 'rise', 'fall', 'rise', 'outro']);
    expect(p.ending.kind).toBe('stop');
    expect(p.counts.builds).toEqual([
      { riser: true, gap: true, impact: true },
      { riser: true, gap: true, impact: true },
      { riser: true, gap: true, impact: true },
    ]);
    expect(p.counts.breakdowns).toBe(1);
    expect(p.counts.fills).toBeGreaterThanOrEqual(6);
    // 2-bar beats: 8 clips per 16 bars, each lane playing one source.
    expect(p.clips.filter((c) => c.section === 3 && c.source === Beat).length).toBe(8);
    // The Drop's plain repeats are the source itself; the others are variants.
    const drop = p.clips.filter((c) => c.section === 3 && c.source === Beat);
    expect(drop.filter((c) => c.steps.length === 0).length).toBeGreaterThanOrEqual(2);
    expect(violations(p, new Set([Beat!, Drums!]))).toEqual([]);
    // The beat's crash on its first step moves into placed crashes.
    expect(p.loopCrashes).toEqual([{ patternId: Beat, channelId: s.kit.crash, ticks: [0] }]);
    // Quieter sections that play a loud beat get thinner drums.
    const thin = planArrangement(
      s.project,
      { from: 0, fx: 'auto', style: 'trap', ending: 'fade', sections: [spec('Break', 'break', 8, [Beat!], { energy: 2 }), spec('Drop', 'drop', 8, [Beat!])] },
      { variant: variantEnv(s.project, { style: 'trap', hint: HINT }) },
    );
    expect(thin.clips.filter((c) => c.section === 0).every((c) => c.steps.some((st) => st.kind === 'thin' && st.level === 2))).toBe(true);
  });

  it('keeps its promises for any list of sections (property)', () => {
    const s = song();
    const ids = s.patterns as Record<string, PatternId>;
    const drums = new Set([ids.Beat!, ids.Drums!]);
    const section = fc.record({
      bars: fc.oneof(fc.constantFrom(4, 8, 8, 16), fc.integer({ min: 1, max: 16 })),
      role: fc.constantFrom(...SECTION_ROLES),
      energy: fc.integer({ min: 1, max: 5 }),
      play: fc.subarray(['Beat', 'Drums', 'Keys', 'Melody'], { minLength: 1, maxLength: 2 }),
      vary: fc.constantFrom('auto' as const, 'auto' as const, 'more' as const, 'less' as const),
    });
    fc.assert(
      fc.property(
        fc.array(section, { minLength: 1, maxLength: 8 }),
        fc.constantFrom(...STYLES),
        fc.constantFrom('auto' as const, 'fade' as const, 'stop' as const),
        (list, style: Style, ending) => {
          const sections = list.map((x, i) => spec(`S${i + 1}`, x.role, x.bars, x.play.map((n) => ids[n]!), { energy: x.energy, vary: x.vary }));
          const p = plan(s, { style, ending, sections });
          expect(p.to - p.from).toBe(list.reduce((n, x) => n + x.bars, 0) * BAR);
          expect(violations(p, drums)).toEqual([]);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('with fx none: fills, gaps and crashes but no sounds or automation', () => {
    const s = song();
    const { Beat, Keys } = s.patterns as Record<string, PatternId>;
    const p = plan(s, {
      style: 'house',
      ending: 'fade',
      fx: 'none',
      sections: [spec('Intro', 'intro', 8, [Keys!]), spec('Drop', 'drop', 8, [Beat!])],
    });
    expect(p.fx).toEqual([]);
    expect(p.automation).toEqual([]);
    expect(p.boundaries[1]!.end.map((e) => e.kind)).toContain('gap');
    expect(p.crashes.length).toBeGreaterThan(0);
  });
});
