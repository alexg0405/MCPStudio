/** Live keys through a channel's MIDI effects, against a fake clock: when notes start, what stops them, latch, echoes, edits. */
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import { seededBytes, setIdSource } from '@core/model/ids';
import type { ChannelId, MidiFxSlotId, Project } from '@core/model/types';
import { addChannel } from '@core/ops/channels';
import { setChord } from '@core/ops/chords';
import { addMidiFx, setMidiFxEnabled, setMidiFxParam } from '@core/ops/midi-fx';
import { midiFxOf } from '@core/query/midi-fx';
import { parseChord } from '@core/harmony/chord';
import { constantTempo } from '@core/time/ppq';
import type { NoteOff, NoteOn } from '@agstudio/sdk';
import { LiveMidiFx, type LiveFxOutput } from './live-midi-fx';

/** Seconds in a 1/16 at 120 BPM. */
const STEP_SEC = 0.125;

interface Rig {
  fx: LiveMidiFx;
  channelId: ChannelId;
  clock: { currentTime: number };
  ons: (NoteOn & { channelId: ChannelId })[];
  offs: NoteOff[];
  reports: LiveFxOutput[];
  setProject(project: Project): void;
  project(): Project;
  /** Moves the clock on in 25 ms beats, like the engine's timer, and runs the effects each time. */
  run(seconds: number): void;
  startsOf(): number[];
}

function rig(chain: (draft: Parameters<typeof addMidiFx>[0], channelId: ChannelId) => void, options: { songTick?: () => number | null } = {}): Rig {
  setIdSource(seededBytes(9));
  const channel = makeInstrumentChannel('Keys', makePluginInstance('x', 1, {}));
  let project = produce(createEmptyProject(), (draft) => {
    draft.transport.bpm = 120;
    addChannel(draft, channel);
    chain(draft, channel.id);
  });
  const clock = { currentTime: 1 };
  const ons: Rig['ons'] = [];
  const offs: NoteOff[] = [];
  const reports: LiveFxOutput[] = [];
  const fx = new LiveMidiFx(
    {
      ctx: clock,
      project: () => project,
      tempo: () => constantTempo(120),
      songTickAt: options.songTick ?? (() => null),
      restingTick: () => 0,
      startNote: (channelId, note) => ons.push({ ...note, channelId }),
      endNote: (_channelId, note) => offs.push(note),
      report: (output) => reports.push(output),
    },
    null,
  );
  return {
    fx,
    channelId: channel.id,
    clock,
    ons,
    offs,
    reports,
    setProject: (next) => {
      project = next;
      fx.projectChanged();
    },
    project: () => project,
    run(seconds) {
      const end = clock.currentTime + seconds;
      while (clock.currentTime < end - 1e-9) {
        clock.currentTime += 0.025;
        fx.tick();
      }
    },
    startsOf: () => ons.filter((on) => !offs.some((off) => off.noteId === on.noteId && off.time <= on.time)).map((on) => +on.time.toFixed(6)),
  };
}

const arp = (params: Record<string, string | number | boolean> = {}) => (draft: Parameters<typeof addMidiFx>[0], channelId: ChannelId) => void addMidiFx(draft, channelId, 'arp', { params });

describe('live keys through MIDI effects', () => {
  it('only channels with an effect that does something are handled', () => {
    const plain = rig(() => {});
    expect(plain.fx.handles(plain.channelId)).toBe(false);
    const bypassed = rig((draft, id) => setMidiFxEnabled(draft, id, addMidiFx(draft, id, 'arp')!, false));
    expect(bypassed.fx.handles(bypassed.channelId)).toBe(false);
    const active = rig(arp());
    expect(active.fx.handles(active.channelId)).toBe(true);
  });

  it('an arpeggio starts the moment the key goes down, then keeps to the grid', () => {
    const t = rig(arp());
    const start = t.clock.currentTime;
    t.fx.noteOn(t.channelId, 1, 60, 0.8);
    t.fx.noteOn(t.channelId, 2, 64, 0.8);
    t.fx.noteOn(t.channelId, 3, 67, 0.8);
    // The first note is scheduled for now, as a plain live note would be.
    expect(t.ons[0]!.time).toBeCloseTo(start, 9);
    t.run(0.5);
    const times = t.startsOf();
    expect(times.slice(0, 4).map((x) => +(x - start).toFixed(6))).toEqual([0, STEP_SEC, 2 * STEP_SEC, 3 * STEP_SEC]);
    expect(t.ons.slice(0, 4).map((on) => on.key)).toEqual([60, 64, 67, 60]);
  });

  it('keeps arpeggiating the chord that is down, and stops when the keys go up', () => {
    const t = rig(arp({ gate: 0.5 }));
    t.fx.noteOn(t.channelId, 1, 60, 0.8);
    t.fx.noteOn(t.channelId, 2, 64, 0.8);
    t.run(1);
    t.fx.noteOff(t.channelId, 1, t.clock.currentTime);
    t.fx.noteOff(t.channelId, 2, t.clock.currentTime);
    const playedBefore = t.ons.length;
    t.run(1);
    // At most the notes already due inside the lookahead; then nothing more, and every note was released.
    expect(t.ons.length - playedBefore).toBeLessThanOrEqual(1);
    expect(t.fx.activeChannels).toBe(0);
    for (const on of t.ons) expect(t.offs.filter((off) => off.noteId === on.noteId && off.time > on.time)).toHaveLength(1);
  });

  it('a note that is sounding is released at the end of its gate', () => {
    const t = rig(arp({ gate: 0.5 }));
    t.fx.noteOn(t.channelId, 1, 60, 0.8);
    t.run(0.3);
    const first = t.ons[0]!;
    const off = t.offs.find((o) => o.noteId === first.noteId && o.time > first.time)!;
    expect(off.time - first.time).toBeCloseTo(STEP_SEC / 2, 6);
  });

  it('latch keeps the arpeggio going after the keys are let go, until everything is stopped', () => {
    const t = rig(arp({ latch: true }));
    t.fx.noteOn(t.channelId, 1, 60, 0.8);
    t.fx.noteOn(t.channelId, 2, 67, 0.8);
    t.run(0.3);
    t.fx.noteOff(t.channelId, 1, t.clock.currentTime);
    t.fx.noteOff(t.channelId, 2, t.clock.currentTime);
    const before = t.ons.length;
    t.run(1);
    expect(t.ons.length - before).toBeGreaterThanOrEqual(7);
    expect(t.fx.activeChannels).toBe(1);
    t.fx.allNotesOff();
    expect(t.fx.activeChannels).toBe(0);
    const stopped = t.ons.length;
    t.run(0.5);
    expect(t.ons).toHaveLength(stopped);
  });

  it('a new chord replaces a latched one', () => {
    const t = rig(arp({ latch: true }));
    t.fx.noteOn(t.channelId, 1, 60, 0.8);
    t.run(0.3);
    t.fx.noteOff(t.channelId, 1, t.clock.currentTime);
    t.run(0.3);
    t.fx.noteOn(t.channelId, 2, 72, 0.8);
    const from = t.ons.length;
    t.run(0.6);
    expect(t.ons.slice(from).map((on) => on.key)).toEqual(t.ons.slice(from).map(() => 72));
    expect(t.ons.length).toBeGreaterThan(from + 3);
  });

  it('an effect that does not move notes in time plays the key now and releases it with the key', () => {
    const t = rig((draft, id) => void addMidiFx(draft, id, 'transpose', { params: { semitones: 7 } }));
    const start = t.clock.currentTime;
    t.fx.noteOn(t.channelId, 1, 60, 0.8);
    expect(t.ons.map((on) => [on.key, +(on.time - start).toFixed(9)])).toEqual([[67, 0]]);
    t.run(0.2);
    expect(t.offs).toHaveLength(0);
    t.fx.noteOff(t.channelId, 1, t.clock.currentTime);
    expect(t.offs).toHaveLength(1);
    expect(t.offs[0]!.noteId).toBe(t.ons[0]!.noteId);
    expect(t.offs[0]!.time).toBeGreaterThan(t.ons[0]!.time);
  });

  it('echoes go on after the key is released, then the channel settles', () => {
    const t = rig((draft, id) => void addMidiFx(draft, id, 'echo', { params: { delay: '1/8', repeats: 3, feedback: 0.7 } }));
    t.fx.noteOn(t.channelId, 1, 60, 0.8);
    t.run(0.05);
    t.fx.noteOff(t.channelId, 1, t.clock.currentTime);
    t.run(3);
    expect(t.ons).toHaveLength(4);
    expect(t.fx.activeChannels).toBe(0);
  });

  it('chord notes all start together', () => {
    const t = rig((draft, id) => void addMidiFx(draft, id, 'chord', { params: { shape: 'maj' } }));
    t.fx.noteOn(t.channelId, 1, 60, 0.8);
    expect(t.ons.map((on) => on.key).sort()).toEqual([60, 64, 67]);
    expect(new Set(t.ons.map((on) => on.time)).size).toBe(1);
  });

  it('follows the chord track at the resting playhead', () => {
    const t = rig((draft, id) => {
      addMidiFx(draft, id, 'chord', { params: { source: 'chordTrack' } });
      setChord(draft, 0, 3840, parseChord('Am')!);
    });
    t.fx.noteOn(t.channelId, 1, 60, 0.8);
    expect(t.ons.map((on) => on.key).sort((a, b) => a - b)).toEqual([57, 60, 64]);
  });

  it('turning a knob while keys are down changes what plays next, without a gap', () => {
    const t = rig(arp({ rate: '1/16' }));
    t.fx.noteOn(t.channelId, 1, 60, 0.8);
    t.run(0.4);
    const before = t.startsOf().length;
    const slot = midiFxOf(t.project().channels[t.channelId])[0]!.id as MidiFxSlotId;
    t.setProject(produce(t.project(), (draft) => void setMidiFxParam(draft, t.channelId, slot, 'rate', '1/4')));
    t.run(1.1);
    const starts = t.startsOf();
    // A quarter note is four times as long as a 1/16.
    const after = starts.slice(before);
    expect(after.length).toBeGreaterThan(1);
    expect(after[1]! - after[0]!).toBeCloseTo(4 * STEP_SEC, 6);
  });

  it('removing the chain while a note sounds releases it', () => {
    const t = rig(arp({ latch: true }));
    t.fx.noteOn(t.channelId, 1, 60, 0.8);
    t.run(0.2);
    t.setProject(produce(t.project(), (draft) => void delete (draft.channels[t.channelId] as { midiFx?: unknown }).midiFx));
    expect(t.fx.activeChannels).toBe(0);
    const count = t.ons.length;
    t.run(0.5);
    expect(t.ons).toHaveLength(count);
  });

  it('tells the app when a generated note starts and ends, and never about one that was cancelled', () => {
    const t = rig(arp({ gate: 0.5 }));
    t.fx.noteOn(t.channelId, 1, 60, 0.8);
    t.fx.noteOn(t.channelId, 2, 64, 0.8);
    t.run(0.6);
    t.fx.noteOff(t.channelId, 1, t.clock.currentTime);
    t.fx.noteOff(t.channelId, 2, t.clock.currentTime);
    t.run(0.5);
    const ons = t.reports.filter((r) => r.kind === 'on');
    const offs = t.reports.filter((r) => r.kind === 'off');
    expect(ons.length).toBeGreaterThan(3);
    expect(offs.map((o) => o.noteId).sort()).toEqual(ons.map((o) => o.noteId).sort());
    for (const on of ons) expect(offs.find((o) => o.noteId === on.noteId)!.time).toBeGreaterThan(on.time);
  });

  it('while the song plays, steps are on the song grid: the first one waits for the next step', () => {
    const t = rig(arp({ sync: 'song' }), { songTick: () => 100 });
    const start = t.clock.currentTime;
    t.fx.noteOn(t.channelId, 1, 60, 0.8);
    t.run(0.3);
    // The key went down at tick 100: the next 1/16 line is tick 240, 140 ticks (0.0729 s at 120 BPM) later.
    expect(t.ons[0]!.time - start).toBeCloseTo(140 * (60 / (120 * 960)), 6);
  });
});
