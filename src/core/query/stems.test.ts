import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '../model/defaults';
import { newId } from '../model/ids';
import { MASTER, type AudioClipChannel, type ChannelId, type ClipId, type InsertId, type LaneId, type PatternId } from '../model/types';
import { addChannel } from '../ops/channels';
import { setStep } from '../ops/notes';
import { addClips } from '../ops/playlist';
import { downstreamOf, planStems, playingChannels, stemProject, withoutMasterChain, type StemRange } from './stems';

const BAR = 3840;

/** Kick → Insert 1, snare → Insert 2 (which also sends to Insert 4), hat → master, audio → Insert 3. */
function song() {
  let p = createEmptyProject();
  const pid = p.patternOrder[0] as PatternId;
  const ins = p.mixer.order as InsertId[];
  const ch = (name: string, output: InsertId) =>
    makeInstrumentChannel(name, makePluginInstance('x', 1, {}), { output });
  const kick = ch('Kick', ins[1]!);
  const snare = ch('Snare', ins[2]!);
  const hat = ch('Hat', MASTER);
  const audio: AudioClipChannel = {
    kind: 'audioClip',
    id: newId.channel(),
    name: 'Vocal',
    color: '#888888',
    muted: false,
    solo: false,
    volume: 1,
    pan: 0,
    output: ins[3]!,
    sampleId: 'smp_x' as never,
  };
  p = produce(p, (d) => {
    for (const c of [kick, snare, hat, audio]) addChannel(d, c);
    for (const c of [kick, snare, hat]) setStep(d, pid, c.id, 0, true, { rootKey: 60 });
    d.mixer.inserts[ins[2]!]!.routes.push({ to: ins[4]!, level: 0.5, pre: false });
    d.mixer.inserts[ins[1]!]!.name = 'Kick: Sub';
    const lane = d.playlist.laneOrder[0] as LaneId;
    addClips(d, [
      { kind: 'pattern', id: 'c1' as ClipId, laneId: lane, start: 0, length: 2 * BAR, patternId: pid, offset: 0 },
      { kind: 'audio', id: 'c2' as ClipId, laneId: lane, start: 2 * BAR, length: BAR, channelId: audio.id, offsetSec: 0 },
    ]);
  });
  return { p, pid, ins, kick: kick.id, snare: snare.id, hat: hat.id, audio: audio.id };
}

const range = (fromTick: number, toTick: number): StemRange => ({ mode: 'song', patternId: null, fromTick, toTick });

describe('stem planning', () => {
  it('makes one stem per mixer track with sound in the range, in mixer order', () => {
    const { p, ins, kick, snare, hat, audio } = song();
    expect(planStems(p, range(0, 3 * BAR))).toEqual([
      { insertId: MASTER, name: '00 Master', channels: [hat] },
      { insertId: ins[1], name: '01 Kick- Sub', channels: [kick] },
      { insertId: ins[2], name: '02 Insert 2', channels: [snare] },
      { insertId: ins[3], name: '03 Insert 3', channels: [audio] },
    ]);
    // The vocal only plays in bar 3.
    expect(planStems(p, range(0, 2 * BAR)).map((s) => s.name)).toEqual(['00 Master', '01 Kick- Sub', '02 Insert 2']);
  });

  it('leaves out muted, solo-ed out and unrouted tracks and channels', () => {
    const { p, ins, kick, snare, hat, audio } = song();
    const r = range(0, 3 * BAR);
    expect(playingChannels(produce(p, (d) => void (d.channels[kick]!.muted = true)), r).has(kick)).toBe(false);
    expect(playingChannels(produce(p, (d) => void (d.mixer.inserts[ins[2]!]!.muted = true)), r).has(snare)).toBe(false);
    expect(playingChannels(produce(p, (d) => void (d.mixer.inserts[ins[3]!]!.routes = [])), r).has(audio)).toBe(false);
    const solo = playingChannels(produce(p, (d) => void (d.channels[hat]!.solo = true)), r);
    expect([...solo]).toEqual([hat]);
    // Pattern range: channels with notes in that pattern.
    const pattern = playingChannels(p, { mode: 'pattern', patternId: p.patternOrder[0]!, fromTick: 0, toTick: BAR });
    expect(new Set(pattern)).toEqual(new Set([kick, snare, hat]));
  });

  it('silences the other tracks with their mute, and a bus downstream through its channels only', () => {
    const base = song();
    // A pad on Insert 4, the bus the snare sends to.
    const pad = makeInstrumentChannel('Pad', makePluginInstance('x', 1, {}), { output: base.ins[4]! });
    const p = produce(base.p, (d) => {
      addChannel(d, pad);
      setStep(d, base.pid, pad.id, 4, true, { rootKey: 60 });
    });
    const stems = planStems(p, range(0, 3 * BAR));
    expect(downstreamOf(p, base.ins[2]!)).toEqual(new Set([base.ins[4], MASTER]));
    const snareStem = stems.find((s) => s.insertId === base.ins[2])!;
    const q = stemProject(p, stems, snareStem);
    const muted = (id: InsertId) => q.mixer.inserts[id]!.muted;
    expect(muted(base.ins[1]!)).toBe(true);
    expect(muted(base.ins[3]!)).toBe(true);
    // The snare's bus keeps playing (it carries the snare's send); its own pad is muted instead.
    expect(muted(base.ins[4]!)).toBe(false);
    expect(q.channels[pad.id]!.muted).toBe(true);
    expect(q.channels[base.hat as ChannelId]!.muted).toBe(true);
    expect(q.channels[base.snare]!.muted).toBe(false);
    expect(muted(MASTER)).toBe(false);
    // The master stem mutes every other track.
    const masterStem = stems.find((s) => s.insertId === MASTER)!;
    const m = stemProject(p, stems, masterStem);
    for (const s of stems) if (s !== masterStem) expect(m.mixer.inserts[s.insertId]!.muted).toBe(true);
    expect(m.channels[base.hat]!.muted).toBe(false);
  });

  it('can take the master chain out (effects off, fader and pan neutral)', () => {
    const { p } = song();
    const withFx = produce(p, (d) => {
      const m = d.mixer.inserts[MASTER]!;
      m.volume = 0.5;
      m.pan = 0.3;
      m.fx.push({ id: newId.slot(), plugin: makePluginInstance('fx', 1, {}), enabled: true, mix: 1, sidechain: null });
    });
    const q = withoutMasterChain(withFx).mixer.inserts[MASTER]!;
    expect(q).toMatchObject({ volume: 1, pan: 0 });
    expect(q.fx.every((s) => !s.enabled)).toBe(true);
  });
});
