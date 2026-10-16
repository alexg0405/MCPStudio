import { describe, expect, it } from 'vitest';
import { Cc14Assembler, norm14 } from './cc14';
import { MappingInterpreter } from './interpreter';
import { analyzeCcValues, LearnDetector } from './learn';
import { parseMidi, type MidiMessage } from './message';
import { decodeRelative, type RelEncoding } from './relative';
import { SoftTakeover } from './soft-takeover';
import { allTargets, parseTarget, targetInfo } from './targets';
import { emptyMapping, mappingFromJson, mappingToJson, type Binding, type ControllerMapping, type InputSpec } from './types';

const note = (channel: number, n: number, on = true): MidiMessage => parseMidi([(on ? 0x90 : 0x80) | channel, n, on ? 100 : 0])!;
const cc = (channel: number, c: number, value: number): MidiMessage => parseMidi([0xb0 | channel, c, value])!;

describe('parseMidi', () => {
  it('reads notes, CCs and pitch bend; velocity-0 note-on is a note-off', () => {
    expect(parseMidi([0x91, 36, 100])).toEqual({ kind: 'noteOn', channel: 1, note: 36, velocity: 100 });
    expect(parseMidi([0x91, 36, 0])).toEqual({ kind: 'noteOff', channel: 1, note: 36, velocity: 0 });
    expect(parseMidi([0x82, 40, 64])).toEqual({ kind: 'noteOff', channel: 2, note: 40, velocity: 64 });
    expect(parseMidi([0xb3, 7, 99])).toEqual({ kind: 'cc', channel: 3, cc: 7, value: 99 });
    expect(parseMidi([0xe0, 0x00, 0x40])).toEqual({ kind: 'bend', channel: 0, value: 8192 });
  });
  it('ignores clock, sysex and program changes', () => {
    expect(parseMidi([0xf8])).toBeNull();
    expect(parseMidi([0xf0, 1, 2, 0xf7])).toBeNull();
    expect(parseMidi([0xc0, 5])).toBeNull();
    expect(parseMidi([])).toBeNull();
  });
});

describe('relative encodings', () => {
  const cases: [RelEncoding, number, number][] = [
    ['twos', 1, 1],
    ['twos', 5, 5],
    ['twos', 127, -1],
    ['twos', 123, -5],
    ['twos', 64, -64],
    ['signmag', 1, 1],
    ['signmag', 5, 5],
    ['signmag', 65, -1],
    ['signmag', 69, -5],
    ['offset64', 65, 1],
    ['offset64', 69, 5],
    ['offset64', 63, -1],
    ['offset64', 59, -5],
    ['offset64', 64, 0],
  ];
  it.each(cases)('%s: %i → %i', (enc, v, steps) => {
    expect(decodeRelative(v, enc)).toBe(steps);
  });
});

describe('14-bit pairs', () => {
  it('combines the coarse and fine bytes, emitting when the fine byte lands', () => {
    const a = new Cc14Assembler();
    expect(a.feed(0, 0, true, 5)).toBeNull(); // fine first, no coarse yet
    expect(a.feed(0, 0, false, 64)).toBeNull(); // this pair sends a fine byte: wait for the next one
    expect(a.feed(0, 0, true, 7)).toBe((64 << 7) | 7);
    expect(a.feed(0, 0, false, 65)).toBeNull();
    expect(a.feed(0, 0, true, 0)).toBe(65 << 7);
    expect(norm14(16383)).toBe(1);
    expect(norm14(0)).toBe(0);
  });
  it('keeps channels and pairs apart', () => {
    const a = new Cc14Assembler();
    a.feed(0, 0, false, 10);
    expect(a.feed(1, 0, false, 20)).toBe(20 << 7);
    expect(a.feed(0, 0, true, 3)).toBe((10 << 7) | 3);
  });
  it('works without a fine byte (a 7-bit controller)', () => {
    const a = new Cc14Assembler();
    expect(a.feed(0, 1, false, 100)).toBe(100 << 7);
    expect(a.feed(0, 1, false, 101)).toBe(101 << 7);
  });
});

describe('soft takeover', () => {
  it('ignores the hardware until it meets the software value, then follows it', () => {
    const t = new SoftTakeover();
    expect(t.feed(0.1, 0.8)).toBeNull();
    expect(t.feed(0.4, 0.8)).toBeNull();
    expect(t.feed(0.79, 0.8)).toBe(0.79); // within tolerance
    expect(t.feed(0.5, 0.79)).toBe(0.5);
    expect(t.pickedUp).toBe(true);
  });
  it('picks up when the hardware crosses the value between two messages', () => {
    const t = new SoftTakeover();
    expect(t.feed(0.2, 0.5)).toBeNull();
    expect(t.feed(0.9, 0.5)).toBe(0.9); // jumped over 0.5
  });
  it('lets go again when the software value changed behind its back', () => {
    const t = new SoftTakeover();
    expect(t.feed(0.5, 0.5)).toBe(0.5);
    expect(t.feed(0.6, 0.6)).toBe(0.6);
    // The mouse moved the software to 0.1: the fader at 0.6 has to come back to it.
    expect(t.feed(0.62, 0.1)).toBeNull();
    expect(t.feed(0.3, 0.1)).toBeNull();
    expect(t.feed(0.08, 0.1)).toBe(0.08);
  });
  it('invalidate() forgets the pickup', () => {
    const t = new SoftTakeover();
    t.feed(0.5, 0.5);
    t.invalidate();
    expect(t.feed(0.9, 0.5)).toBeNull();
  });
});

function mapping(bindings: Binding[], shifts: ControllerMapping['shifts'] = []): ControllerMapping {
  return { ...emptyMapping('Test'), bindings, shifts };
}
const ccIn = (channel: number, c: number): InputSpec => ({ type: 'cc', channel, cc: c });
const noteIn = (channel: number, n: number): InputSpec => ({ type: 'note', channel, note: n });

describe('MappingInterpreter', () => {
  it('turns notes into button down/up on the right deck by channel', () => {
    const i = new MappingInterpreter(
      mapping([
        { input: noteIn(0, 11), target: 'A.play' },
        { input: noteIn(1, 11), target: 'B.play' },
      ]),
    );
    expect(i.process(note(0, 11))).toEqual([{ target: 'A.play', kind: 'button', down: true, velocity: 100 / 127 }]);
    expect(i.process(note(0, 11, false))).toEqual([{ target: 'A.play', kind: 'button', down: false, velocity: 0 }]);
    expect(i.process(note(1, 11))[0]?.target).toBe('B.play');
    expect(i.process(note(2, 11))).toEqual([]);
  });

  it('scales faders and knobs to 0–1, with invert', () => {
    const i = new MappingInterpreter(
      mapping([
        { input: ccIn(0, 7), target: 'A.volume' },
        { input: ccIn(0, 8), target: 'A.filter', invert: true },
      ]),
    );
    expect(i.process(cc(0, 7, 127))).toEqual([{ target: 'A.volume', kind: 'abs', value: 1 }]);
    expect(i.process(cc(0, 8, 127))).toEqual([{ target: 'A.filter', kind: 'abs', value: 0 }]);
  });

  it('reads a 14-bit pitch fader once per move (on the fine byte)', () => {
    const i = new MappingInterpreter(mapping([{ input: { type: 'cc14', channel: 0, cc: 0 }, target: 'A.pitch' }]));
    expect(i.process(cc(0, 0, 127))).toEqual([{ target: 'A.pitch', kind: 'abs', value: (127 << 7) / 16383 }]); // no fine byte seen yet
    const out = i.process(cc(0, 32, 127));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'abs', value: 1 });
    expect(i.process(cc(0, 0, 64))).toEqual([]);
    const half = i.process(cc(0, 32, 0))[0];
    expect(half).toMatchObject({ target: 'A.pitch', kind: 'abs' });
    expect((half as { value: number }).value).toBeCloseTo(8192 / 16383, 6);
  });

  it('reads pitch bend as a 14-bit fader', () => {
    const i = new MappingInterpreter(mapping([{ input: { type: 'bend', channel: 2 }, target: 'B.pitch' }]));
    const out = i.process(parseMidi([0xe2, 0x7f, 0x7f])!);
    expect(out[0]).toMatchObject({ target: 'B.pitch', kind: 'abs', value: 1 });
  });

  it.each<[RelEncoding, number, number]>([
    ['twos', 3, 3],
    ['twos', 125, -3],
    ['signmag', 3, 3],
    ['signmag', 67, -3],
    ['offset64', 67, 3],
    ['offset64', 61, -3],
  ])('relative %s: value %i gives %i steps (and scales)', (encoding, v, steps) => {
    const i = new MappingInterpreter(mapping([{ input: { type: 'rel', channel: 0, cc: 33, encoding }, target: 'A.jog', scale: 2 }]));
    expect(i.process(cc(0, 33, v))).toEqual([{ target: 'A.jog', kind: 'rel', delta: steps * 2 }]);
  });

  it('does not emit anything for a relative value of zero steps', () => {
    const i = new MappingInterpreter(mapping([{ input: { type: 'rel', channel: 0, cc: 33, encoding: 'offset64' }, target: 'browse' }]));
    expect(i.process(cc(0, 33, 64))).toEqual([]);
  });

  it('treats a CC as a button with press/release edges', () => {
    const i = new MappingInterpreter(mapping([{ input: ccIn(0, 20), target: 'A.cue' }]));
    expect(i.process(cc(0, 20, 127))).toHaveLength(1);
    expect(i.process(cc(0, 20, 127))).toHaveLength(0);
    expect(i.process(cc(0, 20, 0))).toEqual([{ target: 'A.cue', kind: 'button', down: false, velocity: 0 }]);
  });

  it('jog touch is a plain button on the touch sensor note', () => {
    const i = new MappingInterpreter(mapping([{ input: noteIn(0, 54), target: 'A.jogTouch' }]));
    expect(i.process(note(0, 54))[0]).toMatchObject({ target: 'A.jogTouch', down: true });
    expect(i.process(note(0, 54, false))[0]).toMatchObject({ target: 'A.jogTouch', down: false });
  });

  it('ignores controls bound to a target of another kind', () => {
    const i = new MappingInterpreter(
      mapping([
        { input: noteIn(0, 1), target: 'A.volume' },
        { input: ccIn(0, 2), target: 'A.jog' },
      ]),
    );
    expect(i.process(note(0, 1))).toEqual([]);
    expect(i.process(cc(0, 2, 5))).toEqual([]);
  });

  describe('shift layers', () => {
    const m = mapping(
      [
        { input: noteIn(0, 11), target: 'A.play' },
        { input: noteIn(0, 11), target: 'A.sync', layer: 'shift' },
        { input: noteIn(0, 12), target: 'A.cue' },
        { input: noteIn(0, 13), target: 'A.hotcue:1', layer: 'shift' },
      ],
      [{ id: 'shift', input: noteIn(0, 63) }],
    );
    it('changes what a button does while the shift key is held', () => {
      const i = new MappingInterpreter(m);
      expect(i.process(note(0, 11))[0]?.target).toBe('A.play');
      i.process(note(0, 11, false));
      i.process(note(0, 63));
      expect(i.layers.has('shift')).toBe(true);
      expect(i.process(note(0, 11))[0]?.target).toBe('A.sync');
      i.process(note(0, 11, false));
      i.process(note(0, 63, false));
      expect(i.layers.has('shift')).toBe(false);
      expect(i.process(note(0, 11))[0]?.target).toBe('A.play');
    });
    it('keeps a normal binding when the shifted layer does not override it, and has none for shift-only ones', () => {
      const i = new MappingInterpreter(m);
      i.process(note(0, 63));
      expect(i.process(note(0, 12))[0]?.target).toBe('A.cue');
      expect(i.process(note(0, 13))[0]?.target).toBe('A.hotcue:1');
      i.process(note(0, 63, false));
      expect(i.process(note(0, 13))).toEqual([]);
    });
    it('releases a button on the binding it was pressed with, even if shift changed meanwhile', () => {
      const i = new MappingInterpreter(m);
      i.process(note(0, 63));
      i.process(note(0, 11)); // shift + 11 = sync
      i.process(note(0, 63, false));
      expect(i.process(note(0, 11, false))).toEqual([{ target: 'A.sync', kind: 'button', down: false, velocity: 0 }]);
    });
    it('a shift key can be a CC button', () => {
      const i = new MappingInterpreter(mapping([{ input: noteIn(0, 11), target: 'A.sync', layer: 's' }], [{ id: 's', input: ccIn(0, 5) }]));
      i.process(cc(0, 5, 127));
      expect(i.process(note(0, 11))[0]?.target).toBe('A.sync');
    });
  });
});

describe('learn: type detection from the messages', () => {
  const feedAll = (d: LearnDetector, msgs: MidiMessage[]) => {
    let last = d.feed(msgs[0]!);
    for (const m of msgs.slice(1)) {
      if (last.status === 'done') break;
      last = d.feed(m);
    }
    return last;
  };
  const run = (values: number[], expectKind: 'button' | 'abs' | 'rel' | 'any', channel = 0, c = 33) =>
    feedAll(new LearnDetector(expectKind), values.map((v) => cc(channel, c, v)));

  it('a note press is a button', () => {
    expect(new LearnDetector('button').feed(note(3, 36))).toEqual({ status: 'done', input: { type: 'note', channel: 3, note: 36 }, certain: true });
  });
  it('ignores a note release while waiting', () => {
    expect(new LearnDetector('button').feed(note(3, 36, false))).toEqual({ status: 'waiting' });
  });
  it('a button that sends CC 127 is learned as a CC button', () => {
    const d = new LearnDetector('button');
    expect(d.feed(cc(0, 20, 0))).toEqual({ status: 'waiting' });
    expect(d.feed(cc(0, 20, 127))).toMatchObject({ status: 'done', input: { type: 'cc', channel: 0, cc: 20 } });
  });
  it('pitch bend is a bend fader', () => {
    expect(new LearnDetector('abs').feed(parseMidi([0xe1, 0, 64])!)).toMatchObject({ status: 'done', input: { type: 'bend', channel: 1 } });
  });
  it('a CC and the CC 32 higher are a 14-bit pair', () => {
    const r = feedAll(new LearnDetector('abs'), [cc(0, 0, 60), cc(0, 32, 12), cc(0, 0, 61), cc(0, 32, 90)]);
    expect(r).toEqual({ status: 'done', input: { type: 'cc14', channel: 0, cc: 0 }, certain: true });
  });
  it('detects a pair that sends the fine byte first', () => {
    const r = feedAll(new LearnDetector('abs'), [cc(2, 36, 12), cc(2, 4, 60), cc(2, 36, 15)]);
    expect(r).toMatchObject({ status: 'done', input: { type: 'cc14', channel: 2, cc: 4 } });
  });
  it('a fader sweeping up is an absolute control', () => {
    const r = run([0, 4, 9, 20, 35, 52, 70, 88, 100, 127], 'abs', 1, 7);
    expect(r).toEqual({ status: 'done', input: { type: 'cc', channel: 1, cc: 7 }, certain: true });
  });
  it('a fader sweeping when the target kind is unknown is still absolute', () => {
    const r = run([10, 16, 24, 37, 51, 66, 80, 95], 'any', 0, 7);
    expect(r).toMatchObject({ status: 'done', input: { type: 'cc' } });
  });
  it('a slow fader nudge in the low range with no hint is absolute (distinct, steady values)', () => {
    expect(analyzeCcValues([5, 6, 7, 8, 9, 10], 'any')).toEqual({ type: 'abs' });
  });

  it.each<[RelEncoding, number[]]>([
    ['twos', [1, 1, 2, 1, 127, 126, 127, 127]],
    ['signmag', [1, 1, 2, 1, 65, 66, 65, 65]],
    ['offset64', [65, 65, 66, 65, 63, 62, 63, 63]],
  ])('a jog turned both ways sending %s values is detected', (encoding, values) => {
    const r = run(values, 'rel');
    expect(r).toEqual({ status: 'done', input: { type: 'rel', channel: 0, cc: 33, encoding }, certain: true });
  });
  it('detects the encoding without knowing the target kind', () => {
    expect(analyzeCcValues([1, 2, 1, 3, 126, 127, 125, 127])).toMatchObject({ type: 'rel', encoding: 'twos', certain: true });
    expect(analyzeCcValues([2, 1, 3, 66, 65, 67, 1, 65])).toMatchObject({ type: 'rel', encoding: 'signmag', certain: true });
    expect(analyzeCcValues([66, 64 + 2, 63, 62, 65, 61, 63, 67])).toMatchObject({ type: 'rel', encoding: 'offset64', certain: true });
  });
  it('one direction only: asks for the other way, then guesses', () => {
    const d = new LearnDetector('rel');
    let r = d.feed(cc(0, 33, 1));
    for (const v of [1, 1, 2, 1, 1]) r = d.feed(cc(0, 33, v));
    expect(r.status).toBe('progress');
    expect(d.guess()).toEqual({ type: 'rel', channel: 0, cc: 33, encoding: 'twos' });
    for (let i = 0; i < 12; i++) r = d.feed(cc(0, 33, 1));
    expect(r).toMatchObject({ status: 'done', certain: false });
  });
  it('a jog sending 63/65 only around the middle is centred on 64', () => {
    expect(analyzeCcValues([65, 65, 66, 65, 65, 65], 'rel')).toMatchObject({ type: 'rel', encoding: 'offset64' });
  });
  it('follows only the control that was touched first', () => {
    const d = new LearnDetector('abs');
    d.feed(cc(0, 7, 10));
    expect(d.feed(cc(0, 8, 99))).toEqual({ status: 'waiting' });
    d.feed(cc(0, 7, 30));
    expect(d.feed(cc(0, 7, 50))).toMatchObject({ status: 'done', input: { type: 'cc', cc: 7 } });
  });
  it('ignores the sustain pedal and channel-mode messages', () => {
    expect(new LearnDetector('abs').feed(cc(0, 64, 127))).toEqual({ status: 'waiting' });
    expect(new LearnDetector('abs').feed(cc(0, 123, 0))).toEqual({ status: 'waiting' });
  });
});

describe('targets and mapping files', () => {
  it('has a unique id per target and parses them', () => {
    const ids = allTargets().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(parseTarget('B.hotcue:3')).toEqual({ deck: 'B', fn: 'hotcue', arg: 3 });
    expect(parseTarget('A.eq.low')).toEqual({ deck: 'A', fn: 'eq.low' });
    expect(parseTarget('crossfader')).toEqual({ fn: 'crossfader' });
    expect(parseTarget('nope')).toBeNull();
    expect(targetInfo('A.jog')?.kind).toBe('rel');
    expect(targetInfo('A.play')?.led).toBe(true);
  });
  it('round-trips through JSON and drops what it does not understand', () => {
    const m: ControllerMapping = {
      ...emptyMapping('My pad'),
      shifts: [{ id: 'shift', input: noteIn(0, 63) }],
      bindings: [
        { input: noteIn(0, 11), target: 'A.play' },
        { input: { type: 'rel', channel: 0, cc: 33, encoding: 'twos' }, target: 'A.jog', scale: 2 },
        { input: ccIn(0, 7), target: 'A.volume', layer: 'shift', invert: true },
      ],
      leds: [{ state: 'A.play', out: { type: 'note', channel: 0, number: 11, on: 127, off: 0 } }],
    };
    expect(mappingFromJson(mappingToJson(m))).toEqual({ mapping: m, dropped: 0 });
    const text = JSON.stringify({
      name: 'x',
      bindings: [
        { input: { type: 'note', channel: 0, note: 1 }, target: 'A.play' },
        { input: { type: 'note', channel: 99, note: 1 }, target: 'A.play' },
        { input: { type: 'note', channel: 0, note: 1 }, target: 'A.warp' },
        { input: { type: 'cc', channel: 0, cc: 1 }, target: 'A.cue', layer: 'missing' },
      ],
    });
    const r = mappingFromJson(text)!;
    expect(r.mapping.bindings).toHaveLength(1);
    expect(r.dropped).toBe(3);
    expect(mappingFromJson('not json')).toBeNull();
    expect(mappingFromJson('{"bindings": 3}')).toBeNull();
  });
});
