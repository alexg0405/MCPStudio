import { describe, expect, it } from 'vitest';
import type { ChannelId, Note, PatternId } from '@core/model/types';
import { addMidiFx } from '@core/ops/midi-fx';
import { createTestServices } from './testing';

function setup() {
  const s = createTestServices();
  const engine = s.fakeEngine;
  engine.tempo = 120; // 1 s = 1920 ticks
  const channelId = s.doc.getState().project.channelOrder[0] as ChannelId;
  s.session.getState().selectChannel(channelId);
  const patternId = s.view.getState().currentPatternId as PatternId;
  const notes = () =>
    Object.values(s.doc.getState().project.patterns[patternId]!.notes[channelId] ?? {}).sort(
      (a: Note, b: Note) => a.tick - b.tick,
    );
  // Live events carry performance.now() milliseconds; the fake engine maps them to seconds.
  const play = (key: number, onMs: number, offMs: number, velocity = 0.9) => {
    s.live.noteOn(key, velocity, { source: 'midi' }, onMs);
    s.live.noteOff(key, 0.5, { source: 'midi' }, offMs);
  };
  return { s, engine, channelId, patternId, notes, play };
}

describe('note recording', () => {
  it('records live notes into the current pattern while armed and playing, as one undo step', () => {
    const { s, engine, notes, play } = setup();
    const before = notes().length;
    play(60, 500, 600); // not armed: only heard
    expect(notes()).toHaveLength(before);
    s.recording.setArmed(true);
    engine.play();
    play(64, 1000, 1250); // tick 1920, 0.25 s = 480 ticks
    play(67, 2100, 2200); // 2.1 s = 4032 ticks → wraps into the 1-bar pattern at 192
    const recorded = notes().filter((n) => n.key !== 60 || n.tick !== 0);
    expect(recorded.map((n) => [n.tick, n.length, n.key])).toEqual(
      expect.arrayContaining([
        [1920, 480, 64],
        [192, 192, 67],
      ]),
    );
    engine.stop();
    expect(s.recording.recording).toBe(false);
    s.history.undo();
    expect(notes()).toHaveLength(before);
  });

  it('snaps note starts to the record-quantize grid and replaces what new notes overlap', () => {
    const { s, engine, notes, play } = setup();
    s.prefs.getState().set({ recordQuantize: 480, recordMode: 'replace' });
    s.recording.setArmed(true);
    engine.play();
    play(62, 270, 520); // tick 518.4 → snapped to 480
    expect(notes().find((n) => n.key === 62)?.tick).toBe(480);
    play(65, 280, 400); // overlaps the note just recorded: replaces it
    expect(notes().filter((n) => n.key === 62)).toHaveLength(0);
    expect(notes().find((n) => n.key === 65)?.tick).toBe(480);
    engine.stop();
  });

  it('on a channel with MIDI effects records the keys played, or what the effects made of them, as the setting says', () => {
    const { s, engine, channelId, notes } = setup();
    s.history.transact('arp', (d) => void addMidiFx(d, channelId, 'arp'));
    // The keys played, then three notes the arpeggiator made of them (the engine tells the live input as they start and end).
    const heardOnce = () => {
      s.live.noteOn(60, 0.9, { source: 'midi' }, 1000);
      s.live.noteOff(60, 0.5, { source: 'midi' }, 1700);
      [0, 250, 500].forEach((ms, i) => {
        const time = 1 + ms / 1000;
        s.live.generated({ channelId, kind: 'on', noteId: 2 ** 31 + i, key: 64 + i, velocity: 0.7, time });
        s.live.generated({ channelId, kind: 'off', noteId: 2 ** 31 + i, key: 64 + i, velocity: 0.5, time: time + 0.1 });
      });
    };
    s.recording.setArmed(true);
    engine.play();
    const before = notes().length;
    heardOnce();
    expect(notes().slice(before).map((n) => n.key)).toEqual([60]);
    s.history.undo();
    s.prefs.getState().set({ recordMidiFx: 'generated' });
    heardOnce();
    expect(notes().slice(before).map((n) => n.key).sort()).toEqual([64, 65, 66]);
    engine.stop();
  });

  it('a channel without effects records what is played whatever the setting says', () => {
    const { s, engine, notes, play } = setup();
    s.prefs.getState().set({ recordMidiFx: 'generated' });
    s.recording.setArmed(true);
    engine.play();
    const before = notes().length;
    play(70, 1000, 1200);
    expect(notes().slice(before).map((n) => n.key)).toEqual([70]);
    engine.stop();
  });
});
