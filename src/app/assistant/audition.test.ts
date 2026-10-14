import { describe, expect, it, vi } from 'vitest';
import type { ChannelId } from '@core/model/types';
import { addInstrumentChannel } from '../actions/channels';
import { applyAnswer } from '../ai/apply';
import { createTestServices } from '../testing';
import { audition, phraseNotes } from './audition';

describe('audition', () => {
  it('plays phrases in the song key', () => {
    const s = createTestServices();
    const id = addInstrumentChannel(s, 'agstudio.3xosc')!;
    s.history.transact('key', (d) => void (d.transport.key = { root: 9, scale: 'minor' }));
    const chord = phraseNotes(s.doc.getState().project, id, 'chord');
    // A minor seventh on A: A C E G.
    expect(chord.map((n) => n.key % 12)).toEqual([9, 0, 4, 7]);
    expect(new Set(chord.map((n) => n.at))).toEqual(new Set([0]));
    const bass = phraseNotes(s.doc.getState().project, id, 'bass');
    expect(Math.max(...bass.map((n) => n.key))).toBeLessThan(60);
    expect(bass[0]!.key % 12).toBe(9);
  });

  it('drums: kits get kick, snare and hats; a single sound plays its own key', () => {
    const s = createTestServices();
    const pads = addInstrumentChannel(s, 'agstudio.drum-pads')!;
    expect(new Set(phraseNotes(s.doc.getState().project, pads, 'hits').map((n) => n.key))).toEqual(new Set([36, 38, 42]));
    const kick = s.doc.getState().project.channelOrder[0] as ChannelId;
    const root = s.doc.getState().project.channels[kick]!;
    const keys = phraseNotes(s.doc.getState().project, kick, 'hits').map((n) => n.key);
    expect(new Set(keys)).toEqual(new Set([root.kind === 'instrument' ? root.rootKey : 60]));
  });

  it('the AI’s audition action plays the sound it made, then stops', () => {
    vi.useFakeTimers();
    try {
      const s = createTestServices();
      const r = applyAnswer(
        s,
        {
          message: 'A warm pad.',
          actions: [
            { op: 'add_channel', ref: '@pad', plugin: 'agstudio.3xosc', name: 'Warm pad' },
            { op: 'audition', channel: '@pad', phrase: 'chord' },
          ],
        },
        { previousBeat: null },
      );
      const a = r.after.find((x) => x.kind === 'audition');
      expect(a).toMatchObject({ kind: 'audition', phrase: 'chord' });
      const on = vi.spyOn(s.engine, 'previewNoteOn');
      const off = vi.spyOn(s.engine, 'previewNoteOff');
      const stop = audition(s, (a as { channelId: ChannelId }).channelId, 'chord');
      vi.advanceTimersByTime(10);
      expect(on).toHaveBeenCalledTimes(4);
      stop();
      expect(off).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
