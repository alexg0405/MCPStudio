import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import type { AudioClipChannel, ChannelId, ClipId, LaneId, PatternId, Project, SampleId } from '@core/model/types';
import { addChannel } from '@core/ops/channels';
import { setStep } from '@core/ops/notes';
import { addClips } from '@core/ops/playlist';
import { PPQ, constantTempo } from '@core/time/ppq';
import { collectAudio, collectNotes, songModeSource, type NoteEvent } from './events';
import { Transport } from './transport';

function project(): { p: Project; pid: PatternId; lanes: LaneId[]; audioCh: ChannelId } {
  let p = createEmptyProject();
  const pid = p.patternOrder[0] as PatternId;
  const lanes = p.playlist.laneOrder as LaneId[];
  const kick = makeInstrumentChannel('Kick', makePluginInstance('x', 1, {}));
  const audio: AudioClipChannel = {
    kind: 'audioClip',
    id: 'ch_audio' as ChannelId,
    name: 'Loop',
    color: '#fff',
    muted: false,
    solo: false,
    volume: 1,
    pan: 0,
    output: p.mixer.order[0]!,
    sampleId: 'smp_x' as SampleId,
  };
  p = produce(p, (d) => {
    d.transport.bpm = 120;
    addChannel(d, kick);
    addChannel(d, audio);
    setStep(d, pid, kick.id, 0, true, { rootKey: 60 });
    addClips(d, [
      { kind: 'pattern', id: 'p1' as ClipId, laneId: lanes[0]!, start: 0, length: 3840, patternId: pid, offset: 0 },
      { kind: 'pattern', id: 'p2' as ClipId, laneId: lanes[0]!, start: 7680, length: 3840, patternId: pid, offset: 0 },
      {
        kind: 'audio',
        id: 'a1' as ClipId,
        laneId: lanes[1]!,
        start: 3840,
        length: 3840,
        channelId: audio.id,
        offsetSec: 0.25,
      },
    ]);
  });
  return { p, pid, lanes, audioCh: audio.id };
}

describe('song mode events', () => {
  it('plays pattern clips where they sit and spans the song in whole bars', () => {
    const { p } = project();
    const { source, length } = songModeSource(p);
    expect(length).toBe(3840 * 3);
    const out: NoteEvent[] = [];
    collectNotes(source, 0, length, out);
    expect(out.map((e) => e.start)).toEqual([0, 7680]);
  });

  it('starts audio clips at their start, or mid-way when playback begins inside them', () => {
    const { p } = project();
    const { source } = songModeSource(p);
    const spt = 60 / (120 * PPQ);
    const out: NoteEvent[] = [];
    collectAudio(source, 0, 9999, out, null, constantTempo(120));
    expect(out.map((e) => [e.start, e.offsetSec])).toEqual([[3840, 0.25]]);
    const mid: NoteEvent[] = [];
    collectAudio(source, 4800, 5000, mid, 4800, constantTempo(120));
    expect(mid[0]!.start).toBe(4800);
    expect(mid[0]!.offsetSec).toBeCloseTo(0.25 + 960 * spt, 9);
  });

  it('skips muted lanes and clips', () => {
    const { p, lanes } = project();
    const muted = produce(p, (d) => {
      d.playlist.lanes[lanes[0]!]!.muted = true;
    });
    const out: NoteEvent[] = [];
    collectNotes(songModeSource(muted).source, 0, 99999, out);
    expect(out).toEqual([]);
  });

  it('the transport starts an audio clip mid-way when playback starts inside it', () => {
    const { p } = project();
    const { source, length } = songModeSource(p);
    const spt = 60 / (120 * PPQ);
    const clock = { currentTime: 0 };
    const ons: { channelId: string; time: number; offset?: number }[] = [];
    const t = new Transport(
      clock,
      {
        noteOn: (c, e) =>
          ons.push({ channelId: c, time: e.time, ...(e.offset !== undefined ? { offset: e.offset } : {}) }),
        noteOff: () => {},
        allNotesOff: () => {},
      },
      source,
      { tempo: constantTempo(120), loop: { start: 0, end: length }, endTick: length },
    );
    t.start(4800, 0);
    clock.currentTime = 0.1;
    t.pump();
    const audio = ons.find((o) => o.channelId === 'ch_audio');
    expect(audio?.time).toBe(0);
    expect(audio?.offset).toBeCloseTo(0.25 + 960 * spt, 9);
  });
});

describe('audio clips across edits', () => {
  it("an edit elsewhere doesn't restart a sample that is playing; editing the clip does", () => {
    const { p, pid } = project();
    const clock = { currentTime: 0 };
    const ons: { channelId: string; time: number; offset?: number }[] = [];
    const offs: { channelId: string; time: number }[] = [];
    const model = (proj: Project) => {
      const { source, length } = songModeSource(proj);
      return { source, timeline: { tempo: constantTempo(120), loop: { start: 0, end: length }, endTick: length } };
    };
    const m = model(p);
    const t = new Transport(
      clock,
      {
        noteOn: (c, e) =>
          ons.push({ channelId: c, time: e.time, ...(e.offset !== undefined ? { offset: e.offset } : {}) }),
        noteOff: (c, e) => offs.push({ channelId: c, time: e.time }),
        allNotesOff: () => {},
      },
      m.source,
      m.timeline,
    );
    t.start(4800, 0); // inside the audio clip (3840…7680)
    clock.currentTime = 0.1;
    t.pump();
    expect(ons.filter((o) => o.channelId === 'ch_audio')).toHaveLength(1);
    // An unrelated edit (a new step in the pattern): the sample keeps playing, not a second copy.
    const edited = produce(p, (d) => {
      setStep(d, pid, Object.keys(d.channels)[0] as ChannelId, 4, true, { rootKey: 60 });
    });
    const m2 = model(edited);
    t.setModel(m2.source, m2.timeline);
    clock.currentTime = 0.3;
    t.pump();
    expect(ons.filter((o) => o.channelId === 'ch_audio')).toHaveLength(1);
    expect(offs.filter((o) => o.channelId === 'ch_audio')).toHaveLength(0);
    // Trimming the clip itself restarts it from the new model.
    const trimmed = produce(edited, (d) => {
      const c = d.playlist.clips['a1' as ClipId];
      if (c?.kind === 'audio') c.offsetSec = 0.5;
    });
    const m3 = model(trimmed);
    t.setModel(m3.source, m3.timeline);
    clock.currentTime = 0.4;
    t.pump();
    expect(offs.filter((o) => o.channelId === 'ch_audio')).toHaveLength(1);
    expect(ons.filter((o) => o.channelId === 'ch_audio')).toHaveLength(2);
  });
});
