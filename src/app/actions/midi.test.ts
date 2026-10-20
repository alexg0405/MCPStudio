import { describe, expect, it } from 'vitest';
import { parseMidi, writeMidi } from '@core/io/midi';
import type { ChannelId } from '@core/model/types';
import { placeLyricWords } from '@core/ops/lyrics';
import { createTestServices } from '../testing';
import { exportMidi, importMidi } from './midi';

const file = writeMidi({
  name: 'Groove',
  bpm: 95,
  timeSig: { num: 4, den: 4 },
  tracks: [
    {
      name: 'Drums',
      channel: 9,
      notes: [
        { tick: 0, length: 120, key: 36, velocity: 1 },
        { tick: 960, length: 120, key: 38, velocity: 0.9 },
        { tick: 480, length: 60, key: 42, velocity: 0.6 },
        { tick: 1440, length: 60, key: 81, velocity: 0.6 }, // triangle: no kit sound
      ],
    },
    {
      name: 'Bass',
      channel: 1,
      program: 33,
      notes: [
        { tick: 0, length: 900, key: 36, velocity: 0.8 },
        { tick: 3840, length: 900, key: 43, velocity: 0.8 },
      ],
    },
  ],
});

describe('MIDI import', () => {
  it('maps GM drums onto the kit channels, picks instruments by program, one pattern per track', () => {
    const s = createTestServices();
    const before = s.doc.getState().project;
    const kick = before.channelOrder.find((id) => before.channels[id]?.name === 'Kick') as ChannelId;
    const res = importMidi(s, parseMidi(file), 'groove.mid', { split: true, tempo: true, place: true });
    const p = s.doc.getState().project;
    expect(res.skipped).toBe(1);
    expect(res.patterns).toHaveLength(2);
    expect(p.transport.bpm).toBeCloseTo(95, 2);
    // The project's Kick channel plays the kick notes (no duplicate kick channel).
    const drums = p.patterns[res.patterns[0]!]!;
    expect(Object.keys(drums.notes[kick] ?? {})).toHaveLength(1);
    const bass = res.channels.map((id) => p.channels[id]!).find((c) => c.name === 'Bass')!;
    expect(bass.kind === 'instrument' && bass.plugin.pluginId).toBe('agstudio.3xosc');
    const bassPattern = p.patterns[res.patterns[1]!]!;
    expect(bassPattern.length).toBe(7680); // two bars
    expect(Object.values(bassPattern.notes[bass.id] ?? {}).map((n) => n.key).sort()).toEqual([36, 43]);
    expect(Object.values(p.playlist.clips)).toHaveLength(2);
    expect(s.view.getState().mode).toBe('song');
    // One undo step.
    s.history.undo();
    expect(s.doc.getState().project).toEqual(before);
  });

  it('turns tempo changes into a tempo automation clip', () => {
    const s = createTestServices();
    const data = parseMidi(file);
    data.tempos.push({ tick: 3840, bpm: 120 });
    importMidi(s, data, 'groove.mid', { split: false, tempo: true, place: true });
    const p = s.doc.getState().project;
    const tempo = Object.values(p.channels).find((c) => c.kind === 'automation');
    expect(tempo).toMatchObject({ target: { kind: 'tempo' }, points: [{ tick: 0, shape: 'hold' }, { tick: 3840 }] });
  });
});

describe('MIDI import options', () => {
  it('puts every part in one pattern and leaves the playlist alone when asked', () => {
    const s = createTestServices();
    const res = importMidi(s, parseMidi(file), 'groove.mid', { split: false, tempo: false, place: false });
    const p = s.doc.getState().project;
    expect(res.patterns).toHaveLength(1);
    expect(p.patterns[res.patterns[0]!]!.name).toBe('groove');
    expect(Object.values(p.playlist.clips)).toHaveLength(0);
    expect(p.transport.bpm).not.toBeCloseTo(95, 2);
    expect(s.view.getState().mode).not.toBe('song');
  });

  it('names split patterns after their tracks and sizes each to whole bars', () => {
    const s = createTestServices();
    const res = importMidi(s, parseMidi(file), 'groove.mid', { split: true, tempo: false, place: false });
    const p = s.doc.getState().project;
    expect(res.patterns.map((id) => p.patterns[id]!.name)).toEqual(['groove – Drums', 'groove – Bass']);
    expect(res.patterns.map((id) => p.patterns[id]!.length)).toEqual([3840, 7680]);
    expect(res.patterns.map((id) => p.patterns[id]!.stepCount)).toEqual([16, 32]);
  });

  it('skips the lanes of a recording’s takes when placing patterns', () => {
    const s = createTestServices();
    const takeLane = s.doc.getState().project.playlist.laneOrder[0]!;
    s.history.transact('takes', (d) => {
      d.playlist.lanes[takeLane]!.takes = { group: 'g', role: 'comp' };
    });
    importMidi(s, parseMidi(file), 'groove.mid', { split: true, tempo: false, place: true });
    const clips = Object.values(s.doc.getState().project.playlist.clips);
    expect(clips).toHaveLength(2);
    expect(clips.some((c) => c.laneId === takeLane)).toBe(false);
  });

  it('imports nothing from a file with no notes', () => {
    const s = createTestServices();
    const before = s.doc.getState().project;
    const res = importMidi(s, { format: 1, ppq: 960, tracks: [], tempos: [], timeSig: null }, 'empty.mid', { split: true, tempo: true, place: true });
    expect(res).toEqual({ patterns: [], channels: [], notes: 0, skipped: 0 });
    expect(s.doc.getState().project).toBe(before);
  });
});

describe('MIDI export', () => {
  it('writes the current pattern with kit channels as GM drums', () => {
    const s = createTestServices();
    const res = importMidi(s, parseMidi(file), 'groove.mid', { split: false, tempo: true, place: false });
    s.view.getState().setCurrentPattern(res.patterns[0]!);
    const { bytes } = exportMidi(s, 'pattern');
    const back = parseMidi(bytes);
    const drums = back.tracks.find((t) => t.notes.some((n) => n.channel === 9))!;
    expect(drums.notes.map((n) => n.key).sort()).toEqual([36]);
    const all = back.tracks.flatMap((t) => t.notes);
    expect(all.filter((n) => n.channel === 9).map((n) => n.key).sort()).toEqual([36, 38, 42]);
    expect(back.tempos[0]?.bpm).toBeCloseTo(95, 1);
  });

  it('writes the lyrics as lyric meta events on a Lyrics track (a "/" starts a line, a space ends a word)', () => {
    const s = createTestServices();
    const res = importMidi(s, parseMidi(file), 'groove.mid', { split: false, tempo: true, place: false });
    s.view.getState().setCurrentPattern(res.patterns[0]!);
    expect(parseMidi(exportMidi(s, 'pattern').bytes).tracks.some((t) => t.name === 'Lyrics')).toBe(false);
    s.history.transact('Lyrics', (d) =>
      void placeLyricWords(d, [
        { tick: 0, length: 480, text: 'beau', line: 0, continues: true },
        { tick: 480, length: 480, text: 'ti', line: 0, continues: true },
        { tick: 960, length: 480, text: 'ful', line: 0 },
        { tick: 3840, length: 480, text: 'day', line: 1 },
      ]),
    );
    const { bytes } = exportMidi(s, 'pattern');
    const back = parseMidi(bytes);
    expect(back.tracks.some((t) => t.name === 'Lyrics')).toBe(true);
    expect(lyricEvents(bytes)).toEqual([
      [0, 'beau'],
      [480, 'ti'],
      [960, 'ful '],
      [3840, '/day '],
    ]);
  });
});

/** The lyric meta events (FF 05) of a MIDI file as [absolute tick, text], read straight from the bytes. */
function lyricEvents(bytes: Uint8Array): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  let at = 14;
  while (at < bytes.length) {
    const end = at + 8 + ((bytes[at + 4]! << 24) | (bytes[at + 5]! << 16) | (bytes[at + 6]! << 8) | bytes[at + 7]!);
    let p = at + 8;
    let tick = 0;
    let isLyrics = false;
    while (p < end) {
      let delta = 0;
      let b: number;
      do {
        b = bytes[p++]!;
        delta = (delta << 7) | (b & 0x7f);
      } while (b & 0x80);
      tick += delta;
      if (bytes[p] !== 0xff) break;
      const type = bytes[p + 1]!;
      const length = bytes[p + 2]!;
      const text = String.fromCharCode(...bytes.subarray(p + 3, p + 3 + length));
      if (type === 0x03) isLyrics = text === 'Lyrics';
      if (type === 0x05 && isLyrics) out.push([tick, text]);
      p += 3 + length;
    }
    at = end;
  }
  return out;
}
