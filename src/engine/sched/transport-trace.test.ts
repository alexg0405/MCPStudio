/**
 * A characterization test for the lookahead transport: 60 seeded random sessions (start, seek, stop, launches, scene
 * launches, edits, tempo, loop and mode changes, pumps to odd horizons) on the real planner with a fake clock, each
 * reduced to a hash of everything the transport sent to its sink and its observers plus every position query after each
 * step. The hashes were taken before the transport was split into plan-state, positions and replan, so any change in
 * what it plays, when, or what it answers shows up here.
 */
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { LaunchSequencer } from '@core/launcher/sequencer';
import { LAUNCH_GRACE_SEC, type LaunchClock } from '@core/launcher/run';
import { launcherFixture } from '@core/launcher/test-project';
import type { ChannelId, ClipId, LaunchTrackId, NoteId, Project, SceneId } from '@core/model/types';
import { contentFromAudioChannel, setSlotContent, setTrackLane } from '@core/ops/launcher';
import { addClips } from '@core/ops/playlist';
import { constantTempo, type TempoMap } from '@core/time/ppq';
import { steppedTempo } from '@core/time/tempo';
import { songModeSource, patternModeSource, type EventSource } from './events';
import { Transport, type TransportSink } from './transport';

const BAR = 3840;

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const FIXTURE = launcherFixture();

/** One seeded session: the trace of everything the transport said and answered. */
function scenario(seed: number): unknown[] {
  const rnd = prng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const f = FIXTURE;
  let project: Project = produce(f.project, (d) => {
    d.transport.bpm = 120;
    addClips(d, [
      { kind: 'pattern', id: 's1' as ClipId, laneId: d.playlist.laneOrder[0]!, start: 0, length: 2 * BAR, patternId: f.patterns[0]!, offset: 0 },
      { kind: 'pattern', id: 's2' as ClipId, laneId: d.playlist.laneOrder[1]!, start: BAR, length: 3 * BAR, patternId: f.patterns[2]!, offset: 0 },
    ]);
    const c = contentFromAudioChannel(d as unknown as Project, f.audioId);
    if (c) setSlotContent(d, f.tracks[2]!, f.scenes[0]!, c);
    if (rnd() < 0.5) setTrackLane(d, f.tracks[0]!, d.playlist.laneOrder[0]!);
  });
  const tempos: TempoMap[] = [
    constantTempo(120),
    steppedTempo([{ tick: 0, bpm: 120 }, { tick: BAR, bpm: 240 }]),
    steppedTempo([{ tick: 0, bpm: 90 }, { tick: 2 * BAR, bpm: 150 }]),
  ];
  let tempo = pick(tempos);
  let mode: 'solo' | 'song' | 'pattern' = pick(['solo', 'song', 'pattern'] as const);
  let loop: { start: number; end: number } | null = rnd() < 0.5 ? null : { start: BAR, end: 3 * BAR };
  const trace: unknown[] = [];
  const nameOf = (id: ChannelId) => (id === f.channelId ? 'synth' : id === f.audioId ? 'audio' : 'other');
  const clock = { currentTime: 0 };
  const sink: TransportSink = {
    noteOn: (c, e) => trace.push(['on', nameOf(c), e.time, e.noteId, e.key, e.velocity, e.pan ?? null, e.offset ?? null]),
    noteOff: (c, e) => trace.push(['off', nameOf(c), e.time, e.noteId, e.key, e.release ?? null]),
    allNotesOff: (time) => trace.push(['all', time]),
    audioOn: (c, e) => trace.push(['audio', nameOf(c), e.time, e.noteId, e.key, e.tick, e.tempo.secondsPerTick(e.tick), e.tempo.secondsPerTick(e.tick + 5000)]),
  };
  const seq = new LaunchSequencer({ project: () => project, random: () => 0 });
  const model = () => {
    const launch = { launch: { runs: seq.runs } };
    if (mode === 'solo')
      return { source: { project, clips: [], ...launch } as EventSource, timeline: { tempo, loop: null, endTick: Number.MAX_SAFE_INTEGER } };
    if (mode === 'pattern') {
      const { source, length } = patternModeSource(project, f.patterns[0]!);
      return { source: { ...source, ...launch } as EventSource, timeline: { tempo, loop: { start: 0, end: length }, endTick: length } };
    }
    const { source, length } = songModeSource(project);
    const end = Math.max(length, BAR);
    return {
      source: { ...source, ...launch } as EventSource,
      timeline: { tempo, loop: loop ?? { start: 0, end }, endTick: end },
    };
  };
  const m0 = model();
  const transport = new Transport(clock, sink, m0.source, m0.timeline);
  const observer = {
    started: (tick: number, time: number) => trace.push(['started', tick, time]),
    segment: (seg: { tick0: number; tick1: number; time0: number; iter: number }, wrapped: boolean) =>
      trace.push(['segment', seg.tick0, seg.tick1, seg.time0, seg.iter, wrapped]),
    reanchored: (time: number, changed: boolean) => trace.push(['reanchored', time, changed]),
    seeked: (tick: number, time: number) => trace.push(['seeked', tick, time]),
    stopped: (time: number) => trace.push(['stopped', time]),
  };
  transport.observe(observer);
  transport.onEnded = () => trace.push(['ended', clock.currentTime]);
  let seen = seq.runs;
  const clockOf = (): LaunchClock =>
    transport.playing
      ? {
          playing: true,
          heardU: transport.uAtTime(clock.currentTime),
          earliestU: transport.uAtTime(clock.currentTime + 0.03),
          lateU: transport.uAtTime(clock.currentTime - LAUNCH_GRACE_SEC),
        }
      : { playing: false, heardU: 0, earliestU: 0 };
  const replan = () => {
    const m = model();
    transport.setModel(m.source, m.timeline);
  };
  const sync = () => {
    seq.advance(clockOf());
    if (seq.runs !== seen) {
      seen = seq.runs;
      replan();
    }
  };
  const queries = () => {
    const t = clock.currentTime;
    const probes = [t - 1, t - 0.01, t, t + 0.05, t + 0.5, t + 3];
    trace.push([
      'q',
      transport.playing,
      transport.lateEvents,
      transport.pendingNotes,
      transport.currentTimeline.endTick,
      probes.map((p) => [transport.tickAt(p), transport.sptAt(p), transport.positionAt(p), transport.uAtTime(p), transport.iterationAt(p)]),
      [0, 1000, 5000, 9000, 20000].map((u) => [transport.tickAtU(u), transport.launchTempo(u, u + 3840).secondsPerTick(u + 100)]),
    ]);
  };
  const run = (seconds: number) => {
    const until = clock.currentTime + seconds;
    while (clock.currentTime < until - 1e-9) {
      clock.currentTime = Math.min(until, clock.currentTime + 0.025);
      sync();
      transport.pump();
    }
  };
  const tracks = f.tracks as LaunchTrackId[];
  const scenes = f.scenes as SceneId[];
  for (let step = 0; step < 40; step++) {
    const action = pick(['run', 'run', 'run', 'launch', 'launch', 'scene', 'stopTrack', 'stopAll', 'seek', 'start', 'stop', 'tempo', 'loop', 'mode', 'edit', 'horizon', 'release'] as const);
    trace.push(['do', action, clock.currentTime]);
    switch (action) {
      case 'run':
        run(rnd() * 1.5);
        break;
      case 'launch': {
        seq.launch(pick(tracks.slice(0, 3)), pick(scenes.slice(0, 3)), clockOf());
        if (seq.runs !== seen) {
          seen = seq.runs;
          replan();
          if (!transport.playing) transport.start(0, clock.currentTime + 0.04);
        }
        break;
      }
      case 'scene':
        seq.launchScene(pick(scenes.slice(0, 3)), clockOf());
        if (seq.runs !== seen) {
          seen = seq.runs;
          replan();
          if (!transport.playing) transport.start(0, clock.currentTime + 0.04);
        }
        break;
      case 'stopTrack':
        seq.stopTrack(pick(tracks.slice(0, 3)), clockOf(), rnd() < 0.3);
        sync();
        break;
      case 'stopAll':
        seq.stopAll(clockOf(), rnd() < 0.3);
        sync();
        break;
      case 'seek':
        transport.seek(Math.floor(rnd() * 4 * BAR), clock.currentTime + 0.04);
        break;
      case 'start':
        transport.start(Math.floor(rnd() * 2 * BAR), clock.currentTime + rnd() * 0.1);
        break;
      case 'stop':
        transport.stop(Math.floor(rnd() * BAR));
        break;
      case 'tempo':
        tempo = pick(tempos);
        replan();
        break;
      case 'loop':
        loop = rnd() < 0.3 ? null : { start: Math.floor(rnd() * 2) * BAR, end: (2 + Math.floor(rnd() * 3)) * BAR };
        replan();
        break;
      case 'mode':
        mode = pick(['solo', 'song', 'pattern'] as const);
        replan();
        break;
      case 'edit': {
        const pat = pick(f.patterns);
        const ch = f.channelId as ChannelId;
        project = produce(project, (d) => {
          const notes = d.patterns[pat]!.notes[ch] ?? ((d.patterns[pat]!.notes[ch] = {} as never), d.patterns[pat]!.notes[ch]!);
          const ids = Object.keys(notes) as NoteId[];
          if (ids.length > 0 && rnd() < 0.5) delete notes[pick(ids)];
          else {
            const id = ('n_' + Math.floor(rnd() * 1e6)) as NoteId;
            notes[id] = { id, tick: Math.floor(rnd() * 16) * 240, length: 240 * (1 + Math.floor(rnd() * 4)), key: 60 + Math.floor(rnd() * 5), velocity: 0.8 } as never;
          }
        });
        replan();
        break;
      }
      case 'horizon':
        transport.pump(clock.currentTime + rnd() * 2);
        break;
      case 'release':
        transport.releaseHeld(clock.currentTime + 0.1);
        break;
    }
    queries();
  }
  transport.stop();
  queries();
  return trace;
}

/** A 32-bit FNV-1a hash of a string (enough to tell two traces apart; the hashes below are of the JSON text). */
function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const SEEDS = 60;
/** One hash per seed, taken with the transport as it was before the split. */
const EXPECTED: string[] = [
  '04e4fa32',
  '66088db9',
  'a74fb135',
  '382ece35',
  'cf048226',
  '9a3f679d',
  '669a6d7f',
  'da9abaab',
  '37076e2b',
  '760ea100',
  '465dfcc0',
  '993a8e1c',
  '5fad4eec',
  'c14c87b4',
  'ffcec5db',
  'd96cacda',
  '5d66979f',
  '40070ee2',
  '527d6560',
  'b5a1d720',
  '860d16d3',
  'b62e7be8',
  '3cb6b602',
  '87cbea71',
  '0bb817ab',
  'd3ea008a',
  'fc0b7732',
  '564f1db9',
  '68f61656',
  '43322752',
  '8c931e89',
  '7312d058',
  'e0061508',
  '1d6ed8f5',
  '34ffad95',
  'c127b3dd',
  'e133b8b8',
  'a257e924',
  '9b3531bc',
  '6a3b4d99',
  '91744af6',
  '57fd2eba',
  '4f603faa',
  '58e86c86',
  '8b3b5fd9',
  '637716e3',
  'ce55a12c',
  'c6a1a7cc',
  '34dc299a',
  '2847a030',
  '5712bbb2',
  '0b8a1bec',
  '786d874e',
  '569899a3',
  'd6a2e5fb',
  'ba3dc6b3',
  '2c9e85e8',
  '129b510e',
  'cd4212c3',
  '848e61d9',
];

describe('the transport on seeded random sessions', () => {
  it('sends and answers exactly what it did before it was split', () => {
    const hashes: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) hashes.push(fnv(JSON.stringify(scenario(seed))));
    expect(hashes).toEqual(EXPECTED);
  });
});
