import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createEmptyProject } from '../model/defaults';
import { newId } from '../model/ids';
import type { AudioClip, LaneId, LaunchTrackId, Project } from '../model/types';
import { removeChannel } from '../ops/channels';
import {
  addLaunchTrack,
  addScene,
  clearSlot,
  contentFromAudioChannel,
  contentFromAudioClip,
  ensureCapacity,
  ensureLauncher,
  moveSlot,
  patchSlot,
  patternContent,
  removeLaunchTrack,
  removeScene,
  renameScene,
  setLauncherQuantize,
  setSlotContent,
  setTrackLane,
} from '../ops/launcher';
import { removeLane, removePattern } from '../ops/playlist';
import { migrateProject, repairProject } from '../schema/migrate';
import { filledSlots, slotAt, slotLabel } from './grid';
import { writePerformance } from './perform';
import type { PerformanceTake } from './sequencer';
import { launcherFixture } from './test-project';

const BAR = 3840;
/** Parsed project JSON, poked at by the repair tests. */
type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('the grid', () => {
  it('is made 8 tracks by 8 scenes the first time it is needed, and grows on demand', () => {
    let p = createEmptyProject();
    p = produce(p, (d) => void ensureLauncher(d));
    expect(p.launcher!.trackOrder).toHaveLength(8);
    expect(p.launcher!.sceneOrder).toHaveLength(8);
    expect(p.launcher!.quantize).toBe('bar');
    p = produce(p, (d) => void ensureCapacity(d, 10, 9));
    expect([p.launcher!.trackOrder.length, p.launcher!.sceneOrder.length]).toEqual([10, 9]);
    expect(p.launcher!.tracks[p.launcher!.trackOrder[9]!]!.name).toBe('Track 10');
    expect(p.launcher!.scenes[p.launcher!.sceneOrder[8]!]!.name).toBe('Scene 9');
  });

  it('holds slots that point at patterns and audio channels, never copies', () => {
    const f = launcherFixture();
    const l = f.project.launcher!;
    expect(filledSlots(l).map((s) => [s.track, s.scene])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [0, 2],
    ]);
    expect(slotAt(l, 0, 0)!.content).toEqual({ kind: 'pattern', patternId: f.patterns[0] });
    expect(slotLabel(f.project, slotAt(l, 0, 1)!)).toBe('Pattern B');
    expect(slotAt(l, 7, 7)).toBeUndefined();
  });

  it('keeps a slot’s settings when its content is replaced, and clears name and colour', () => {
    const f = launcherFixture();
    const [t1] = f.tracks;
    const [s1] = f.scenes;
    const p = produce(f.project, (d) => {
      patchSlot(d, t1!, s1!, { mode: 'toggle', loop: false, quantize: 'beat', name: 'Drums', color: '#aabbcc', follow: { kind: 'next', bars: 4 } });
      setSlotContent(d, t1!, s1!, patternContent(f.patterns[1]!));
    });
    expect(slotAt(p.launcher, 0, 0)).toEqual({
      content: { kind: 'pattern', patternId: f.patterns[1] },
      mode: 'toggle',
      loop: false,
      quantize: 'beat',
      follow: { kind: 'next', bars: 4 },
    });
  });

  it('sets, clamps and resets a slot’s settings', () => {
    const f = launcherFixture();
    const [t1] = f.tracks;
    const [s1] = f.scenes;
    let p = produce(f.project, (d) => {
      patchSlot(d, t1!, s1!, { mode: 'gate', loop: false, follow: { kind: 'random', bars: 1000 }, name: '  x'.repeat(40) });
    });
    const slot = slotAt(p.launcher, 0, 0)!;
    expect(slot.mode).toBe('gate');
    expect(slot.loop).toBe(false);
    expect(slot.follow).toEqual({ kind: 'random', bars: 64 });
    expect(slot.name!.length).toBeLessThanOrEqual(64);
    p = produce(p, (d) => void patchSlot(d, t1!, s1!, { mode: null, loop: null, follow: null, name: null, quantize: 'none' }));
    expect(slotAt(p.launcher, 0, 0)).toEqual({ content: slot.content, quantize: 'none' });
    // Trigger and looping are the defaults: they are stored as nothing.
    p = produce(p, (d) => void patchSlot(d, t1!, s1!, { mode: 'trigger', loop: true }));
    expect(slotAt(p.launcher, 0, 0)).toEqual({ content: slot.content, quantize: 'none' });
  });

  it('names scenes, sets the default quantize, links a track to a playlist track', () => {
    const f = launcherFixture();
    const lane = f.project.playlist.laneOrder[2]!;
    const p = produce(f.project, (d) => {
      renameScene(d, f.scenes[0]!, 'Intro');
      setLauncherQuantize(d, '2bars');
      setTrackLane(d, f.tracks[0]!, lane);
    });
    expect(p.launcher!.scenes[f.scenes[0]!]!.name).toBe('Intro');
    expect(p.launcher!.quantize).toBe('2bars');
    expect(p.launcher!.tracks[f.tracks[0]!]!.laneId).toBe(lane);
    const q = produce(p, (d) => void setTrackLane(d, f.tracks[0]!, null));
    expect(q.launcher!.tracks[f.tracks[0]!]!.laneId).toBeUndefined();
    const bad = produce(p, (d) => void setTrackLane(d, f.tracks[0]!, 'lane_nope' as LaneId));
    expect(bad.launcher!.tracks[f.tracks[0]!]!.laneId).toBeUndefined();
  });

  it('moves, swaps and copies slots', () => {
    const f = launcherFixture();
    const [t1, t2] = f.tracks as [LaunchTrackId, LaunchTrackId];
    const [s1, s2, s3] = f.scenes;
    // t1/s3 (C) to the empty t2/s3.
    let p = produce(f.project, (d) => void moveSlot(d, { trackId: t1, sceneId: s3! }, { trackId: t2, sceneId: s3! }));
    expect(p.launcher!.tracks[t1]!.slots[s3!]).toBeUndefined();
    expect(p.launcher!.tracks[t2]!.slots[s3!]!.content).toEqual(patternContent(f.patterns[2]!));
    // Swap t1/s1 (A) with t1/s2 (B).
    p = produce(p, (d) => void moveSlot(d, { trackId: t1, sceneId: s1! }, { trackId: t1, sceneId: s2! }));
    expect(p.launcher!.tracks[t1]!.slots[s1!]!.content).toEqual(patternContent(f.patterns[1]!));
    expect(p.launcher!.tracks[t1]!.slots[s2!]!.content).toEqual(patternContent(f.patterns[0]!));
    // A copy leaves the original.
    p = produce(p, (d) => void moveSlot(d, { trackId: t1, sceneId: s2! }, { trackId: t2, sceneId: s2! }, true));
    expect(p.launcher!.tracks[t1]!.slots[s2!]).toBeDefined();
    expect(p.launcher!.tracks[t2]!.slots[s2!]!.content).toEqual(patternContent(f.patterns[0]!));
  });

  it('adds and removes tracks and scenes (a scene takes its slots with it)', () => {
    const f = launcherFixture();
    let p = produce(f.project, (d) => {
      addLaunchTrack(d, 'Bass');
      addScene(d, 'Outro');
    });
    expect(p.launcher!.trackOrder).toHaveLength(9);
    expect(p.launcher!.tracks[p.launcher!.trackOrder[8]!]!.name).toBe('Bass');
    expect(p.launcher!.scenes[p.launcher!.sceneOrder[8]!]!.name).toBe('Outro');
    p = produce(p, (d) => {
      removeScene(d, f.scenes[0]!);
      removeLaunchTrack(d, f.tracks[1]!);
    });
    expect(filledSlots(p.launcher).map((s) => [s.track, s.scene])).toEqual([
      [0, 0],
      [0, 1],
    ]);
    p = produce(p, (d) => void clearSlot(d, f.tracks[0]!, f.scenes[1]!));
    expect(filledSlots(p.launcher)).toHaveLength(1);
  });
});

describe('what a slot plays disappears with it', () => {
  it('deleting a pattern, a channel or a playlist track tidies the grid in the same edit', () => {
    const f = launcherFixture();
    const lane = f.project.playlist.laneOrder[1]!;
    let p = produce(f.project, (d) => void setTrackLane(d, f.tracks[0]!, lane));
    p = produce(p, (d) => void removePattern(d, f.patterns[2]!));
    expect(filledSlots(p.launcher).map((s) => [s.track, s.scene])).toEqual([
      [0, 0],
      [0, 1],
      [1, 1],
    ]);
    expect(p.launcher!.tracks[f.tracks[0]!]!.slots[f.scenes[2]!]).toBeUndefined();
    expect(p.launcher!.tracks[f.tracks[1]!]!.slots[f.scenes[0]!]).toBeUndefined();
    expect(p.launcher!.tracks[f.tracks[1]!]!.slots[f.scenes[1]!]).toBeDefined();
    p = produce(p, (d) => void removeLane(d, lane));
    expect(p.launcher!.tracks[f.tracks[0]!]!.laneId).toBeUndefined();
    const withAudio = produce(f.project, (d) => {
      const c = contentFromAudioChannel(d as unknown as Project, f.audioId)!;
      setSlotContent(d, f.tracks[0]!, f.scenes[3]!, c);
    });
    expect(slotAt(withAudio.launcher, 0, 3)!.content.kind).toBe('audio');
    const gone = produce(withAudio, (d) => void removeChannel(d, f.audioId));
    expect(slotAt(gone.launcher, 0, 3)).toBeUndefined();
  });
});

describe('audio content', () => {
  it('takes a playlist audio clip’s sample, trim, gain and fades without copying audio', () => {
    const f = launcherFixture();
    const clip: AudioClip = {
      id: newId.clip(),
      kind: 'audio',
      laneId: f.project.playlist.laneOrder[0]!,
      start: 0,
      length: BAR * 2,
      channelId: f.audioId,
      offsetSec: 0.5,
      gain: 1.5,
      fadeIn: 0.01,
    };
    expect(contentFromAudioClip(clip)).toEqual({ kind: 'audio', channelId: f.audioId, offsetSec: 0.5, length: BAR * 2, gain: 1.5, fadeIn: 0.01 });
  });

  it('makes a whole channel’s content from its sample length at the song tempo', () => {
    const f = launcherFixture();
    // 2 s at 130 BPM = 4.33 beats.
    const c = contentFromAudioChannel(f.project, f.audioId)!;
    expect(c).toMatchObject({ kind: 'audio', channelId: f.audioId, offsetSec: 0 });
    expect(c.kind === 'audio' && c.length).toBe(Math.round((2 * 130 * 960) / 60));
    expect(contentFromAudioChannel(f.project, f.channelId)).toBeNull();
  });
});

describe('repair and migration', () => {
  const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

  it('a project with a launcher round-trips through migrate and repair untouched', () => {
    const f = launcherFixture();
    const { project } = migrateProject(clone(f.project));
    const r = repairProject(project);
    expect(r.repairs).toEqual([]);
    expect(r.project.launcher).toEqual(f.project.launcher);
  });

  it('a project without one stays without (old projects open as they were)', () => {
    const { project } = migrateProject(clone(createEmptyProject()));
    expect(repairProject(project).project.launcher).toBeUndefined();
  });

  it('drops slots whose pattern or channel is gone, and track links to deleted playlist tracks', () => {
    const f = launcherFixture();
    const raw = clone(f.project) as unknown as Raw;
    delete raw.patterns[f.patterns[2]!];
    raw.patternOrder = raw.patternOrder.filter((id: string) => id !== f.patterns[2]);
    raw.launcher.tracks[f.tracks[0]!].laneId = 'lane_nope';
    const { project, repairs } = repairProject(migrateProject(raw).project);
    expect(project.launcher!.tracks[f.tracks[0]!]!.slots[f.scenes[2]!]).toBeUndefined();
    expect(project.launcher!.tracks[f.tracks[0]!]!.laneId).toBeUndefined();
    expect(project.launcher!.tracks[f.tracks[0]!]!.slots[f.scenes[0]!]).toBeDefined();
    expect(repairs.join(' ')).toMatch(/clip launcher/i);
    expect(repairProject(project).repairs).toEqual([]);
  });

  it('puts the order arrays right and resets broken settings', () => {
    const f = launcherFixture();
    const raw = clone(f.project) as unknown as Raw;
    raw.launcher.trackOrder = [f.tracks[1], 'ghost', f.tracks[1]];
    raw.launcher.quantize = 'whenever';
    raw.launcher.tracks[f.tracks[0]!].slots[f.scenes[0]!].mode = 'warp';
    raw.launcher.tracks[f.tracks[0]!].slots[f.scenes[0]!].follow = { kind: 'next', bars: 0 };
    raw.launcher.tracks[f.tracks[0]!].slots[f.scenes[0]!].loop = 'yes';
    const { project } = repairProject(migrateProject(raw).project);
    expect(project.launcher!.quantize).toBe('bar');
    expect(project.launcher!.trackOrder.slice(0, 2)).toEqual([f.tracks[1], f.tracks[0]]);
    expect(new Set(project.launcher!.trackOrder).size).toBe(project.launcher!.trackOrder.length);
    const slot = project.launcher!.tracks[f.tracks[0]!]!.slots[f.scenes[0]!]!;
    expect(slot.mode).toBeUndefined();
    expect(slot.follow).toBeUndefined();
    expect(slot.loop).toBeUndefined();
  });

  it('forgets a launcher that cannot be read', () => {
    const f = launcherFixture();
    const raw = clone(f.project) as unknown as Raw;
    raw.launcher = { tracks: 3 };
    const { project, repairs } = repairProject(migrateProject(raw).project);
    expect(project.launcher).toBeUndefined();
    expect(repairs.join(' ')).toMatch(/clip launcher/i);
  });
});

describe('record performance to the playlist', () => {
  const take = (f: ReturnType<typeof launcherFixture>, entries: PerformanceTake['entries']): PerformanceTake => ({
    startU: Math.min(...entries.map((e) => e.startU)),
    endU: Math.max(...entries.map((e) => e.endU)),
    entries,
  });

  it('writes pattern runs as clips at the times they played, on a new track each, in one edit', () => {
    const f = launcherFixture();
    const [t1, t2] = f.tracks as [LaunchTrackId, LaunchTrackId];
    const [s1, s2] = f.scenes;
    const entries: PerformanceTake['entries'] = [
      { trackId: t1, sceneId: s1!, content: patternContent(f.patterns[0]!), loop: true, passLength: BAR, startU: BAR * 2, endU: BAR * 4, phase: 0, name: 'Pattern A', color: '#111111' },
      { trackId: t1, sceneId: s2!, content: patternContent(f.patterns[1]!), loop: true, passLength: BAR, startU: BAR * 4, endU: BAR * 5, phase: 0, name: 'Pattern B', color: '#222222' },
      { trackId: t2, sceneId: s1!, content: patternContent(f.patterns[2]!), loop: true, passLength: BAR, startU: BAR * 3, endU: BAR * 5, phase: 960, name: 'Pattern C', color: '#333333' },
    ];
    const before = Object.keys(f.project.playlist.clips).length;
    let written: ReturnType<typeof writePerformance> | undefined;
    const p = produce(f.project, (d) => {
      written = writePerformance(d, take(f, entries));
    });
    const clips = Object.values(p.playlist.clips);
    expect(clips).toHaveLength(before + 3);
    expect(written!.clips).toHaveLength(3);
    expect(written!.lanes).toHaveLength(2);
    expect([written!.from, written!.to]).toEqual([BAR * 2, BAR * 5]);
    const byName = Object.fromEntries(clips.map((c) => [c.name, c]));
    expect(byName['Pattern A']).toMatchObject({ kind: 'pattern', patternId: f.patterns[0], start: BAR * 2, length: BAR * 2, offset: 0 });
    expect(byName['Pattern B']).toMatchObject({ start: BAR * 4, length: BAR });
    expect(byName['Pattern C']).toMatchObject({ start: BAR * 3, length: BAR * 2, offset: 960 });
    // A and B shared a launcher track: one playlist track; C is on another; both are new and named for the launcher track.
    expect(byName['Pattern A']!.laneId).toBe(byName['Pattern B']!.laneId);
    expect(byName['Pattern A']!.laneId).not.toBe(byName['Pattern C']!.laneId);
    expect(p.playlist.lanes[byName['Pattern A']!.laneId]!.name).toBe('Jam · Track 1');
    expect(p.playlist.laneOrder).toHaveLength(f.project.playlist.laneOrder.length + 2);
  });

  it('uses the playlist track a launcher track is linked to when it is free there, else a new one', () => {
    const f = launcherFixture();
    const lane = f.project.playlist.laneOrder[3]!;
    const linked = produce(f.project, (d) => void setTrackLane(d, f.tracks[0]!, lane));
    const entry = (start: number, end: number): PerformanceTake['entries'][number] => ({
      trackId: f.tracks[0]!, sceneId: f.scenes[0]!, content: patternContent(f.patterns[0]!), loop: true, passLength: BAR, startU: start, endU: end, phase: 0, name: 'A', color: '#000000',
    });
    const free = produce(linked, (d) => void writePerformance(d, take(f, [entry(0, BAR)])));
    expect(Object.values(free.playlist.clips)[0]!.laneId).toBe(lane);
    const busy = produce(free, (d) => void writePerformance(d, take(f, [entry(0, BAR)])));
    const lanes = new Set(Object.values(busy.playlist.clips).map((c) => c.laneId));
    expect(lanes.size).toBe(2);
    expect(busy.playlist.laneOrder).toHaveLength(linked.playlist.laneOrder.length + 1);
  });

  it('writes a looping audio run as one clip per pass, the last cut short', () => {
    const f = launcherFixture();
    const content = contentFromAudioChannel(f.project, f.audioId)!;
    if (content.kind !== 'audio') throw new Error('audio');
    const pass = content.length;
    const e: PerformanceTake['entries'][number] = {
      trackId: f.tracks[0]!, sceneId: f.scenes[0]!, content, loop: true, passLength: pass, startU: BAR, endU: BAR + pass * 2 + 500, phase: 0, name: 'Loop', color: '#444444',
    };
    const p = produce(f.project, (d) => void writePerformance(d, take(f, [e])));
    const clips = Object.values(p.playlist.clips).sort((a, b) => a.start - b.start);
    expect(clips.map((c) => [c.kind, c.start, c.length])).toEqual([
      ['audio', BAR, pass],
      ['audio', BAR + pass, pass],
      ['audio', BAR + pass * 2, 500],
    ]);
    expect((clips[0] as AudioClip).channelId).toBe(f.audioId);
  });

  it('a run that was already playing when the record began keeps its place in the content', () => {
    const f = launcherFixture();
    const e: PerformanceTake['entries'][number] = {
      trackId: f.tracks[0]!, sceneId: f.scenes[0]!, content: patternContent(f.patterns[0]!), loop: true, passLength: BAR, startU: BAR * 2, endU: BAR * 3, phase: 1920, name: 'A', color: '#000000',
    };
    const p = produce(f.project, (d) => void writePerformance(d, take(f, [e])));
    expect(Object.values(p.playlist.clips)[0]).toMatchObject({ offset: 1920 });
  });

  it('shifts everything by an offset', () => {
    const f = launcherFixture();
    const e: PerformanceTake['entries'][number] = {
      trackId: f.tracks[0]!, sceneId: f.scenes[0]!, content: patternContent(f.patterns[0]!), loop: true, passLength: BAR, startU: BAR, endU: BAR * 2, phase: 0, name: 'A', color: '#000000',
    };
    const p = produce(f.project, (d) => void writePerformance(d, take(f, [e]), BAR * 8));
    expect(Object.values(p.playlist.clips)[0]!.start).toBe(BAR * 9);
  });
});
