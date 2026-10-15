import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { steppedTempo } from '../time/tempo';
import { fakeAnalysis, type FakeSong } from './fake-analysis';
import { autoOrder, orderCost } from './order';
import { BASS_CUT_HZ, planMix, type MixOptions, type MixPlan, type MixTrackInput } from './plan';
import { camelotOf, harmonicMove, tempoMatch, TEMPO_LIMIT } from './wheel';

const BEAT = 960;
const BAR = 4 * BEAT;

const track = (id: string, s: FakeSong, pinned = false): MixTrackInput => ({ id, title: id, analysis: fakeAnalysis({ hash: id, ...s }), pinned });

/** Source seconds at song tick `t` of a planned song (from the clip that covers it). */
function sourceAt(plan: MixPlan, songId: string, t: number): number | null {
  const s = plan.songs.find((x) => x.id === songId)!;
  const c = s.clips.find((k) => t >= k.start && t < k.start + k.length);
  if (!c) return null;
  return c.offsetSec + ((t - c.start) / BEAT) * (60 / s.bpm);
}

/** True when source second `sec` of a song is on one of its downbeats. */
function onDownbeat(plan: MixPlan, songId: string, sec: number, input: MixTrackInput): boolean {
  const s = plan.songs.find((x) => x.id === songId)!;
  const g = input.analysis.grid!;
  const bars = (sec - g.firstDownbeat) / ((4 * 60) / s.bpm);
  return Math.abs(bars - Math.round(bars)) < 1e-6;
}

function checkPlan(plan: MixPlan, inputs: readonly MixTrackInput[], opts: Partial<MixOptions>): void {
  const byId = new Map(inputs.map((t) => [t.id, t]));
  // No more than two songs at once.
  const edges = plan.songs.flatMap((s) => [
    { t: s.start, d: 1 },
    { t: s.end, d: -1 },
  ]);
  edges.sort((a, b) => a.t - b.t || a.d - b.d);
  let live = 0;
  for (const e of edges) {
    live += e.d;
    expect(live).toBeLessThanOrEqual(2);
  }
  // Clips tile each song.
  for (const s of plan.songs) {
    expect(s.clips[0]!.start).toBe(s.start);
    let t = s.start;
    for (const c of s.clips) {
      expect(c.start).toBe(t);
      expect(c.length).toBeGreaterThan(0);
      t += c.length;
    }
    expect(t).toBe(s.end);
  }
  // Transitions start (and end) on downbeats of both songs.
  for (const tr of plan.transitions) {
    expect(tr.start % BAR).toBe(0);
    for (const t of tr.length > 0 ? [tr.start, tr.start + tr.length - BAR] : [tr.start]) {
      const a = sourceAt(plan, tr.from, t);
      const b = sourceAt(plan, tr.to, t);
      const A = plan.songs.find((x) => x.id === tr.from)!;
      if (tr.length > 0 || a !== null) {
        if (a !== null && A.beatMatched) expect(onDownbeat(plan, tr.from, a, byId.get(tr.from)!)).toBe(true);
      }
      if (b !== null && plan.songs.find((x) => x.id === tr.to)!.beatMatched) expect(onDownbeat(plan, tr.to, b, byId.get(tr.to)!)).toBe(true);
    }
  }
  // Tempo: a song never plays further than the limit from its tempo (follow mode); a stretched piece
  // plays at one tempo.
  const map = steppedTempo(plan.tempo);
  const follow = opts.mixTempo === undefined || opts.mixTempo === 'follow';
  for (const s of plan.songs) {
    expect(s.follow).toBe(!s.beatMatched ? 'off' : opts.keyLock || !follow ? 'stretch' : 'resample');
    if (s.follow === 'resample') expect(s.clips).toHaveLength(1);
    for (const c of s.clips) if (s.follow === 'stretch') expect(map.nextChange(c.start)).toBeGreaterThanOrEqual(c.start + c.length);
    if (follow && s.beatMatched)
      for (let t = s.start; t < s.end; t = map.nextChange(t)) expect(Math.abs(map.bpmAt(t) / s.bpm - 1)).toBeLessThanOrEqual(TEMPO_LIMIT + 1e-9);
  }
  // The total is where the last song ends.
  expect(plan.totalTicks).toBe(Math.max(...plan.songs.map((s) => s.end)));
  expect(plan.durationSec).toBeCloseTo(map.tickToSeconds(plan.totalTicks), 6);
  // Every curve ends where its control sits.
  for (const a of plan.automation) {
    const last = a.points[a.points.length - 1]!;
    expect(last.value).toBe('neutral');
    expect(last.at).toBeLessThanOrEqual(a.length);
    for (const p of a.points) expect(p.at).toBeGreaterThanOrEqual(0);
  }
  // Every song plays from its source within the file.
  for (const s of plan.songs) {
    const dur = byId.get(s.id)!.analysis.durationSec;
    for (const c of s.clips) expect(c.offsetSec).toBeLessThanOrEqual(dur + 1e-6);
  }
}

describe('Camelot wheel', () => {
  it('codes keys like DJ software', () => {
    expect(camelotOf(0, 'major')).toBe('8B');
    expect(camelotOf(9, 'minor')).toBe('8A');
    expect(camelotOf(7, 'major')).toBe('9B');
    expect(camelotOf(4, 'minor')).toBe('9A');
    expect(camelotOf(5, 'major')).toBe('7B');
    expect(camelotOf(11, 'major')).toBe('1B');
  });

  it('names harmonic moves', () => {
    const k = (camelot: string) => ({ root: 0, mode: 'major' as const, camelot: camelot as never, confidence: 0.9 });
    expect(harmonicMove(k('8A'), k('8A'))).toBe('same');
    expect(harmonicMove(k('8A'), k('9A'))).toBe('step');
    expect(harmonicMove(k('12A'), k('1A'))).toBe('step');
    expect(harmonicMove(k('8A'), k('8B'))).toBe('relative');
    expect(harmonicMove(k('8A'), k('10A'))).toBe('boost');
    expect(harmonicMove(k('8A'), k('3B'))).toBe('clash');
    expect(harmonicMove(k('8A'), null)).toBe('unknown');
  });

  it('matches half and double time', () => {
    expect(tempoMatch(128, 126).factor).toBe(1);
    expect(tempoMatch(70, 140).factor).toBe(0.5);
    expect(tempoMatch(140, 72).factor).toBe(2);
    expect(tempoMatch(100, 128).deviation).toBeGreaterThan(TEMPO_LIMIT);
  });
});

describe('auto order', () => {
  const songs = [
    track('a', { bpm: 128, key: { root: 9, mode: 'minor' }, lufs: -8 }), // 8A
    track('b', { bpm: 122, key: { root: 6, mode: 'major' }, lufs: -12 }), // 2B
    track('c', { bpm: 126, key: { root: 4, mode: 'minor' }, lufs: -9 }), // 9A
    track('d', { bpm: 124, key: { root: 0, mode: 'major' }, lufs: -11 }), // 8B
  ];

  it('builds harmonic, tempo-close runs and beats the input order', () => {
    const items = songs.map((s) => ({ analysis: s.analysis }));
    const order = autoOrder(items, 'build');
    expect(order.slice().sort()).toEqual([0, 1, 2, 3]);
    expect(orderCost(items, order, 'build')).toBeLessThan(orderCost(items, [0, 1, 2, 3], 'build'));
    // 8B, 8A, 9A neighbours: never the clashing 2B in the middle of them.
    const keys = order.map((i) => songs[i]!.analysis.key!.camelot);
    const iA = keys.indexOf('8A');
    expect(Math.abs(keys.indexOf('9A') - iA) === 1 || Math.abs(keys.indexOf('8B') - iA) === 1).toBe(true);
  });

  it('never moves a pinned song', () => {
    const items = songs.map((s, i) => ({ analysis: s.analysis, pinned: i === 1 }));
    for (const shape of ['build', 'party', 'chill', 'peak-time'] as const) expect(autoOrder(items, shape)[1]).toBe(1);
  });

  it('is deterministic', () => {
    const items = songs.map((s) => ({ analysis: s.analysis }));
    expect(autoOrder(items, 'party')).toEqual(autoOrder(items, 'party'));
  });
});

describe('planMix', () => {
  const three = [
    track('one', { bpm: 124, key: { root: 9, mode: 'minor' }, bars: 96 }),
    track('two', { bpm: 126, key: { root: 4, mode: 'minor' }, bars: 96, firstDownbeat: 0.37 }),
    track('three', { bpm: 128, key: { root: 11, mode: 'minor' }, bars: 96 }),
  ];

  it('overlaps phrases: the mix-out of one on the mix-in of the next, on a bar line', () => {
    const plan = planMix(three, { order: 'keep' });
    checkPlan(plan, three, {});
    expect(plan.songs.map((s) => s.deck)).toEqual(['A', 'B', 'A']);
    const [t1] = plan.transitions;
    expect(t1!.bars).toBe(16);
    expect(t1!.recipe).toBe('bass-swap');
    // Song one is at its mix-out (bar 64 of 96) where song two starts at its first downbeat.
    const a = sourceAt(plan, 'one', t1!.start)!;
    expect(a).toBeCloseTo(three[0]!.analysis.mixOut, 6);
    const b = sourceAt(plan, 'two', t1!.start)!;
    expect(b).toBeCloseTo(three[1]!.analysis.mixIn, 6);
    // Beats line up across the overlap: every bar of it is a downbeat in both songs.
    for (let t = t1!.start; t < t1!.start + t1!.length; t += BAR) {
      expect(onDownbeat(plan, 'one', sourceAt(plan, 'one', t)!, three[0]!)).toBe(true);
      expect(onDownbeat(plan, 'two', sourceAt(plan, 'two', t)!, three[1]!)).toBe(true);
    }
  });

  it('glides the tempo through transitions, the songs following like turntables', () => {
    const plan = planMix(three, { order: 'keep' });
    const map = steppedTempo(plan.tempo);
    const [t1] = plan.transitions;
    expect(map.bpmAt(t1!.start - 1)).toBe(124);
    expect(map.bpmAt(t1!.start)).toBe(124);
    expect(map.bpmAt(t1!.start + t1!.length / 2)).toBe(125);
    expect(map.bpmAt(t1!.start + t1!.length)).toBe(126);
    // One step per 1/16 inside the glide, as the tempo automation plays it.
    expect(map.nextChange(t1!.start)).toBe(t1!.start + 240);
    expect(plan.tempoCurve.slice(0, 3)).toEqual([
      { tick: 0, bpm: 124, ramp: false },
      { tick: t1!.start, bpm: 124, ramp: true },
      { tick: t1!.start + t1!.length, bpm: 126, ramp: false },
    ]);
    for (const s of plan.songs) expect(s.follow).toBe('resample');
    expect(plan.songs[0]!.clips[0]!.offsetSec).toBe(0);
  });

  it('with key lock, steps the tempo on bar lines and splits the stretched clips there', () => {
    const plan = planMix(three, { order: 'keep', keyLock: true });
    checkPlan(plan, three, { keyLock: true });
    const map = steppedTempo(plan.tempo);
    const [t1] = plan.transitions;
    const inside = map.bpmAt(t1!.start + t1!.length / 2);
    expect(inside).toBeGreaterThan(124);
    expect(inside).toBeLessThan(126);
    for (const p of plan.tempo) expect(p.tick % 3840).toBe(0);
    // Solo parts play at the song's own tempo (no stretching needed).
    expect(map.bpmAt(plan.songs[0]!.clips[0]!.start)).toBe(plan.songs[0]!.bpm);
    expect(plan.songs[1]!.clips.length).toBeGreaterThan(2);
    expect(plan.songs.every((s) => s.follow === 'stretch')).toBe(true);
  });

  it('writes the bass swap: incoming lows cut until the midpoint, then the outgoing ones', () => {
    const plan = planMix(three, { order: 'keep' });
    const t1 = plan.transitions[0]!;
    const items = plan.automation.filter((a) => a.transition === 0);
    const bassIn = items.find((a) => a.purpose === 'bass-in')!;
    const bassOut = items.find((a) => a.purpose === 'bass-out')!;
    expect(bassIn.deck).toBe('B');
    expect(bassOut.deck).toBe('A');
    expect(bassIn.points[0]).toEqual({ at: 0, value: BASS_CUT_HZ });
    expect(bassIn.start + bassIn.length).toBe(t1.swap);
    expect(bassOut.start).toBe(t1.swap);
    expect(t1.swap).toBe(t1.start + 8 * BAR);
    const fadeIn = items.find((a) => a.purpose === 'fade-in')!;
    expect(fadeIn.points[0]!.value).toBe(0);
    // Equal power: in² + out² = 1 along the way.
    const fadeOut = items.find((a) => a.purpose === 'fade-out')!;
    for (let k = 0; k < 8; k++) {
      const i = fadeIn.points[k]!.value as number;
      const o = fadeOut.points[k]!.value as number;
      expect(i * i + o * o).toBeCloseTo(1, 5);
    }
  });

  it('cuts with an echo between songs too far apart in tempo', () => {
    const songs = [track('slow', { bpm: 92, key: { root: 0, mode: 'major' } }), track('fast', { bpm: 128, key: { root: 0, mode: 'major' } })];
    const plan = planMix(songs, { order: 'keep' });
    checkPlan(plan, songs, {});
    expect(plan.transitions[0]!.recipe).toBe('cut');
    expect(plan.transitions[0]!.length).toBe(0);
    expect(plan.automation.some((a) => a.purpose === 'echo-out' && a.start + a.length === plan.transitions[0]!.start)).toBe(true);
    const map = steppedTempo(plan.tempo);
    expect(map.bpmAt(plan.transitions[0]!.start - 1)).toBe(92);
    expect(map.bpmAt(plan.transitions[0]!.start)).toBe(128);
  });

  it('matches half time', () => {
    const songs = [track('hip', { bpm: 70 }), track('dnb', { bpm: 140 })];
    const plan = planMix(songs, { order: 'keep' });
    checkPlan(plan, songs, {});
    expect(plan.songs[1]!.factor).toBe(0.5);
    expect(plan.songs[1]!.bpm).toBe(70);
    expect(plan.transitions[0]!.recipe).not.toBe('cut');
  });

  it('plays the whole mix at one tempo when asked', () => {
    const plan = planMix(three, { order: 'keep', mixTempo: 125 });
    checkPlan(plan, three, { mixTempo: 125 });
    expect(plan.tempo).toEqual([{ tick: 0, bpm: 125 }]);
    expect(plan.fixedTempo).toBe(125);
    for (const s of plan.songs) expect(s.clips).toHaveLength(1);
  });

  it('honors tweaks of one transition', () => {
    const plan = planMix(three, { order: 'keep', tweaks: { three: { bars: 32, recipe: 'filter', riser: true } } });
    checkPlan(plan, three, {});
    const t = plan.transitions[1]!;
    expect(t.bars).toBe(32);
    expect(t.recipe).toBe('filter');
    expect(plan.automation.some((a) => a.transition === 1 && a.purpose === 'filter-out')).toBe(true);
    expect(plan.risers.find((r) => r.transition === 1)!.start + plan.risers.find((r) => r.transition === 1)!.beats * BEAT).toBe(t.swap);
    // The other transition is unchanged.
    expect(plan.transitions[0]).toEqual(planMix(three, { order: 'keep' }).transitions[0]);
  });

  it('meets a length target by mixing out earlier', () => {
    const long = planMix(three, { order: 'keep' });
    const short = planMix(three, { order: 'keep', lengthTargetMin: 6 });
    checkPlan(short, three, {});
    expect(short.durationSec).toBeLessThan(long.durationSec);
    expect(short.durationSec).toBeLessThanOrEqual(6 * 60 + 1);
    expect(short.durationSec).toBeGreaterThan(6 * 60 - 60);
  });

  it('cuts songs without a beat grid in and out', () => {
    const songs = [track('a', { bpm: 120 }), track('ambient', { bpm: 120, noGrid: true }), track('c', { bpm: 122 })];
    const plan = planMix(songs, { order: 'keep' });
    checkPlan(plan, songs, {});
    expect(plan.songs[1]!.beatMatched).toBe(false);
    expect(plan.transitions.map((t) => t.recipe)).toEqual(['cut', 'cut']);
    expect(plan.warnings.join(' ')).toMatch(/no steady beat/);
  });

  it('puts a marker at each song and levels the songs', () => {
    const songs = [track('loud', { bpm: 124, lufs: -6 }), track('quiet', { bpm: 124, lufs: -12 })];
    const plan = planMix(songs, { order: 'keep' });
    expect(plan.markers.map((m) => m.name)).toEqual(['loud', 'quiet']);
    expect(plan.markers[1]!.tick).toBe(plan.transitions[0]!.start);
    expect(plan.songs[0]!.gainDb).toBe(-3);
    expect(plan.songs[1]!.gainDb).toBe(3);
  });

  it('keeps every promise on random song lists', () => {
    const song = fc.record({
      bpm: fc.integer({ min: 8500, max: 17500 }).map((v) => v / 100),
      root: fc.integer({ min: 0, max: 11 }),
      minor: fc.boolean(),
      bars: fc.integer({ min: 24, max: 160 }),
      firstDownbeat: fc.integer({ min: 0, max: 3000 }).map((v) => v / 1000),
      mixInBar: fc.integer({ min: 0, max: 16 }),
      mixOutFromEnd: fc.integer({ min: 8, max: 48 }),
      lufs: fc.integer({ min: -16, max: -5 }),
      pinned: fc.boolean(),
    });
    const opts = fc.record({
      order: fc.constantFrom('keep' as const, 'auto' as const),
      energy: fc.constantFrom('build' as const, 'party' as const, 'chill' as const, 'peak-time' as const),
      transition: fc.constantFrom('auto' as const, 'smooth' as const, 'quick' as const, 'cut' as const),
      mixTempo: fc.constantFrom<'follow' | number>('follow', 'follow', 124),
      keyLock: fc.boolean(),
      lengthTargetMin: fc.option(fc.integer({ min: 3, max: 40 }), { nil: undefined }),
    });
    fc.assert(
      fc.property(fc.array(song, { minLength: 1, maxLength: 7 }), opts, (list, o) => {
        const inputs = list.map((s, i) =>
          track(`s${i}`, {
            bpm: s.bpm,
            key: { root: s.root, mode: s.minor ? 'minor' : 'major' },
            bars: s.bars,
            firstDownbeat: s.firstDownbeat,
            mixInBar: Math.min(s.mixInBar, s.bars - 8),
            mixOutBar: Math.max(8, s.bars - s.mixOutFromEnd),
            lufs: s.lufs,
          }, s.pinned),
        );
        const plan = planMix(inputs, o);
        expect(plan.songs).toHaveLength(inputs.length);
        checkPlan(plan, inputs, o);
        if (o.order === 'auto') inputs.forEach((t, i) => t.pinned && expect(plan.songs[i]!.id).toBe(t.id));
        else expect(plan.songs.map((s) => s.id)).toEqual(inputs.map((t) => t.id));
        // Deterministic.
        expect(planMix(inputs, o)).toEqual(plan);
      }),
      { numRuns: 150 },
    );
  });
});
