import { describe, expect, it } from 'vitest';
import type { ChannelId, Note, VariantKind, VariantStep } from '../model/types';
import { BAR, BEAT, HINT, kitProject, notes, trapGroove } from '../../../test/helpers/arrange';
import { capabilities, KIT_KEYS, slideKey } from './fills';
import { setHash, toNoteSet, type NoteSet, type WorkNote } from './notes';
import { applySteps, variantEnv } from './variants';

function setup(extra: Parameters<typeof kitProject>[0] = () => ({})) {
  const { project, kit, patterns } = kitProject((k) => ({ Groove: { notes: trapGroove(k) }, ...extra(k) }));
  const env = variantEnv(project, { style: 'trap', hint: HINT });
  return { project, kit, patterns, env };
}

const run = (s: ReturnType<typeof setup>, steps: VariantStep[], seed = 7, pattern = 'Groove') =>
  applySteps(s.project.patterns[s.patterns[pattern]!]!.notes, steps, s.env, { seed, length: 2 * BAR });

const at = (set: NoteSet, cid: ChannelId) => [...(set.get(cid) ?? [])].sort((a, b) => a.tick - b.tick);
const inSpan = (n: { tick: number }, from: number, to: number) => n.tick >= from && n.tick < to;
const same = (a: WorkNote, b: Note | WorkNote) => a.tick === b.tick && a.key === b.key && a.velocity === b.velocity && a.length === b.length;

describe('fills replace the groove in their span', () => {
  const kinds: VariantKind[] = ['snare-fill', 'tom-fill', 'hat-fill', 'kick-fill'];
  for (const kind of kinds)
    for (const beats of [1, 2, 4]) {
      it(`${kind}, ${beats} beat${beats > 1 ? 's' : ''}: no original drum note is left in the span, new hits fill it`, () => {
        const s = setup();
        const from = 2 * BAR - beats * BEAT;
        const { set, effective } = run(s, [{ kind, from, to: 2 * BAR, energy: 4 }]);
        expect(effective).toHaveLength(1);
        const source = toNoteSet(s.project.patterns[s.patterns.Groove!]!.notes);
        const drums = [s.kit.kick, s.kit.snare, s.kit.hat, s.kit.clap, s.kit.crash, ...s.kit.toms];
        let added = 0;
        for (const cid of drums) {
          const before = (source.get(cid) ?? []).filter((n) => inSpan(n, from, 2 * BAR));
          const after = at(set, cid).filter((n) => inSpan(n, from, 2 * BAR));
          // Every hit in the span is a generated one: none of the groove's notes survive there.
          for (const n of after) expect(before.some((b) => same(n, b))).toBe(false);
          added += after.length;
        }
        expect(added).toBeGreaterThanOrEqual(beats * 4);
        // Outside the span and off the drums nothing changed.
        for (const cid of drums)
          expect(at(set, cid).filter((n) => n.tick < from)).toEqual((source.get(cid) ?? []).filter((n) => n.tick < from));
        expect(at(set, s.kit.s808)).toEqual(source.get(s.kit.s808));
        expect(at(set, s.kit.pad)).toEqual(source.get(s.kit.pad));
      });
    }

  it('a snare fill rises to its last hit, the loudest', () => {
    const s = setup();
    for (const beats of [1, 2, 4]) {
      const { set } = run(s, [{ kind: 'snare-fill', from: 2 * BAR - beats * BEAT, to: 2 * BAR, energy: 5 }]);
      const fill = at(set, s.kit.snare).filter((n) => n.tick >= 2 * BAR - beats * BEAT);
      const v = fill.map((n) => n.velocity);
      for (let i = 1; i < v.length; i++) expect(v[i]!).toBeGreaterThanOrEqual(v[i - 1]!);
      expect(v[v.length - 1]).toBe(Math.max(...v));
      expect(v[0]!).toBeLessThan(v[v.length - 1]! - 0.2);
    }
  });

  it('the 2-beat snare fill has the plan’s shape: 8ths, 16ths, then 32nds', () => {
    const s = setup();
    const { set } = run(s, [{ kind: 'snare-fill', from: 2 * BAR - 2 * BEAT, to: 2 * BAR, energy: 5 }]);
    const fill = at(set, s.kit.snare).filter((n) => n.tick >= 2 * BAR - 2 * BEAT);
    expect(fill.map((n) => (n.tick - (2 * BAR - 2 * BEAT)) / 240)).toEqual([0, 2, 4, 5, 6, 6.5, 7, 7.5]);
    // Energy scales the velocities (1 plays them at 80 %).
    const soft = at(run(s, [{ kind: 'snare-fill', from: 2 * BAR - 2 * BEAT, to: 2 * BAR, energy: 1 }]).set, s.kit.snare).filter(
      (n) => n.tick >= 2 * BAR - 2 * BEAT,
    );
    expect(Math.max(...soft.map((n) => n.velocity))).toBeLessThan(0.86);
  });

  it('a tom fill goes high, mid, low and ends on the loudest snare', () => {
    const s = setup();
    const { set } = run(s, [{ kind: 'tom-fill', from: 2 * BAR - 2 * BEAT, to: 2 * BAR, energy: 4 }]);
    const hits = [...s.kit.toms, s.kit.snare]
      .flatMap((cid) => at(set, cid).filter((n) => n.tick >= 2 * BAR - 2 * BEAT).map((n) => ({ cid, ...n })))
      .sort((a, b) => a.tick - b.tick);
    expect(hits.map((h) => s.kit.toms.indexOf(h.cid))).toEqual([0, 0, 0, 1, 1, 1, 2, -1]);
    const last = hits[hits.length - 1]!;
    expect(last.cid).toBe(s.kit.snare);
    expect(last.velocity).toBe(Math.max(...hits.map((h) => h.velocity)));
  });

  it('a hat roll: eight rising 1/32s replacing the hats of that beat (triplets for drill)', () => {
    const s = setup();
    const { set } = run(s, [{ kind: 'hat-roll', from: BAR - BEAT, to: BAR, energy: 4 }]);
    const roll = at(set, s.kit.hat).filter((n) => inSpan(n, BAR - BEAT, BAR));
    expect(roll.map((n) => n.tick - (BAR - BEAT))).toEqual([0, 120, 240, 360, 480, 600, 720, 840]);
    const v = roll.map((n) => n.velocity);
    for (let i = 1; i < v.length; i++) expect(v[i]!).toBeGreaterThan(v[i - 1]!);
    expect(v[0]!).toBeCloseTo(0.45 * 0.95, 1);
    expect(v[7]!).toBeCloseTo(0.9 * 0.95, 1);
    // The kick and snare of that beat stay.
    expect(at(set, s.kit.snare)).toEqual(at(toNoteSet(s.project.patterns[s.patterns.Groove!]!.notes), s.kit.snare));
    const drill = variantEnv(s.project, { style: 'drill', hint: HINT });
    const tri = applySteps(s.project.patterns[s.patterns.Groove!]!.notes, [{ kind: 'hat-roll', from: BAR - BEAT, to: BAR }], drill, {
      seed: 1,
      length: 2 * BAR,
    }).set;
    expect(at(tri, s.kit.hat).filter((n) => inSpan(n, BAR - BEAT, BAR))).toHaveLength(6);
  });

  it('an open hat on the last 8th replaces the closed hats there', () => {
    const s = setup();
    const { set } = run(s, [{ kind: 'open-hat', from: BAR - BEAT, to: BAR, energy: 4 }]);
    expect(at(set, s.kit.hat).filter((n) => inSpan(n, BAR - 480, BAR))).toEqual([]);
    expect(at(set, s.kit.openHat).map((n) => [n.tick, n.length])).toEqual([[BAR - 480, 480]]);
  });
});

describe('808 slides, gaps, dropouts', () => {
  it('a slide: a new note half a beat before the end, an octave away, overlapped by 120 ticks', () => {
    const s = setup();
    const { set } = run(s, [{ kind: 'slide', from: BAR - BEAT, to: BAR, energy: 4 }]);
    const bass = at(set, s.kit.s808).filter((n) => n.tick < BAR);
    const slideNote = bass.find((n) => n.tick === BAR - 480)!;
    const prev = bass.filter((n) => n.tick < BAR - 480).sort((a, b) => b.tick - a.tick)[0]!;
    expect(prev.tick + prev.length).toBe(BAR - 480 + 120);
    expect(slideNote.length).toBe(480);
    expect(Math.abs(slideNote.key - prev.key)).toBe(12);
    expect(slideNote.key).toBeLessThanOrEqual(48);
    expect(slideKey(29)).toBe(41);
    expect(slideKey(40)).toBe(28);
    expect(slideKey(44, { root: 5, scale: undefined as never, intervals: [0, 2, 3, 5, 7, 8, 10] } as never)).toBe(32);
  });

  it('a gap takes the drums and the 808 out and cuts the 808 still held there; the pad plays on', () => {
    const s = setup();
    const from = 2 * BAR - BEAT;
    const { set } = run(s, [{ kind: 'gap', from, to: 2 * BAR }]);
    for (const cid of [s.kit.kick, s.kit.snare, s.kit.hat]) expect(at(set, cid).filter((n) => n.tick >= from)).toEqual([]);
    for (const n of at(set, s.kit.s808)) expect(n.tick + n.length).toBeLessThanOrEqual(from);
    const pad = at(set, s.kit.pad);
    expect(pad.some((n) => n.tick < from && n.tick + n.length > from)).toBe(true);
  });

  it('a dropout also cuts held music notes at its start', () => {
    const s = setup();
    const from = 2 * BAR - 2 * BEAT;
    const { set } = run(s, [{ kind: 'dropout', from, to: 2 * BAR }]);
    // Nothing starts in the span and nothing still sounds there.
    for (const [, list] of set) for (const n of list) expect(n.tick + n.length).toBeLessThanOrEqual(from);
    const before = toNoteSet(s.project.patterns[s.patterns.Groove!]!.notes);
    expect(before.get(s.kit.pad)!.some((n) => n.tick < from && n.tick + n.length > from)).toBe(true);
  });

  it('a stutter repeats the start of the beat, getting louder', () => {
    const s = setup();
    const from = 2 * BAR - BEAT;
    const { set } = run(s, [{ kind: 'stutter', from, to: 2 * BAR }]);
    const hats = at(set, s.kit.hat).filter((n) => n.tick >= from);
    expect(hats.map((n) => n.tick - from)).toEqual([0, 240, 480, 720]);
    expect(hats[3]!.velocity).toBeGreaterThan(hats[0]!.velocity);
  });
});

describe('thinner and busier drums, parts left out', () => {
  it('thin 1 keeps the kick, the backbeat and 8th hats; thin 2 keeps hits on the beat', () => {
    const s = setup();
    const one = run(s, [{ kind: 'thin', from: 0, to: 2 * BAR, level: 1 }]).set;
    expect(at(one, s.kit.hat).every((n) => n.tick % 480 === 0)).toBe(true);
    expect(at(one, s.kit.kick)).toHaveLength(6);
    const two = run(s, [{ kind: 'thin', from: 0, to: 2 * BAR, level: 2 }]).set;
    expect(at(two, s.kit.hat).every((n) => n.tick % 960 === 0)).toBe(true);
    expect(at(two, s.kit.kick).map((n) => n.tick)).toEqual([0, BAR]);
  });

  it('double hats adds a softer hat between 8th hats', () => {
    const { project, kit, patterns } = kitProject((k) => ({
      Eighths: { notes: { [k.hat]: notes(Array.from({ length: 8 }, (_, i) => [i * 2, 60, 1, 0.8] as [number, number, number, number])) } as never, bars: 1 },
    }));
    const env = variantEnv(project, { style: 'trap', hint: HINT });
    const { set } = applySteps(project.patterns[patterns.Eighths!]!.notes, [{ kind: 'double-hats', from: 0, to: BAR }], env, {
      seed: 1,
      length: BAR,
    });
    const hats = at(set, kit.hat);
    expect(hats.map((n) => n.tick / 240)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(hats[1]!.velocity).toBeLessThan(0.6);
  });

  it('without leaves parts out by name or channel', () => {
    const s = setup();
    const { set, effective } = run(s, [{ kind: 'without', from: 0, to: 2 * BAR, parts: ['808', 'Hi-hats'] }]);
    expect(effective).toHaveLength(1);
    expect(set.get(s.kit.s808)).toBeUndefined();
    expect(set.get(s.kit.hat)).toBeUndefined();
    expect(set.get(s.kit.kick)?.length).toBe(6);
    const byId = run(s, [{ kind: 'without', from: 0, to: 2 * BAR, parts: [s.kit.pad] }]).set;
    expect(byId.get(s.kit.pad)).toBeUndefined();
  });
});

describe('generators on a drum kit channel (General MIDI keys)', () => {
  it('fills play the kit’s own snare and toms', () => {
    const { project, kit, patterns } = kitProject((k) => ({
      Pads: {
        notes: {
          [k.kit]: notes([
            ...Array.from({ length: 8 }, (_, i) => [i * 2, 42, 1, 0.7] as [number, number, number, number]),
            [0, 36, 1, 1],
            [8, 38, 1, 1],
          ]),
        } as never,
        bars: 1,
      },
    }));
    // Without tom channels in the project the kit's toms play.
    const env = { ...variantEnv(project, { style: 'trap', hint: HINT }) };
    const roles = new Map(env.roles);
    for (const t of kit.toms) roles.delete(t);
    const noToms = { ...env, roles };
    const src = project.patterns[patterns.Pads!]!.notes;
    const snare = at(applySteps(src, [{ kind: 'snare-fill', from: BAR - BEAT, to: BAR }], env, { seed: 1, length: BAR }).set, kit.kit);
    expect(snare.filter((n) => n.tick >= BAR - BEAT).every((n) => n.key === KIT_KEYS.snare)).toBe(true);
    const toms = at(applySteps(src, [{ kind: 'tom-fill', from: BAR - BEAT, to: BAR }], noToms, { seed: 1, length: BAR }).set, kit.kit);
    expect(toms.filter((n) => n.tick >= BAR - BEAT).map((n) => n.key)).toEqual([48, 45, 41, 38]);
  });
});

describe('seeds and builds', () => {
  it('the same steps and seed give the same notes; another seed jitters the velocities', () => {
    const s = setup();
    const steps: VariantStep[] = [
      { kind: 'snare-fill', from: 2 * BAR - 2 * BEAT, to: 2 * BAR, energy: 4 },
      { kind: 'hat-roll', from: BAR - BEAT, to: BAR, energy: 4 },
    ];
    expect(setHash(run(s, steps, 11).set)).toBe(setHash(run(s, steps, 11).set));
    expect(setHash(run(s, steps, 11).set)).not.toBe(setHash(run(s, steps, 12).set));
  });

  it('a 4-bar snare build split over two 2-bar loops is the same build', () => {
    const s = setup();
    const total = 4 * BAR;
    const first = run(s, [{ kind: 'snare-build', from: 0, to: 2 * BAR, offset: 0, total, energy: 4 }]).set;
    const second = run(s, [{ kind: 'snare-build', from: 0, to: 2 * BAR, offset: 2 * BAR, total, energy: 4 }]).set;
    const a = at(first, s.kit.snare);
    const b = at(second, s.kit.snare);
    // Quarters, then 8ths in the first half; 16ths, then 32nds in the second.
    expect(a.slice(0, 4).map((n) => n.tick)).toEqual([0, 960, 1920, 2880]);
    expect(a.filter((n) => n.tick >= BAR).map((n) => n.tick - BAR)).toEqual([0, 480, 960, 1440, 1920, 2400, 2880, 3360]);
    expect(b.filter((n) => n.tick < BAR)).toHaveLength(16);
    expect(b.filter((n) => n.tick >= BAR)).toHaveLength(32);
    expect(b[b.length - 1]!.velocity).toBe(Math.max(...[...a, ...b].map((n) => n.velocity)));
    expect(a[0]!.velocity).toBeLessThan(0.5);
    // No other drum plays under it (trap: the kick goes too).
    expect(at(first, s.kit.kick)).toEqual([]);
    expect(at(first, s.kit.hat)).toEqual([]);
  });

  it('knows what a pattern can play', () => {
    const s = setup((k) => ({ Keys: { notes: { [k.pad]: notes([[0, 60, 16]]) } as never } }));
    expect(capabilities(toNoteSet(s.project.patterns[s.patterns.Groove!]!.notes), s.env)).toEqual({
      drums: true,
      hats: true,
      openHat: true,
      slide: true,
    });
    expect(capabilities(toNoteSet(s.project.patterns[s.patterns.Keys!]!.notes), s.env)).toEqual({
      drums: false,
      hats: false,
      openHat: false,
      slide: false,
    });
    // A fill on a pattern with no drums changes nothing.
    expect(run(s, [{ kind: 'snare-fill', from: BAR - BEAT, to: BAR }], 1, 'Keys').effective).toEqual([]);
  });
});
