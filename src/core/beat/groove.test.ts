import { describe, expect, it } from 'vitest';
import { validateBeatSpec, type BeatSpec, type BeatTrack } from './spec';
import { GROOVE } from './style';

const ok = (raw: unknown, opts?: Parameters<typeof validateBeatSpec>[1]) => {
  const r = validateBeatSpec(raw, opts);
  if ('error' in r) throw new Error(r.error);
  return r;
};
const track = (spec: BeatSpec, name: string): BeatTrack => spec.tracks.find((t) => t.name === name)!;
const vels = (t: BeatTrack) => t.notes.map((n) => n.vel!);
const steps = (...s: number[]) => s.map((step) => ({ step }));

describe('accents for notes written without a velocity', () => {
  const beat = {
    title: 't',
    bars: 1,
    style: 'trap',
    tracks: [
      { name: 'Hat', sound: 'hat', notes: steps(0, 1, 2, 3, 4, 5, 6, 7) },
      { name: 'Kick', sound: 'kick', notes: steps(0, 4, 7, 16 - 2) },
      { name: 'Snare', sound: 'snare', notes: [...steps(4, 7, 12), { step: 15, vel: 0.33 }] },
      { name: '808', sound: '808', notes: [{ step: 0, key: 29, len: 7 }] },
      { name: 'Keys', sound: 'keys', notes: [{ step: 0, key: 60 }] },
    ],
  };

  it('accents hats per 1/16 of the beat, kicks on the downbeat and snares on the backbeat', () => {
    const { spec, style } = ok(beat);
    expect(style).toBe('trap');
    const g = GROOVE.trap;
    const near = (actual: number[], expected: number[]) =>
      actual.forEach((v, i) => expect(Math.abs(v - expected[i]!), `note ${i}: ${v} vs ${expected[i]}`).toBeLessThanOrEqual(g.jitter + 1e-9));
    near(vels(track(spec, 'Hat')), [...g.hat, ...g.hat]);
    near(vels(track(spec, 'Kick')), [1, 0.92, 0.82, 0.82]);
    // The AI's own velocity stays exactly as written; the off-beat snare is a ghost.
    expect(vels(track(spec, 'Snare'))[3]).toBe(0.33);
    near(vels(track(spec, 'Snare')).slice(0, 3), [1, 0.45, 1]);
    near(vels(track(spec, '808')), [0.9]);
    near(vels(track(spec, 'Keys')), [0.8]);
  });

  it('is deterministic and varies a little (seeded jitter)', () => {
    const a = vels(track(ok(beat).spec, 'Hat'));
    const b = vels(track(ok(beat).spec, 'Hat'));
    expect(a).toEqual(b);
    expect(new Set(a.map((v, i) => v - GROOVE.trap.hat[i % 4]!)).size).toBeGreaterThan(1);
  });

  it('treats a dembow snare (no hit on a beat) as main hits, not ghosts', () => {
    const { spec } = ok({ title: 't', bars: 1, style: 'reggaeton', tracks: [{ name: 'Snare', sound: 'snare', notes: steps(3, 6, 11, 14) }] });
    for (const v of vels(spec.tracks[0]!)) expect(v).toBeGreaterThan(0.9);
  });

  it('makes rolls rise', () => {
    const roll = [6, 6.5, 7, 7.5].map((step) => ({ step, len: 0.5 }));
    const { spec } = ok({ title: 't', bars: 1, style: 'trap', tracks: [{ name: 'Hat', sound: 'hat', notes: roll }] });
    const v = vels(spec.tracks[0]!);
    for (let i = 1; i < v.length; i++) expect(v[i]!).toBeGreaterThan(v[i - 1]!);
    expect(v[0]!).toBeLessThan(0.55);
    expect(v[3]!).toBeGreaterThan(0.85);
  });

  it('guesses the style from the beat when none is given, and leaves velocities alone without any', () => {
    const house = {
      title: 't',
      bars: 1,
      tracks: [
        { name: 'Kick', sound: 'kick', notes: steps(0, 4, 8, 12) },
        { name: 'Hat', sound: 'hat', notes: steps(2, 6, 10, 14) },
      ],
    };
    const guessed = ok(house, { project: { bpm: 124, swing: 0 } });
    expect(guessed.style).toBe('house');
    expect(guessed.spec.style).toBe('house');
    // House hats are accented on the "and".
    for (const v of vels(track(guessed.spec, 'Hat'))) expect(v).toBeGreaterThan(0.85);
    const plain = ok(house);
    expect(plain.style).toBeNull();
    expect(vels(track(plain.spec, 'Hat'))).toEqual([0.8, 0.8, 0.8, 0.8]);
  });
});

describe('open hats on their own channel', () => {
  it('stop at the next closed hat (at most 2 steps) or their own next hit', () => {
    const { spec } = ok({
      title: 't',
      bars: 1,
      style: 'house',
      tracks: [
        { name: 'Hat', sound: 'hat', notes: steps(0, 4, 15) },
        { name: 'Open', sound: 'open-hat', notes: [{ step: 2 }, { step: 6 }, { step: 7 }, { step: 14 }, { step: 10, len: 4 }] },
      ],
    });
    const open = track(spec, 'Open').notes.map((n) => [n.step, n.len]);
    // 2 → closed hat at 4; 6 → its own hit at 7; 7 → 2 steps; 10 (len 4 given) → the next open hat at 14; 14 → closed at 15.
    expect(open).toEqual([
      [2, 2],
      [6, 1],
      [7, 2],
      [10, 4],
      [14, 1],
    ]);
  });
});

describe('levels', () => {
  it('reads volume_db, a negative volume as dB, and 2–100 as a percentage', () => {
    const { spec } = ok({
      title: 't',
      bars: 1,
      tracks: [
        { name: 'A', sound: 'kick', notes: [], volume_db: -6 },
        { name: 'B', sound: 'kick', notes: [], volume: -6 },
        { name: 'C', sound: 'kick', notes: [], volume: 80 },
        { name: 'D', sound: 'kick', notes: [], volume: 0.5 },
        { name: 'E', sound: 'kick', notes: [], volume_db: 12 },
        { name: 'F', sound: 'kick', notes: [], volume_db: -200 },
      ],
    });
    const v = spec.tracks.map((t) => t.volume!);
    expect(v[0]).toBeCloseTo(0.501, 3);
    expect(v[1]).toBeCloseTo(0.501, 3);
    expect(v[2]).toBe(0.8);
    expect(v[3]).toBe(0.5);
    expect(v[4]).toBeCloseTo(Math.pow(10, 1.9 / 20), 6);
    expect(v[5]).toBe(0);
  });

  it('keeps a preset name and reports an unknown style', () => {
    const { spec, warnings } = ok({
      title: 't',
      bars: 1,
      style: 'polka',
      tracks: [{ name: 'Lead', sound: 'lead', preset: '  Glassy pluck ', notes: [{ step: 0, key: 60 }] }],
    });
    expect(spec.tracks[0]!.preset).toBe('Glassy pluck');
    expect(spec.style).toBeUndefined();
    expect(warnings.some((w) => w.includes('polka'))).toBe(true);
  });
});
