import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { p as params, type ParamSpecs } from '@agstudio/sdk/params';
import { resolveTarget } from '../automation/targets';
import { makeInsert, makePluginInstance } from '../model/defaults';
import { newId } from '../model/ids';
import type { AudioClipChannel, Clip, InsertId, PatternClip, PatternId, Project, SlotId } from '../model/types';
import { constantTempo } from '../time/ppq';
import { BAR, BEAT, HINT, kitProject, notes, trapGroove } from '../../../test/helpers/arrange';
import { projectViolations } from '../../../test/helpers/project-invariants';
import { applyArrangement, applyEventsInPlace, collectGarbage, deriveVariant, refreshVariants, type ApplyEnv } from './apply';
import { notesHash } from './notes';
import { planArrangement, type ArrangeRequest } from './plan';
import { DEFAULT_ENERGY, type SectionRole, type SectionSpec } from './sections';
import { variantEnv } from './variants';

/** EQ Pro's sweep bands, as the app's registry would give them. */
const EQ: ParamSpecs = {
  b1Freq: params.float(20, 20000, 30, { scale: 'log', unit: 'Hz' }),
  b8Freq: params.float(20, 20000, 18000, { scale: 'log', unit: 'Hz' }),
};

function setup() {
  const s = kitProject((k) => ({
    Beat: { notes: trapGroove(k) },
    Keys: { notes: { [k.pad]: notes([[0, 53, 32], [0, 60, 32]]) } as never },
  }));
  // A chords bus with an EQ Pro whose sweep bands sit at neutral.
  let chords!: { insertId: InsertId; slotId: SlotId };
  const project = produce(s.project, (d) => {
    const id = newId.insert();
    d.mixer.inserts[id] = makeInsert(id, 'Chords');
    d.mixer.order.push(id);
    const slotId = newId.slot();
    d.mixer.inserts[id]!.fx.push({
      id: slotId,
      plugin: makePluginInstance('agstudio.eq-pro', 1, { b1On: true, b1Freq: 20, b8On: true, b8Freq: 20000 }),
      enabled: true,
      mix: 1,
      sidechain: null,
    });
    chords = { insertId: id, slotId };
  });
  const venv = variantEnv(project, { style: 'trap', hint: HINT });
  const env: ApplyEnv = {
    variant: venv,
    specsOf: (id) => (id === 'agstudio.eq-pro' ? EQ : undefined),
    tempo: constantTempo(project.transport.bpm),
    targets: { chords },
  };
  return { ...s, project, env, chords };
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

function arrange(project: Project, env: ApplyEnv, req: Partial<ArrangeRequest> & { sections: SectionSpec[] }) {
  const plan = planArrangement(project, { from: 0, style: 'trap', fx: 'auto', ending: 'auto', ...req }, { variant: env.variant });
  let report!: ReturnType<typeof applyArrangement>;
  const next = produce(project, (d) => {
    report = applyArrangement(d, plan, env, { replace: true });
  });
  return { plan, next, report };
}

const clipsOf = (p: Project) => Object.values(p.playlist.clips) as Clip[];

function laneOverlaps(p: Project): string[] {
  const out: string[] = [];
  for (const lane of p.playlist.laneOrder) {
    const list = clipsOf(p)
      .filter((c) => c.laneId === lane)
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++)
      if (list[i]!.start < list[i - 1]!.start + list[i - 1]!.length) out.push(`${p.playlist.lanes[lane]!.name} at bar ${list[i]!.start / BAR + 1}`);
  }
  return out;
}

describe('writing an arrangement', () => {
  it('writes clips, variants, FX, crashes, automation and markers that keep every promise', () => {
    const s = setup();
    const { Beat, Keys } = s.patterns as Record<string, PatternId>;
    const { next, report, plan } = arrange(s.project, s.env, {
      sections: [spec('Intro', 'intro', 8, [Keys!]), spec('Verse', 'verse', 8, [Beat!], { energy: 3 }), spec('Drop', 'drop', 16, [Beat!])],
    });
    expect(projectViolations(next)).toEqual([]);
    expect(laneOverlaps(next)).toEqual([]);
    // Lanes are named after what they play.
    const laneName = (c: Clip) => next.playlist.lanes[c.laneId]!.name;
    const names = new Set(clipsOf(next).map(laneName));
    for (const n of ['Beat', 'Keys', 'FX risers', 'FX swells', 'FX hits', 'Crashes', 'Automation 1']) expect(names).toContain(n);
    // Variants record where they came from and are named for what changed.
    const variants = Object.values(next.patterns).filter((x) => x.derived);
    expect(variants.length).toBe(report.variants);
    expect(variants.every((v) => v.derived!.from === Beat && v.name.startsWith('Beat · ') && notesHash(v.notes) === v.derived!.hash)).toBe(true);
    expect(variants.some((v) => v.name.includes('fill'))).toBe(true);
    // Plain repeats point at the source; the beat's loop crash moved into crash hits.
    expect(clipsOf(next).some((c) => c.kind === 'pattern' && c.patternId === Beat)).toBe(true);
    expect(next.patterns[Beat!]!.notes[s.kit.crash]).toBeUndefined();
    expect(report.movedCrashes).toEqual([{ patternId: Beat, count: 1 }]);
    // FX play on audio clip channels that follow the tempo; the reverse crash ends on the drop.
    const X = 16 * BAR;
    const fx = clipsOf(next).filter((c) => c.kind === 'audio' && laneName(c).startsWith('FX'));
    for (const c of fx) {
      const ch = next.channels[(c as { channelId: string }).channelId as never] as AudioClipChannel;
      expect(ch).toMatchObject({ kind: 'audioClip', stretch: 'resample', sourceBpm: 140 });
    }
    const swells = fx.filter((c) => laneName(c) === 'FX swells');
    expect(swells.map((c) => (c.start + c.length) / BAR)).toEqual([8, 16]);
    expect((swells[1] as { gain?: number }).gain).toBeCloseTo(10 ** (-3 / 20), 6);
    expect(fx.find((c) => laneName(c) === 'FX hits' && c.start === X)).toBeDefined();
    // The sweep on the chords bus ends where the EQ band sits.
    const sweep = Object.values(next.channels).find((c) => c.kind === 'automation' && c.name.startsWith('Sweep up'))!;
    if (sweep.kind !== 'automation') throw new Error('no sweep');
    const res = resolveTarget(next, sweep.target!, s.env.specsOf)!;
    expect(sweep.points[sweep.points.length - 1]!.value).toBeCloseTo(res.toNormalized(res.base), 9);
    expect(Object.values(next.playlist.markers).map((m) => [m.name, m.tick / BAR])).toEqual(
      expect.arrayContaining([
        ['Intro', 0],
        ['Verse', 8],
        ['Drop', 16],
      ]),
    );
    expect(plan.boundaries.map((b) => b.kind)).toEqual(['intro', 'rise', 'rise']);
  });

  it('arranging twice gives the same patterns, clips and channels (it cleans up its own)', () => {
    const s = setup();
    const { Beat, Keys } = s.patterns as Record<string, PatternId>;
    const sections = [spec('Intro', 'intro', 4, [Keys!]), spec('Drop', 'drop', 8, [Beat!]), spec('Break', 'break', 4, [Keys!]), spec('Drop 2', 'drop', 8, [Beat!])];
    const once = arrange(s.project, s.env, { sections }).next;
    const twice = arrange(once, s.env, { sections }).next;
    const counts = (p: Project) => [Object.keys(p.patterns).length, Object.keys(p.playlist.clips).length, Object.keys(p.channels).length, Object.keys(p.samples).length, Object.keys(p.playlist.markers).length, p.playlist.laneOrder.length];
    expect(counts(twice)).toEqual(counts(once));
    // Arranging the same bars with fewer changes removes the variants and sounds it no longer uses.
    const plain = sections.map((x) => ({ ...x, vary: 'none' as const }));
    const less = arrange(twice, s.env, { sections: plain, fx: 'none', ending: 'fade' }).next;
    const derived = (p: Project) => Object.values(p.patterns).filter((x) => x.derived).length;
    expect(derived(less)).toBeLessThan(derived(twice));
    expect(Object.values(less.channels).filter((c) => c.kind === 'audioClip' && c.name !== 'Crash hits')).toEqual([]);
    expect(Object.values(less.patterns).filter((x) => x.derived).every((v) => clipsOf(less).some((c) => c.kind === 'pattern' && c.patternId === v.id))).toBe(true);
    expect(projectViolations(less)).toEqual([]);
  });
});

describe('variants follow their source', () => {
  it('reuses an identical variant and rebuilds unmodified ones when the source changes; hand edits stay', () => {
    const s = setup();
    const Beat = s.patterns.Beat!;
    const fill = { kind: 'snare-fill' as const, from: 2 * BAR - 2 * BEAT, to: 2 * BAR, energy: 4 };
    const roll = { kind: 'hat-roll' as const, from: BAR - BEAT, to: BAR, energy: 4 };
    let a!: PatternId;
    let b!: PatternId;
    let c!: PatternId;
    let p = produce(s.project, (d) => {
      a = deriveVariant(d, Beat, [fill], s.env.variant);
      b = deriveVariant(d, Beat, [{ ...fill }], s.env.variant);
      c = deriveVariant(d, Beat, [roll], s.env.variant);
    });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(p.patterns[a]!.name).toBe('Beat · fill');
    expect(p.patternOrder.slice(0, 3)).toEqual([Beat, a, c]);
    // Someone edits the roll variant by hand, then the source's kick moves.
    p = produce(p, (d) => {
      const n = Object.values(d.patterns[c]!.notes[s.kit.kick]!)[0]!;
      n.velocity = 0.3;
      const k = Object.values(d.patterns[Beat]!.notes[s.kit.kick]!)[0]!;
      k.tick = 120;
    });
    let report!: ReturnType<typeof refreshVariants>;
    const q = produce(p, (d) => {
      report = refreshVariants(d, s.env.variant, new Set([Beat]));
    });
    expect(report).toEqual({ rebuilt: [a], handEdited: [c] });
    expect(Object.values(q.patterns[a]!.notes[s.kit.kick]!).some((n) => n.tick === 120)).toBe(true);
    expect(notesHash(q.patterns[a]!.notes)).toBe(q.patterns[a]!.derived!.hash);
    expect(q.patterns[c]!.notes).toEqual(p.patterns[c]!.notes);
    // A variant nothing plays goes; a hand-edited one stays.
    const r = produce(q, (d) => {
      collectGarbage(d, { patterns: [a, c], channels: [] });
    });
    expect(r.patterns[a]).toBeUndefined();
    expect(r.patterns[c]).toBeDefined();
  });
});

describe('changing a song in place', () => {
  it('splits a long looping clip so only the repeat with the fill becomes a variant', () => {
    const s = setup();
    const Beat = s.patterns.Beat!;
    const lane = s.project.playlist.laneOrder[0]!;
    const start = produce(s.project, (d) => {
      d.playlist.clips['clip_long' as never] = { kind: 'pattern', id: 'clip_long', laneId: lane, start: 0, length: 16 * BAR, patternId: Beat, offset: 0 } as never;
    });
    let changed: string[] = [];
    const next = produce(start, (d) => {
      changed = applyEventsInPlace(d, [{ kind: 'snare-fill', from: 8 * BAR - 2 * BEAT, to: 8 * BAR, energy: 4, why: 'phrase' }], s.env);
    });
    const clips = (clipsOf(next) as PatternClip[]).sort((a, b) => a.start - b.start);
    expect(clips.map((c) => [c.start / BAR, c.length / BAR, c.patternId === Beat ? 'source' : next.patterns[c.patternId]!.name])).toEqual([
      [0, 6, 'source'],
      [6, 2, 'Beat · fill'],
      [8, 8, 'source'],
    ]);
    expect(changed).toHaveLength(1);
    // Content keeps playing in step: the last piece starts at content tick 0 again.
    expect(clips[2]!.offset % (2 * BAR)).toBe(0);
    // Doing it again changes nothing (the same variant).
    const again = produce(next, (d) => {
      applyEventsInPlace(d, [{ kind: 'snare-fill', from: 8 * BAR - 2 * BEAT, to: 8 * BAR, energy: 4, why: 'phrase' }], s.env);
    });
    expect(Object.keys(again.patterns)).toEqual(Object.keys(next.patterns));
  });
});
