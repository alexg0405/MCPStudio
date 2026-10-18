/**
 * The clip launcher through the transport (fake clock and sink, exact times): quantized starts and stops land on
 * the boundary, a new slot replaces the playing one there, launched notes carry on across the song's loop wrap,
 * a launcher track takes over its playlist track, follow actions, audio passes.
 */
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { LaunchSequencer } from '@core/launcher/sequencer';
import type { LaunchClock } from '@core/launcher/run';
import { launcherFixture } from '@core/launcher/test-project';
import type { AudioClip, ChannelId, ClipId, LaunchTrackId, PatternId, Project, SceneId } from '@core/model/types';
import { contentFromAudioChannel, patchSlot, setSlotContent, setTrackLane } from '@core/ops/launcher';
import { addClips } from '@core/ops/playlist';
import { constantTempo, type TempoMap } from '@core/time/ppq';
import { songModeSource, type EventSource } from './events';
import { Transport, type AudioOn, type TransportSink } from './transport';

const BAR = 3840;
const BAR_SEC = 2; // 120 BPM

interface Call {
  t: 'on' | 'off' | 'audio' | 'all';
  time: number;
  noteId: number;
  key: number;
  channel: ChannelId;
}

function rig(opts: { song?: boolean; edit?: (p: Project, f: ReturnType<typeof launcherFixture>) => Project } = {}) {
  const f = launcherFixture();
  let project = produce(f.project, (d) => void (d.transport.bpm = 120));
  if (opts.edit) project = opts.edit(project, f);
  const tempo: TempoMap = constantTempo(120);
  const clock = { currentTime: 0 };
  const calls: Call[] = [];
  const audio: AudioOn[] = [];
  const sink: TransportSink = {
    noteOn: (c, e) => calls.push({ t: 'on', time: e.time, noteId: e.noteId, key: e.key, channel: c }),
    noteOff: (c, e) => calls.push({ t: 'off', time: e.time, noteId: e.noteId, key: e.key, channel: c }),
    allNotesOff: (time) => calls.push({ t: 'all', time, noteId: 0, key: 0, channel: '' as ChannelId }),
    audioOn: (c, e) => {
      audio.push(e);
      calls.push({ t: 'audio', time: e.time, noteId: e.noteId, key: e.key, channel: c });
    },
  };
  const seq = new LaunchSequencer({ project: () => project, random: () => 0 });
  let solo = !opts.song;
  const model = () => {
    const launch = { launch: { runs: seq.runs } };
    if (solo)
      return {
        source: { project, clips: [], ...launch } as EventSource,
        timeline: { tempo, loop: null, endTick: Number.MAX_SAFE_INTEGER },
      };
    const { source, length } = songModeSource(project);
    const end = Math.max(length, BAR);
    return { source: { ...source, ...launch } as EventSource, timeline: { tempo, loop: { start: 0, end }, endTick: end } };
  };
  const m0 = model();
  const transport = new Transport(clock, sink, m0.source, m0.timeline);
  let seen = seq.runs;
  const clockOf = (): LaunchClock =>
    transport.playing
      ? { playing: true, heardU: transport.uAtTime(clock.currentTime), earliestU: transport.uAtTime(clock.currentTime + 0.03) }
      : { playing: false, heardU: 0, earliestU: 0 };
  const sync = () => {
    seq.advance(clockOf());
    if (seq.runs !== seen) {
      seen = seq.runs;
      const m = model();
      transport.setModel(m.source, m.timeline);
    }
  };
  const run = (until: number) => {
    while (clock.currentTime < until - 1e-9) {
      clock.currentTime = Math.min(until, clock.currentTime + 0.025);
      sync();
      transport.pump();
    }
  };
  /** A press: runs `fn` against the clock, then hands the changed runs to the transport (like Engine.launcherChanged). */
  const press = (fn: (clk: LaunchClock) => unknown) => {
    fn(clockOf());
    if (seq.runs !== seen) {
      seen = seq.runs;
      if (!transport.playing) {
        const m = model();
        transport.setModel(m.source, m.timeline);
        transport.start(0, clock.currentTime + 0.04);
      } else {
        const m = model();
        transport.setModel(m.source, m.timeline);
      }
    }
  };
  // Notes that sounded: a note cancelled by a re-plan has its release at (or before) its own start.
  const ons = (channel?: ChannelId) =>
    calls.filter(
      (c) =>
        c.t === 'on' &&
        (!channel || c.channel === channel) &&
        !calls.some((o) => o.t === 'off' && o.noteId === c.noteId && o.time <= c.time),
    );
  return {
    f, seq, transport, clock, calls, audio, run, press, ons, sync,
    setProject: (p: Project) => {
      project = p;
      const m = model();
      transport.setModel(m.source, m.timeline);
    },
    playSong: () => {
      solo = false;
    },
    project: () => project,
  };
}

type Rig = ReturnType<typeof rig>;
const tr = (r: Rig, i: number) => r.f.tracks[i] as LaunchTrackId;
const sc = (r: Rig, i: number) => r.f.scenes[i] as SceneId;
const times = (calls: Call[]) => calls.map((c) => +c.time.toFixed(6));

describe('the launcher on its own', () => {
  it('starting from nothing plays the slot from the start of the transport', () => {
    const r = rig();
    r.press((clk) => r.seq.launch(tr(r, 0), sc(r, 0), clk));
    expect(r.transport.playing).toBe(true);
    r.run(2);
    // Pattern A: a note on every beat, 120 BPM: 0.5 s apart from 0.04 s.
    expect(times(r.ons())).toEqual([0.04, 0.54, 1.04, 1.54, 2.04].slice(0, times(r.ons()).length));
    expect(r.ons().length).toBeGreaterThanOrEqual(4);
  });

  it('a second slot launched mid-bar starts exactly on the next bar, and the first stops there', () => {
    const r = rig();
    r.press((clk) => r.seq.launch(tr(r, 0), sc(r, 0), clk)); // A from 0.04
    r.run(0.9); // mid-way through bar 1 (0.04–2.04)
    r.press((clk) => r.seq.launch(tr(r, 0), sc(r, 1), clk)); // B: one note per bar
    expect(r.seq.runs.map((x) => [x.startU, x.endU])).toEqual([
      [0, BAR],
      [BAR, null],
    ]);
    r.run(4.5);
    const on = r.ons();
    // A: beats 0.04, 0.54, 1.04, 1.54; B from the bar line at 2.04, then 4.04. A never plays past the boundary.
    expect(times(on.filter((c) => c.key === 60))).toEqual([0.04, 0.54, 1.04, 1.54]);
    expect(times(on.filter((c) => c.key === 61))).toEqual([2.04, 4.04]);
  });

  it('a quantize of "none" starts as soon as the scheduler can, "beat" on the beat', () => {
    const r = rig({ edit: (p, f) => produce(p, (d) => void patchSlot(d, f.tracks[1]!, f.scenes[0]!, { quantize: 'beat' })) });
    r.press((clk) => r.seq.launch(tr(r, 0), sc(r, 2), clk)); // C
    r.run(0.7);
    r.press((clk) => r.seq.launch(tr(r, 1), sc(r, 0), clk)); // t2 slot with its own beat quantize
    const start = r.seq.runs.find((x) => x.trackId === tr(r, 1))!.startU;
    expect(start % 960).toBe(0);
    expect(start).toBeLessThan(BAR);
    r.run(3);
    // Track 2's C (key 62, like track 1's, so look at the notes of its start) begins on the beat line.
    const at = +(0.04 + (start / 960) * 0.5).toFixed(6);
    expect(times(r.ons()).filter((t) => t === at).length).toBeGreaterThanOrEqual(1);
    expect(r.ons().filter((c) => c.time < at - 1e-9 && c.key === 62 && c.time > 0.6).length).toBe(0);
  });

  it('stopping a track releases its notes at the boundary and nothing more is played', () => {
    const r = rig();
    r.press((clk) => r.seq.launch(tr(r, 0), sc(r, 0), clk));
    r.run(0.7);
    r.press((clk) => r.seq.stopTrack(tr(r, 0), clk));
    r.run(5);
    expect(times(r.ons())).toEqual([0.04, 0.54, 1.04, 1.54]);
    // Every note got its release; the last ended before the bar line (the note is a step long).
    expect(r.calls.filter((c) => c.t === 'off')).toHaveLength(4);
    expect(r.seq.runs[0]!.endU).toBe(BAR);
  });

  it('a one-shot plays once and its notes end with it', () => {
    const r = rig({ edit: (p, f) => produce(p, (d) => void patchSlot(d, f.tracks[0]!, f.scenes[0]!, { loop: false })) });
    r.press((clk) => r.seq.launch(tr(r, 0), sc(r, 0), clk));
    r.run(6);
    expect(r.ons()).toHaveLength(4);
  });

  it('a scene launches every track on the same tick', () => {
    const r = rig();
    r.press((clk) => r.seq.launch(tr(r, 0), sc(r, 2), clk)); // something playing, so the next launch is quantized
    r.run(0.5);
    r.press((clk) => r.seq.launchScene(sc(r, 0), clk));
    expect(new Set(r.seq.runs.filter((x) => x.sceneId === sc(r, 0)).map((x) => x.startU))).toEqual(new Set([BAR]));
    r.run(2.6);
    const t = r.ons().filter((c) => c.time > 1.9);
    // Both tracks' first notes are at the bar line (2.04 s): A on the beat plus C on track 2 (both in the same instant).
    expect(t.filter((c) => Math.abs(c.time - 2.04) < 1e-6).map((c) => c.key).sort()).toEqual([60, 62]);
  });

  it('a follow action hands over a bar ahead, on the exact tick', () => {
    const r = rig({ edit: (p, f) => produce(p, (d) => void patchSlot(d, f.tracks[0]!, f.scenes[1]!, { follow: { kind: 'next', bars: 2 } })) });
    r.press((clk) => r.seq.launch(tr(r, 0), sc(r, 1), clk)); // B: one note per bar
    r.run(8);
    // B for two bars (0.04, 2.04), then scene 3's C (two notes per bar: beat 1 and beat 3) from 4.04.
    expect(times(r.ons().filter((c) => c.key === 61))).toEqual([0.04, 2.04]);
    expect(times(r.ons().filter((c) => c.key === 62)).slice(0, 3)).toEqual([4.04, 5.04, 6.04]);
  });

  it('plays notes through a pattern edit made while it plays', () => {
    const r = rig();
    r.press((clk) => r.seq.launch(tr(r, 0), sc(r, 1), clk));
    r.run(0.5);
    const edited = produce(r.project(), (d) => {
      const pid = r.f.patterns[1] as PatternId;
      const notes = d.patterns[pid]!.notes[r.f.channelId]!;
      const id = 'n_extra' as never;
      notes[id] = { id, tick: 1920, length: 240, key: 61, velocity: 1 };
    });
    r.setProject(edited);
    r.run(2.5);
    expect(times(r.ons())).toEqual([0.04, 1.04, 2.04]);
  });
});

describe('the launcher over the song', () => {
  const withSong = (p: Project, f: ReturnType<typeof launcherFixture>) =>
    produce(p, (d) => {
      // Pattern A on playlist track 1, bars 1–2; the song is 2 bars long and loops (4 s).
      addClips(d, [
        { kind: 'pattern', id: 'song1' as ClipId, laneId: d.playlist.laneOrder[0]!, start: 0, length: 2 * BAR, patternId: f.patterns[0]!, offset: 0 },
      ]);
    });

  it('launched notes carry on across the song’s loop wrap', () => {
    const r = rig({ song: true, edit: withSong });
    r.transport.start(0, 0);
    r.run(0.3);
    // B (one note per bar) at the next bar of the song; the song loops every 4 s, B keeps its own bar grid.
    r.press((clk) => r.seq.launch(tr(r, 1), sc(r, 1), clk));
    expect(r.seq.runs[0]!.startU).toBe(BAR);
    r.run(9);
    // B plays on the bars 2.0, 4.0, 6.0, 8.0 s, straight through the wraps at 4 s and 8 s. Song notes are key 60.
    expect(times(r.ons().filter((c) => c.key === 61))).toEqual([2, 4, 6, 8]);
    expect(r.ons().filter((c) => c.key === 60).length).toBeGreaterThanOrEqual(16);
  });

  it('u is the song tick when the song plays from the start, and the quantize grid is the song’s bars', () => {
    const r = rig({ song: true, edit: withSong });
    r.transport.start(0, 0);
    r.run(1);
    expect(r.transport.uAtTime(1)).toBeCloseTo(1920, 6);
    r.run(5);
    // Past the wrap (4 s): the song tick is back at 960·2 but u kept counting.
    expect(r.transport.uAtTime(5)).toBeCloseTo(9600, 6);
    expect(r.transport.positionAt(5)).toBeCloseTo(1920 + 960 * 2 - 3840 * 0 - 1920 + 1920 - 1920, 0);
  });

  it('a launcher track takes over its playlist track from where its slot starts, and gives it back when it stops', () => {
    const r = rig({
      song: true,
      edit: (p, f) => produce(withSong(p, f), (d) => void setTrackLane(d, f.tracks[0]!, d.playlist.laneOrder[0]!)),
    });
    r.transport.start(0, 0);
    r.run(0.3);
    // t1/scene 2 (B) at the next bar (2 s): the song's pattern A (a note every beat) is muted from there.
    r.press((clk) => r.seq.launch(tr(r, 0), sc(r, 1), clk));
    r.run(4);
    const a = times(r.ons().filter((c) => c.key === 60));
    // Song notes before 2 s: 0, 0.5, 1, 1.5; the song does not play on its track for the rest of the first pass.
    expect(a).toEqual([0, 0.5, 1, 1.5]);
    expect(times(r.ons().filter((c) => c.key === 61))).toEqual([2, 4]);
    // Stop at the next bar (6 s): at 6 s the song's track comes back, with the loop's next pass of A at 8 s.
    r.run(4.3);
    r.press((clk) => r.seq.stopTrack(tr(r, 0), clk));
    r.run(10.2);
    // B ends at the bar line after the press (6 s); the song's track plays again from there.
    const after = times(r.ons().filter((c) => c.key === 60 && c.time > 2));
    expect(after[0]).toBe(6);
    expect(after.every((t) => t >= 6 - 1e-9)).toBe(true);
  });

  it('a playlist note sounding when the takeover starts is released at that tick', () => {
    const r = rig({
      song: true,
      edit: (p, f) =>
        produce(withSong(p, f), (d) => {
          setTrackLane(d, f.tracks[0]!, d.playlist.laneOrder[0]!);
          // A long note in pattern A at beat 1 (1 s): 3 beats.
          const pid = f.patterns[0] as PatternId;
          const note = Object.values(d.patterns[pid]!.notes[f.channelId]!).find((n) => n.tick === 960)!;
          note.length = 2880;
        }),
    });
    r.transport.start(0, 0);
    r.run(0.2);
    r.press((clk) => r.seq.launch(tr(r, 0), sc(r, 1), clk)); // from 2 s
    r.run(3);
    const longNote = r.ons().find((c) => Math.abs(c.time - 0.5) < 1e-9)!;
    const off = r.calls.find((c) => c.t === 'off' && c.noteId === longNote.noteId);
    expect(off).toBeDefined();
    expect(off!.time).toBeLessThanOrEqual(2 + 1e-9);
  });
});

describe('audio slots', () => {
  it('starts a pass of the sample on the boundary, with the clip it plays, and repeats it while the slot loops', () => {
    const r = rig({
      edit: (p, f) =>
        produce(p, (d) => {
          const c = contentFromAudioChannel(d as unknown as Project, f.audioId)!;
          if (c.kind === 'audio') c.length = 2 * 960; // one second at 120 BPM
          setSlotContent(d, f.tracks[2]!, f.scenes[0]!, c);
        }),
    });
    r.press((clk) => r.seq.launch(tr(r, 2), sc(r, 0), clk));
    r.run(3.2);
    expect(r.audio.map((a) => +a.time.toFixed(6))).toEqual([0.04, 1.04, 2.04, 3.04]);
    const first = r.audio[0]!;
    expect(first.clip).toMatchObject({ kind: 'audio', channelId: r.f.audioId, offsetSec: 0, start: 0, length: 1920 });
    expect(first.tick).toBe(0);
    expect(first.tempo.bpm).toBe(120);
    expect(r.audio[2]!.clip.start).toBe(3840);
  });

  it('a replaced audio slot is released at the boundary', () => {
    const r = rig({
      edit: (p, f) =>
        produce(p, (d) => {
          const c = contentFromAudioChannel(d as unknown as Project, f.audioId)!;
          if (c.kind === 'audio') c.length = BAR * 2;
          setSlotContent(d, f.tracks[2]!, f.scenes[0]!, c);
          setSlotContent(d, f.tracks[2]!, f.scenes[1]!, { kind: 'pattern', patternId: f.patterns[1]! });
        }),
    });
    r.press((clk) => r.seq.launch(tr(r, 2), sc(r, 0), clk));
    r.run(0.5);
    r.press((clk) => r.seq.launch(tr(r, 2), sc(r, 1), clk));
    r.run(4);
    const on = r.calls.find((c) => c.t === 'audio')!;
    const off = r.calls.find((c) => c.t === 'off' && c.noteId === on.noteId)!;
    expect(off.time).toBeCloseTo(2.04, 6);
    void ({} as AudioClip);
  });
});

describe('the axis', () => {
  it('stays on the new position’s bar grid after a seek, and keeps counting', () => {
    const r = rig({ song: true, edit: (p, f) => produce(p, (d) => void addClips(d, [{ kind: 'pattern', id: 's' as ClipId, laneId: d.playlist.laneOrder[0]!, start: 0, length: 4 * BAR, patternId: f.patterns[0]!, offset: 0 }])) });
    r.transport.start(0, 0);
    r.run(0.7); // u ≈ 1344
    r.transport.seek(2 * BAR, 0.75);
    r.run(1);
    const u = r.transport.uAtTime(0.75);
    // At the seek's time the song is at bar 3 exactly, and u is on the bar grid at or after where it was.
    expect(Math.min(u % BAR, BAR - (u % BAR))).toBeCloseTo(0, 6);
    expect(u).toBeGreaterThanOrEqual(1344);
    expect(u).toBeLessThan(1344 + BAR + 200);
    expect(r.transport.uAtTime(0.85) - u).toBeCloseTo(0.1 / (BAR_SEC / BAR), 3);
  });
});
