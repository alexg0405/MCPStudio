import { describe, expect, it } from 'vitest';
import { parseMidi, writeMidi } from '@core/io/midi';
import type { ChannelId } from '@core/model/types';
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
});
