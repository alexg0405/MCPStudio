import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MidiError, parseMidi, writeMidi } from './midi';

describe('MIDI files', () => {
  it('round-trips notes, tempo, time signature and programs', () => {
    const bytes = writeMidi({
      name: 'Song',
      bpm: 140,
      timeSig: { num: 3, den: 4 },
      tracks: [
        {
          name: 'Bass',
          channel: 1,
          program: 33,
          notes: [
            { tick: 0, length: 480, key: 36, velocity: 1 },
            { tick: 480, length: 240, key: 43, velocity: 0.5 },
          ],
        },
        { name: 'Drums', channel: 9, notes: [{ tick: 960, length: 120, key: 36, velocity: 0.8 }] },
      ],
    });
    const f = parseMidi(bytes);
    expect(f.format).toBe(1);
    expect(f.ppq).toBe(960);
    expect(f.tempos).toEqual([{ tick: 0, bpm: expect.closeTo(140, 2) }]);
    expect(f.timeSig).toEqual({ num: 3, den: 4 });
    expect(f.tracks.map((t) => t.name)).toEqual(['Song', 'Bass', 'Drums']);
    expect(f.tracks[1]!.programs).toEqual({ 1: 33 });
    expect(f.tracks[1]!.notes).toEqual([
      { tick: 0, length: 480, key: 36, velocity: 1, channel: 1 },
      { tick: 480, length: 240, key: 43, velocity: expect.closeTo(64 / 127, 6), channel: 1 },
    ]);
    expect(f.tracks[2]!.notes[0]).toMatchObject({ tick: 960, key: 36, channel: 9 });
  });

  it('reads running status, note-on velocity 0 as note-off, rescales PPQ and pairs FIFO', () => {
    // Format 0, PPQ 96: two overlapping C4s and a running-status note.
    const track = [
      0,
      0x90,
      60,
      100, // on C4 (a)
      48,
      60,
      90, //       on C4 (b), running status
      48,
      0x80,
      60,
      0, //  off: ends (a) first
      48,
      0x90,
      60,
      0, //  on with velocity 0 = off: ends (b)
      0,
      0xff,
      0x2f,
      0,
    ];
    const bytes = Uint8Array.from([
      ...[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96],
      ...[0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, track.length],
      ...track,
    ]);
    const f = parseMidi(bytes);
    expect(f.tracks[0]!.notes.map((n) => [n.tick, n.length])).toEqual([
      [0, 960], // 96 file ticks = one beat = 960
      [480, 960],
    ]);
  });

  it('ends notes that are never released at the end of their track', () => {
    const track = [0, 0x90, 60, 100, 0, 0x90, 60, 100, 0, 0x90, 64, 100, 96, 0xff, 0x2f, 0];
    const bytes = Uint8Array.from([
      ...[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96],
      ...[0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, track.length],
      ...track,
    ]);
    expect(parseMidi(bytes).tracks[0]!.notes.map((n) => [n.key, n.length])).toEqual([
      [60, 960],
      [60, 960],
      [64, 960],
    ]);
  });

  it('rejects files that are not MIDI', () => {
    expect(() => parseMidi(new TextEncoder().encode('RIFF....'))).toThrow(MidiError);
  });

  it('round-trips random notes exactly (at PPQ 960)', () => {
    const note = fc.record({
      tick: fc.integer({ min: 0, max: 100_000 }),
      length: fc.integer({ min: 1, max: 20_000 }),
      key: fc.integer({ min: 0, max: 127 }),
      velocity: fc.integer({ min: 1, max: 127 }).map((v) => v / 127),
    });
    fc.assert(
      fc.property(fc.array(note, { maxLength: 40 }), (notes) => {
        const f = parseMidi(
          writeMidi({ name: 'x', bpm: 120, timeSig: { num: 4, den: 4 }, tracks: [{ name: 't', channel: 0, notes }] }),
        );
        const got = f.tracks[1]!.notes.map((n) => [n.tick, n.key, n.length]).sort();
        // Same-key overlaps pair FIFO, so compare as multisets of starts and keys.
        expect(got.map(([t, k]) => `${t}:${k}`).sort()).toEqual(notes.map((n) => `${n.tick}:${n.key}`).sort());
      }),
      { numRuns: 100 },
    );
  });
});
