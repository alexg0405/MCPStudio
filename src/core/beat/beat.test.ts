import { describe, expect, it } from 'vitest';
import { generateLocalBeat, parsePrompt, type PerformedEvent } from './local';
import { DRUM_SOUNDS, validateBeatSpec, type BeatNote, type BeatSpec } from './spec';
import { GROOVE, TEMPO } from './style';

const ok = (raw: unknown) => {
  const r = validateBeatSpec(raw);
  if ('error' in r) throw new Error(r.error);
  return r;
};

describe('validateBeatSpec', () => {
  it('keeps a clean beat as is', () => {
    const raw = {
      title: 'Test',
      bars: 1,
      bpm: 140,
      tracks: [
        { name: 'Kick', sound: 'kick', notes: [{ step: 0 }, { step: 7, vel: 0.5 }] },
        { name: '808', sound: '808', notes: [{ step: 0, len: 8, key: 29 }], params: { glide: 0.1 } },
      ],
    };
    const { spec, warnings } = ok(raw);
    expect(warnings).toEqual([]);
    expect(spec.tracks[0]?.notes).toEqual([
      { step: 0, len: 1, vel: 0.8 },
      { step: 7, len: 1, vel: 0.5 },
    ]);
    expect(spec.tracks[1]).toMatchObject({
      sound: '808',
      notes: [{ step: 0, len: 8, key: 29 }],
      params: { glide: 0.1 },
    });
  });

  it('clamps, snaps and drops what does not fit', () => {
    const { spec, warnings } = ok({
      title: '  ',
      bars: 9,
      bpm: 999,
      swing: 4,
      tracks: [
        {
          name: 'Hat',
          sound: 'hat',
          notes: [{ step: 0.49 }, { step: 0.5 }, { step: -1 }, { step: 70 }, { step: 'x' }, { step: 3, len: 99 }],
        },
        { name: 'Weird', sound: 'kazoo', notes: [{ step: 0 }] },
        { name: 'Lead', sound: 'lead', notes: [{ step: 1 }, { step: 2, key: 200.4 }] },
        'junk',
      ],
    });
    expect(spec).toMatchObject({ title: 'Assistant beat', bars: 4, bpm: 220, swing: 1 });
    expect(spec.tracks.map((t) => t.name)).toEqual(['Hat', 'Lead']);
    // 0.49 snaps to 0.5 and merges with the explicit 0.5; off-grid and junk notes are dropped.
    expect(spec.tracks[0]?.notes.map((n) => n.step)).toEqual([0.5, 3]);
    expect(spec.tracks[0]?.notes[1]?.len).toBe(61);
    // Pitched sounds need a key; it is clamped to MIDI range.
    expect(spec.tracks[1]?.notes).toEqual([{ step: 2, len: 1, vel: 0.8, key: 127 }]);
    expect(warnings.some((w) => w.includes('kazoo'))).toBe(true);
  });

  it('rejects beats with nothing usable', () => {
    expect(validateBeatSpec(null)).toHaveProperty('error');
    expect(validateBeatSpec({ title: 'x', bars: 1, tracks: [{ name: 'a', sound: 'nope', notes: [] }] })).toHaveProperty(
      'error',
    );
  });

  it('makes duplicate track names unique', () => {
    const { spec } = ok({
      title: 't',
      bars: 1,
      tracks: [
        { name: 'Hat', sound: 'hat', notes: [] },
        { name: 'hat', sound: 'open-hat', notes: [] },
      ],
    });
    expect(spec.tracks.map((t) => t.name)).toEqual(['Hat', 'hat 2']);
  });
});

describe('parsePrompt', () => {
  it('reads style, tempo, key and density', () => {
    expect(parsePrompt('dark trap beat with 808s at 145 bpm in F# minor, busy hats')).toMatchObject({
      style: 'trap',
      bpm: 145,
      key: { root: 6, minor: true },
      density: 1,
      wants808: true,
    });
    expect(parsePrompt('simple boom bap in C major')).toMatchObject({
      style: 'boombap',
      key: { root: 0, minor: false },
      density: -1,
    });
    expect(parsePrompt('a chill lofi thing').style).toBe('lofi');
    expect(parsePrompt('make a beat').style).toBeUndefined();
    expect(parsePrompt('a beat').key).toBeUndefined();
  });
});

const tracksOf = (spec: BeatSpec) => Object.fromEntries(spec.tracks.map((t) => [t.sound, t]));

describe('generateLocalBeat', () => {
  it('writes a trap beat with an 808 that follows the kick', () => {
    const spec = generateLocalBeat({ prompt: 'trap beat with 808s in F minor', bpm: 130 });
    expect(spec.bpm).toBe(140);
    const t = tracksOf(spec);
    expect(t.kick && t.clap && t.hat && t['808']).toBeTruthy();
    const kicks = t.kick!.notes.map((n) => n.step);
    for (const n of t['808']!.notes.filter((n) => n.key === 29)) expect(kicks).toContain(n.step);
    // Hat rolls use 1/32 steps.
    expect(t.hat!.notes.some((n) => n.step % 1 !== 0)).toBe(true);
    expect(validateBeatSpec(spec)).not.toHaveProperty('error');
  });

  it('keeps the project tempo when the prompt names no style or tempo', () => {
    expect(generateLocalBeat({ prompt: 'something with 808s', bpm: 133 }).bpm).toBeUndefined();
  });

  /** Pairs of 808 notes where the second starts while the first still plays (a slide). */
  const slides = (notes: readonly BeatNote[]) => {
    const sorted = [...notes].sort((a, b) => a.step - b.step);
    return sorted.slice(1).flatMap((b, i) => {
      const a = sorted[i]!;
      return b.step > a.step && a.step + a.len! > b.step ? [{ a, b }] : [];
    });
  };

  it.each(['trap', 'drill'])('%s: the 808 slides after the pickup kick (half a step of overlap, a new pitch)', (style) => {
    const spec = generateLocalBeat({ prompt: `${style} beat in F minor`, bpm: 140 });
    const t = tracksOf(spec);
    const found = slides(t['808']!.notes);
    expect(found.length).toBeGreaterThanOrEqual(style === 'drill' ? 2 : 1);
    for (const { a, b } of found) {
      expect(b.key).not.toBe(a.key);
      expect(a.step + a.len! - b.step).toBeCloseTo(0.5, 9);
      expect(b.key!).toBeLessThanOrEqual(48);
    }
    // The last slide comes after the loop's pickup kick, into the restart.
    const pickup = (spec.bars - 1) * 16 + 14;
    expect(t.kick!.notes.map((n) => n.step)).toContain(pickup);
    expect(found.at(-1)!.a.step).toBe(pickup);
    expect(found.at(-1)!.b.step).toBeGreaterThan(pickup);
    expect(validateBeatSpec(spec)).not.toHaveProperty('error');
  });

  it('boom bap: swung odd-1/16 hats, ghost snares and a sub bass under the kick', () => {
    const spec = generateLocalBeat({ prompt: 'boom bap beat', bpm: 90 });
    const t = tracksOf(spec);
    expect(spec).toMatchObject({ style: 'boombap', swing: 0.35 });
    expect(t.hat!.notes.some((n) => n.step % 2 === 1)).toBe(true);
    const snares = t.snare!.notes;
    expect(snares.some((n) => n.vel! < 0.5)).toBe(true);
    expect(snares.filter((n) => n.step % 16 === 4 || n.step % 16 === 12).every((n) => n.vel! > 0.9)).toBe(true);
    const kicks = t.kick!.notes.map((n) => n.step);
    expect(t.bass!.notes.length).toBe(kicks.length);
    for (const n of t.bass!.notes) {
      expect(kicks).toContain(n.step);
      expect(n.key!).toBeLessThanOrEqual(47);
    }
  });

  it('lo-fi: four bars of 7th chords on keys (3+ notes at once), swung and soft', () => {
    const spec = generateLocalBeat({ prompt: 'lofi chill with keys', bpm: 80 });
    expect(spec).toMatchObject({ style: 'lofi', bars: 4, swing: 0.45 });
    const keys = tracksOf(spec).keys!.notes;
    const atOnce = (step: number) => keys.filter((n) => n.step <= step && step < n.step + n.len!).length;
    for (const bar of [0, 1, 2, 3]) expect(atOnce(bar * 16 + 1)).toBeGreaterThanOrEqual(3);
    // A 7th chord: four different pitch classes in the first bar (Am7: A C E G).
    const first = new Set(keys.filter((n) => n.step === 0).map((n) => n.key! % 12));
    expect([...first].sort((a, b) => a - b)).toEqual([0, 4, 7, 9]);
    expect(tracksOf(spec).bass).toBeDefined();
  });

  it('writes every style with its own groove, as a valid beat', () => {
    for (const [prompt, style] of [
      ['trap', 'trap'],
      ['drill', 'drill'],
      ['boom bap', 'boombap'],
      ['lofi', 'lofi'],
      ['house', 'house'],
      ['edm festival', 'edm'],
      ['reggaeton', 'reggaeton'],
      ['afrobeats', 'afro'],
      ['pop song', 'pop'],
    ] as const) {
      const spec = generateLocalBeat({ prompt, bpm: 120 });
      expect(spec.style, prompt).toBe(style);
      expect(spec.swing, prompt).toBe(GROOVE[style].swing);
      expect(spec.bpm ?? 120, prompt).toBe(TEMPO[style].default === 120 ? 120 : TEMPO[style].default);
      expect(spec.tracks.some((t) => !DRUM_SOUNDS.has(t.sound)), `${prompt} has a pitched part`).toBe(true);
      const checked = validateBeatSpec(spec);
      expect(checked, prompt).not.toHaveProperty('error');
      // Every hit has its velocity (accents filled in).
      for (const t of spec.tracks) for (const n of t.notes) expect(n.vel, `${prompt} ${t.name}`).toBeDefined();
    }
  });

  it('turns a beatbox performance into the drum tracks', () => {
    const events: PerformedEvent[] = [
      { step: 0, lengthSteps: 2, kind: 'kick', strength: 1, pitch: null, pitchEnd: null },
      { step: 4, lengthSteps: 1, kind: 'snare', strength: 0.8, pitch: null, pitchEnd: null },
      { step: 6, lengthSteps: 1, kind: 'kick', strength: 0.7, pitch: null, pitchEnd: null },
      { step: 12, lengthSteps: 1, kind: 'snare', strength: 0.9, pitch: null, pitchEnd: null },
    ];
    const spec = generateLocalBeat({ prompt: 'boom bap', bpm: 90, performance: { events, role: 'auto', bars: 1 } });
    const t = tracksOf(spec);
    expect(t.kick!.notes.map((n) => n.step)).toEqual([0, 6]);
    expect(t.snare!.notes.map((n) => n.step)).toEqual([4, 12]);
    // The style still supplies the hats the user didn't perform.
    expect(t.hat!.notes.length).toBeGreaterThan(0);
  });

  it('turns humming into an 808 line in the 808 register, keeping its shape', () => {
    // Hummed around A3 (57): A, A, C4, G3 → shifted down to the 808 octave.
    const hum = (step: number, len: number, pitch: number, end: number | null = null): PerformedEvent => ({
      step,
      lengthSteps: len,
      kind: 'tonal',
      strength: 0.9,
      pitch,
      pitchEnd: end,
    });
    const events = [hum(0, 3, 57), hum(4, 2, 57), hum(8, 4, 60), hum(12, 4, 55)];
    const spec = generateLocalBeat({
      prompt: '808s that go like this',
      bpm: 140,
      performance: { events, role: '808', bars: 1 },
    });
    const bass = tracksOf(spec)['808']!;
    const keys = bass.notes.map((n) => n.key as number);
    expect(keys[2]! - keys[0]!).toBe(3);
    expect(keys[3]! - keys[0]!).toBe(-2);
    expect(Math.min(...keys)).toBeGreaterThanOrEqual(24);
    expect(Math.max(...keys)).toBeLessThanOrEqual(48);
    // Connected hummed notes overlap so the 808 glides.
    const [a, b] = [bass.notes[2]!, bass.notes[3]!];
    expect(a.step + (a.len ?? 1)).toBeGreaterThan(b.step);
  });

  it('moves a hummed line into the requested key', () => {
    const events: PerformedEvent[] = [
      { step: 0, lengthSteps: 8, kind: 'tonal', strength: 1, pitch: 52, pitchEnd: null }, // E
      { step: 8, lengthSteps: 4, kind: 'tonal', strength: 1, pitch: 55, pitchEnd: null }, // G
    ];
    const spec = generateLocalBeat({
      prompt: '808 in F minor',
      bpm: 140,
      performance: { events, role: '808', bars: 1 },
    });
    const keys = tracksOf(spec)['808']!.notes.map((n) => (n.key as number) % 12);
    expect(keys[0]).toBe(5); // the held note becomes F
    expect(keys[1]).toBe(8); // a minor third above: A♭
  });
});
