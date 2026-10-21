/**
 * MIDI effects through the real engine, rendered offline: the onsets of an arpeggio land on the grid to the frame, a chain
 * that follows the chord track and the song key plays the right notes, a re-plan in the middle of playback keeps the
 * arpeggio in phase, a render repeats bit for bit, and rendering the effects to notes sounds exactly like the effects.
 */
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { parseChord } from '@core/harmony/chord';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import { seededBytes, setIdSource } from '@core/model/ids';
import type { ChannelId, ClipId, LaneId, NoteId, PatternId, Project } from '@core/model/types';
import { addChannel } from '@core/ops/channels';
import { setChord } from '@core/ops/chords';
import { addMidiFx, setMidiFxParam } from '@core/ops/midi-fx';
import { addNote } from '@core/ops/notes';
import { addClips } from '@core/ops/playlist';
import { midiFxOf } from '@core/query/midi-fx';
import { Engine } from '@engine/engine';
import { renderOffline } from '@engine/render-offline';
import { planBake, writeBake } from '@app/actions/midi-fx-bake';
import { defaultValues, defineInstrument, defineWorkletInstrument, p, type PluginDef } from '@agstudio/sdk';
import processor from './impulse.worklet.ts?worker&url';
import { maxDiff, resolver } from '../helpers/fixtures';

const SR = 48000;
const BAR = 3840;
const PRE_ROLL = 2048;
const LIMITER_DELAY = Math.round(0.0013 * SR);
const START = PRE_ROLL + LIMITER_DELAY;
/** One render quantum: the finest timing the audio thread has. */
const BLOCK = 128;

/** One impulse of 0.5 on the note-on frame (frame-exact, from the worklet timing tests). */
const impulse = defineWorkletInstrument({ id: 'test.impulse', name: 'Impulse', version: 1, params: {}, processor });

/** What the spy instrument heard: every note it was handed, and the releases (a release at or before the start cancels). */
interface Heard {
  ons: { noteId: number; time: number; key: number; velocity: number }[];
  offs: Map<number, number>;
}
const heard: Heard = { ons: [], offs: new Map() };

/** An instrument that makes no sound and writes down the notes it is given: what the engine really hands an instrument. */
const spy = defineInstrument({
  id: 'test.spy',
  name: 'Spy',
  version: 1,
  params: { level: p.float(0, 1, 0.5) },
  create({ audioContext }) {
    const out = new GainNode(audioContext);
    return {
      output: out,
      noteOn: ({ time, noteId, key, velocity }) => void heard.ons.push({ noteId, time, key, velocity }),
      noteOff: ({ noteId, time }) => void heard.offs.set(noteId, time),
      allNotesOff: () => {},
      dispose: () => out.disconnect(),
    };
  },
});

/** The notes the spy was given that were not cancelled, by time. */
function played(): { time: number; key: number; velocity: number }[] {
  return heard.ons
    .filter((on) => !((heard.offs.get(on.noteId) ?? Infinity) <= on.time))
    .map(({ time, key, velocity }) => ({ time, key, velocity }))
    .sort((a, b) => a.time - b.time || a.key - b.key);
}

const plugins = resolver(impulse as PluginDef, spy as PluginDef);

interface Rig {
  project: Project;
  patternId: PatternId;
  channelId: ChannelId;
}

/** One channel of `def` with a held C major chord (one bar) and its chain added by `chain`. */
function rig(def: PluginDef, chain: (draft: Parameters<typeof addMidiFx>[0], channelId: ChannelId) => void, bpm = 120): Rig {
  setIdSource(seededBytes(21));
  const channel = makeInstrumentChannel(def.name, makePluginInstance(def.id, def.version, defaultValues(def.params)));
  const base = createEmptyProject();
  const patternId = base.patternOrder[0] as PatternId;
  const project = produce(base, (draft) => {
    draft.transport.bpm = bpm;
    addChannel(draft, channel);
    draft.patterns[patternId]!.length = BAR;
    [60, 64, 67].forEach((key, i) => addNote(draft, patternId, channel.id, { id: `n${i}` as NoteId, tick: 0, length: BAR, key, velocity: 0.8 }));
    chain(draft, channel.id);
  });
  return { project, patternId, channelId: channel.id };
}

async function render(project: Project, patternId: PatternId, options: { chunk?: number; bars?: number } = {}): Promise<AudioBuffer> {
  const result = await renderOffline(project, {
    plugins,
    view: { mode: 'pattern', patternId, loop: null },
    bars: options.bars ?? 1,
    sampleRate: SR,
    tail: 0.2,
    ...(options.chunk ? { chunk: options.chunk } : {}),
  });
  return result.buffer;
}

/** The frames where the render has an impulse. */
function spikes(buffer: AudioBuffer): number[] {
  const data = buffer.getChannelData(0);
  const out: number[] = [];
  for (let i = 0; i < data.length; i++) if (Math.abs(data[i] as number) > 0.2) out.push(i);
  return out;
}

describe('an arpeggiator in an offline render', () => {
  it('puts every onset on the grid, to the frame, whatever the chunk size', async () => {
    const { project, patternId } = rig(impulse as PluginDef, (draft, id) => void addMidiFx(draft, id, 'arp', { params: { pattern: 'up', rate: '1/16' } }));
    // 120 BPM: a 1/16 is 0.125 s = 6000 frames.
    const expected = Array.from({ length: 16 }, (_, step) => START + step * 6000);
    for (const chunk of [BLOCK * 16, BLOCK * 37, BLOCK * 256]) {
      const found = spikes(await render(project, patternId, { chunk }));
      expect(found, `chunk ${chunk}`).toEqual(expected);
      // Within one render block of the grid, as the audio thread allows (they are exact here).
      found.forEach((frame, i) => expect(Math.abs(frame - expected[i]!)).toBeLessThan(BLOCK));
    }
  });

  it('triplets and swing land where the maths says', async () => {
    const triplets = rig(impulse as PluginDef, (draft, id) => void addMidiFx(draft, id, 'arp', { params: { rate: '1/16t' } }));
    // A 1/16 triplet is 160 ticks = 4000 frames.
    const found = spikes(await render(triplets.project, triplets.patternId));
    expect(found.slice(0, 5)).toEqual([0, 1, 2, 3, 4].map((step) => START + step * 4000));
    const swung = rig(impulse as PluginDef, (draft, id) => void addMidiFx(draft, id, 'arp', { params: { rate: '1/16', swing: 1 } }));
    // Every second step is half a step (3000 frames) late.
    expect(spikes(await render(swung.project, swung.patternId)).slice(0, 4)).toEqual([START, START + 9000, START + 12000, START + 21000]);
  });

  it('an arpeggio is exactly the same render twice (and so is a chain with random, humanize and echo)', async () => {
    const { project, patternId } = rig(impulse as PluginDef, (draft, id) => {
      addMidiFx(draft, id, 'arp', { params: { pattern: 'random', octaves: 2, seed: 7 } });
      addMidiFx(draft, id, 'humanize', { params: { timing: 12, seed: 3 } });
      addMidiFx(draft, id, 'echo', { params: { delay: '1/8', repeats: 2 } });
      addMidiFx(draft, id, 'random', { params: { chance: 0.9, seed: 2 } });
    });
    const first = await render(project, patternId);
    expect(spikes(first).length).toBeGreaterThan(10);
    expect(maxDiff(first, await render(project, patternId))).toBe(0);
  });
});

describe('effects that follow the song', () => {
  it('chords on the chord track: the effect plays the chord of the moment, as the instrument is handed it', async () => {
    heard.ons.length = 0;
    heard.offs.clear();
    const { project, patternId } = rig(spy as PluginDef, (draft, id) => {
      addMidiFx(draft, id, 'chord', { params: { source: 'chordTrack' } });
      setChord(draft, 0, BAR / 2, parseChord('Am')!);
      setChord(draft, BAR / 2, BAR / 2, parseChord('G')!);
    });
    // Notes of the pattern at 0 (the held chord) and one at the half bar, so each chord is asked for.
    const withSecond = produce(project, (draft) => {
      const channelId = Object.keys(draft.channels)[0] as ChannelId;
      addNote(draft, patternId, channelId, { id: 'later' as NoteId, tick: BAR / 2, length: 480, key: 60, velocity: 0.8 });
    });
    await render(withSecond, patternId);
    const at = (second: number) => played().filter((n) => Math.abs(n.time - (START + second * SR) / SR) < 0.01).map((n) => n.key);
    expect(at(0)).toEqual(expect.arrayContaining([57, 60, 64]));
    expect(at(1)).toEqual(expect.arrayContaining([55, 59, 62]));
  });

  it('scale effect snaps to the song key', async () => {
    heard.ons.length = 0;
    heard.offs.clear();
    const { project, patternId } = rig(spy as PluginDef, (draft, id) => {
      addMidiFx(draft, id, 'scale', { params: { source: 'song', direction: 'down' } });
      draft.transport.key = { root: 0, scale: 'major' };
      // One semitone up: C#, F and G#. F is in C major; the other two are not and move down to C and G.
      for (const note of Object.values(draft.patterns[draft.patternOrder[0] as PatternId]!.notes[id]!)) note.key += 1;
    });
    await render(project, patternId);
    expect(played().map((n) => n.key).sort((x, y) => x - y)).toEqual([60, 65, 67]);
  });

  it('plays the pattern again in every clip of the song, each one asking the chord track where it sits', async () => {
    heard.ons.length = 0;
    heard.offs.clear();
    const { project, patternId } = rig(spy as PluginDef, (draft, id) => {
      addMidiFx(draft, id, 'chord', { params: { source: 'chordTrack' } });
      setChord(draft, 0, BAR, parseChord('C')!);
      setChord(draft, BAR, BAR, parseChord('F')!);
    });
    const lane = project.playlist.laneOrder[0] as LaneId;
    const song = produce(project, (draft) => {
      addClips(draft, [
        { kind: 'pattern', id: 'c1' as ClipId, laneId: lane, start: 0, length: BAR, patternId, offset: 0 },
        { kind: 'pattern', id: 'c2' as ClipId, laneId: lane, start: BAR, length: BAR, patternId, offset: 0 },
      ]);
    });
    await renderOffline(song, { plugins, view: { mode: 'song', patternId: null, loop: null }, bars: 2, sampleRate: SR, tail: 0.2 });
    const seconds = (time: number) => Math.round(((time * SR - START) / SR) * 4) / 4;
    const firstBar = played().filter((n) => seconds(n.time) === 0).map((n) => n.key);
    const secondBar = played().filter((n) => seconds(n.time) === 2).map((n) => n.key);
    expect(firstBar).toContain(60);
    expect(secondBar).toContain(65);
  });
});

describe('a re-plan in the middle of playback', () => {
  /** The moments the render stops at to plan ahead (whole render quanta of 128 frames); the edit is made at the second one. */
  const STOPS = [0.4, 0.8, 1.2, 1.6, 2.0];
  const EDIT_AT = 0.8;

  /**
   * Plays a rig on an offline engine, the way the live scheduler does: it plans a little ahead at each stop of the render, and
   * `edit` changes the project at the second stop (so the clock is where a live edit would find it, not at 0).
   */
  async function playWithEdit(start: Rig, edit?: (project: Project) => Project): Promise<ReturnType<typeof played>> {
    heard.ons.length = 0;
    heard.offs.clear();
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(SR * 2.5), sampleRate: SR });
    const engine = new Engine(ctx, { plugins } as never, true);
    try {
      engine.applyDocChange({ next: start.project, prev: start.project, patches: null, origin: 'load' });
      engine.setTransportView({ mode: 'pattern', patternId: start.patternId, loop: null });
      await engine.ready();
      engine.startOffline(0, 0.1);
      engine.pumpOffline(0.5);
      const stopped = STOPS.map((at) =>
        ctx.suspend(at).then(() => {
          // Planned ahead first, as the scheduler's tick always has: a live edit finds notes planned past "now".
          engine.pumpOffline(at + 0.4);
          if (edit && at === EDIT_AT) engine.applyDocChange({ next: edit(start.project), prev: start.project, patches: null, origin: 'edit' });
          return ctx.resume();
        }),
      );
      await Promise.all([ctx.startRendering(), ...stopped]);
      return played().filter((n) => n.time < 2.2);
    } finally {
      await engine.dispose();
    }
  }

  it('keeps the arpeggio exactly where it was when the edit is about something else', async () => {
    const start = rig(spy as PluginDef, (draft, id) => void addMidiFx(draft, id, 'arp', { params: { rate: '1/16', swing: 0.3, pattern: 'upDown' } }));
    const steady = await playWithEdit(start);
    const edited = await playWithEdit(start, (project) =>
      produce(project, (draft) => {
        const other = makeInstrumentChannel('Other', makePluginInstance(spy.id, 1, {}));
        addChannel(draft, other);
        addNote(draft, start.patternId, other.id, { id: 'o' as NoteId, tick: 0, length: 240, key: 36, velocity: 1 });
      }),
    );
    const arp = (notes: typeof steady) => notes.filter((n) => n.key !== 36).map((n) => [+n.time.toFixed(9), n.key]);
    expect(arp(steady).length).toBeGreaterThan(8);
    expect(arp(edited)).toEqual(arp(steady));
  });

  it('an edit of the arpeggiator itself takes effect from the next step and stays on the grid', async () => {
    const start = rig(spy as PluginDef, (draft, id) => void addMidiFx(draft, id, 'arp', { params: { rate: '1/16' } }));
    const faster = await playWithEdit(start, (project) =>
      produce(project, (draft) => {
        const channelId = start.channelId;
        setMidiFxParam(draft, channelId, midiFxOf(draft.channels[channelId])[0]!.id, 'rate', '1/32');
      }),
    );
    // From the re-plan (just after 0.8 s) on, notes sit on the 1/32 grid, 62.5 ms apart, counted from the first note at 0.1 s.
    const later = faster.filter((n) => n.time > EDIT_AT + 0.05);
    expect(later.length).toBeGreaterThan(8);
    for (const note of later) expect(((note.time - 0.1) / 0.0625) % 1).toBeCloseTo(0, 5);
  });
});

describe('render MIDI effects to notes', () => {
  it('sounds exactly like the effects did (the same render, sample for sample)', async () => {
    const { project, patternId, channelId } = rig(impulse as PluginDef, (draft, id) => {
      addMidiFx(draft, id, 'arp', { params: { pattern: 'upDown', octaves: 2, rate: '1/16', swing: 0.2, gate: 0.6 } });
      addMidiFx(draft, id, 'echo', { params: { delay: '1/8', repeats: 2 } });
      addMidiFx(draft, id, 'velocity', { params: { curve: -0.5 } });
      draft.transport.swing = 0.3;
    });
    const withEffects = await render(project, patternId);
    const plan = planBake(project, channelId)!;
    const baked = produce(project, (draft) => writeBake(draft, channelId, plan));
    expect(midiFxOf(baked.channels[channelId])).toEqual([]);
    const rendered = await render(baked, patternId);
    // The echoes fall on arpeggio steps, so impulses share frames: what matters is that there are many and that they match.
    expect(spikes(withEffects).length).toBeGreaterThanOrEqual(16);
    expect(maxDiff(withEffects, rendered)).toBe(0);
  });
});
