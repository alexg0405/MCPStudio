import { describe, expect, it } from 'vitest';
import { defaultValues, type AnyNoteScriptDef, type NoteScriptContext, type ScriptNote } from '@agstudio/sdk';
import { inScale, noteEnd, seeded } from '@agstudio/sdk/notes';
import tools from './index';

const PPQ = 960;

/** A context like the piano roll builds (no host needed). */
function ctx(
  def: AnyNoteScriptDef,
  notes: ScriptNote[],
  values: Record<string, unknown> = {},
  key: { root: number; scale: string } | null = null,
): NoteScriptContext {
  return {
    notes: Object.freeze(notes.map((n) => Object.freeze({ ...n }))),
    values: Object.freeze({ ...defaultValues(def.params), ...values }) as NoteScriptContext['values'],
    ppq: PPQ,
    grid: 240,
    bpm: 120,
    bar: 3840,
    length: 3840 * 2,
    key,
    rand: seeded(7),
  };
}

const tool = (id: string) => {
  const def = (tools as AnyNoteScriptDef[]).find((t) => t.id === `agstudio.notes.${id}`);
  if (!def) throw new Error(`no tool ${id}`);
  return def;
};
const run = (
  id: string,
  notes: ScriptNote[],
  values?: Record<string, unknown>,
  key?: { root: number; scale: string },
) => tool(id).run(ctx(tool(id), notes, values, key ?? null));

const n = (id: string, tick: number, key = 60, length = 240, velocity = 0.8): ScriptNote => ({
  id,
  tick,
  length,
  key,
  velocity,
});
const melody = [n('a', 10, 60, 200), n('b', 250, 64, 300), n('c', 700, 67, 90, 0.4), n('d', 1500, 62, 500, 1)];
const chord = [n('r', 0, 60, 1920), n('t', 0, 64, 1920), n('f', 0, 67, 1920)];

describe('built-in note tools', () => {
  it('are valid note scripts with unique ids and categories', () => {
    const ids = new Set<string>();
    for (const def of tools as AnyNoteScriptDef[]) {
      expect(def.kind).toBe('note-script');
      expect(def.id).toMatch(/^agstudio\.notes\./);
      expect(ids.has(def.id)).toBe(false);
      ids.add(def.id);
      expect(def.category).toBeTruthy();
      expect(def.description).toBeTruthy();
    }
    expect(ids.size).toBeGreaterThanOrEqual(15);
  });

  it.each((tools as AnyNoteScriptDef[]).map((t) => [t.name, t] as const))(
    '%s runs on sample notes with its defaults and returns valid notes',
    (_name, def) => {
      for (const input of [melody, chord, []]) {
        const out = def.run(ctx(def, input, {}, { root: 9, scale: 'minor' }));
        for (const x of out) {
          expect(Number.isInteger(x.tick) && x.tick >= 0).toBe(true);
          expect(Number.isInteger(x.length) && x.length >= 1).toBe(true);
          expect(x.key >= 0 && x.key <= 127).toBe(true);
          expect(x.velocity >= 0 && x.velocity <= 1).toBe(true);
        }
      }
    },
  );

  it('quantize, legato, chop and glue', () => {
    expect(run('quantize', melody).map((x) => x.tick)).toEqual([0, 240, 720, 1440]);
    expect(run('quantize', melody, { strength: 0.5 }).map((x) => x.tick)).toEqual([5, 245, 710, 1470]);
    expect(run('legato', melody).map((x) => x.length)).toEqual([240, 450, 800, 500]);
    expect(run('legato', melody, { last: 'pattern' })[3]?.length).toBe(7680 - 1500);
    expect(run('chop', [n('x', 0, 60, 960)], { grid: '1/8' }).map((x) => `${x.tick}/${x.length}`)).toEqual([
      '0/480',
      '480/480',
    ]);
    expect(run('chop', [n('x', 0, 60, 960)], { mode: 'parts', parts: 3 })).toHaveLength(3);
    expect(run('glue', [n('x', 0, 60, 240), n('y', 240, 60, 240), n('z', 600, 60, 10)], { gap: '1/32' })).toHaveLength(1);
  });

  it('strum, arpeggiate and flip', () => {
    expect(run('strum', chord, { time: 0.25 }).map((x) => x.tick)).toEqual([0, 120, 240]);
    // 125 ms at 120 BPM is a quarter of a beat (240 ticks); it replaces the beats value, and down reverses the order.
    expect(run('strum', chord, { time: 1, ms: 125 }).map((x) => x.tick)).toEqual([0, 120, 240]);
    const down = run('strum', chord, { ms: 125, direction: 'down' });
    const byTime = [...down].sort((a, b) => a.tick - b.tick).map((x) => x.key);
    expect(byTime).toEqual([67, 64, 60]);
    const arp = run('arpeggiate', chord, { rate: '1/8', octaves: 2 });
    expect(arp).toHaveLength(4);
    expect(arp.map((x) => x.key)).toEqual([60, 64, 67, 72]);
    expect(run('flip', melody).map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(run('flip', melody, { axis: 'pitch' }).map((x) => x.key)).toEqual([67, 63, 60, 65]);
  });

  it('pitch tools follow the song key', () => {
    const am = { root: 9, scale: 'minor' };
    expect(run('transpose', melody, { steps: 1 }, am).map((x) => x.key)).toEqual([62, 65, 69, 64]);
    expect(run('transpose', melody, { semitones: -12 }).map((x) => x.key)).toEqual([48, 52, 55, 50]);
    const snapped = run('snap-to-scale', [n('x', 0, 61), n('y', 0, 66)], {}, am);
    expect(snapped.every((x) => inScale(x.key, 9, 'minor'))).toBe(true);
    expect(run('snap-to-scale', [n('x', 0, 61)], { root: 'D', scale: 'major' })[0]?.key).toBe(61);
    // D in A minor: D F A.
    expect(run('chords', [n('x', 0, 62)], {}, am).map((x) => x.key)).toEqual([62, 65, 69]);
    expect(run('chords', [n('x', 0, 62)], { chord: 'maj7' }).map((x) => x.key)).toEqual([62, 66, 69, 73]);
  });

  it('velocity tools', () => {
    expect(run('velocity-scale', melody, { factor: 0.5 }).map((x) => x.velocity)).toEqual([0.4, 0.4, 0.2, 0.5]);
    const fitted = run('velocity-range', melody, { min: 0.2, max: 0.6 }).map((x) => Math.round(x.velocity * 100));
    expect(fitted).toEqual([47, 47, 20, 60]);
    const ramp = run('velocity-ramp', melody, { from: 0, to: 1 }).map((x) => x.velocity);
    expect(ramp[0]).toBe(0);
    expect(ramp[3]).toBe(1);
  });

  it('generators write seeded notes in key', () => {
    const am = { root: 9, scale: 'minor' };
    const once = run('generate', [], { density: 1 }, am);
    expect(once.length).toBeGreaterThan(0);
    expect(once.every((x) => inScale(x.key, 9, 'minor') && noteEnd(x) <= 7680)).toBe(true);
    expect(run('generate', [], { density: 1 }, am)).toEqual(once);
    const kept = run('generate', melody, { replace: false, density: 0.3 }, am);
    expect(kept.filter((x) => x.id).map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);

    const chords = run('progression', [], {}, { root: 0, scale: 'major' });
    // I V vi IV in C: C E G, G B D, A C E, F A C.
    expect(chords).toHaveLength(12);
    expect(chords.filter((x) => x.tick === 3840).map((x) => x.key)).toEqual([67, 71, 74]);
    expect(chords.filter((x) => x.tick === 3 * 3840).map((x) => x.key)).toEqual([65, 69, 72]);
    // Without a key, a minor progression is written in C minor: i = C Eb G.
    const minor = run('progression', [], { progression: 'i-VI-III-VII' });
    expect(minor.filter((x) => x.tick === 0).map((x) => x.key)).toEqual([60, 63, 67]);

    const random = run('randomize', melody, { pitch: 7 }, am);
    expect(random.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
    random.forEach((x, i) => {
      if (x.key !== melody[i]!.key) expect(inScale(x.key, 9, 'minor')).toBe(true);
    });
  });
});
