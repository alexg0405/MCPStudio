import { describe, expect, it } from 'vitest';
import { launcherFixture } from '@core/launcher/test-project';
import type { ClipId, Project } from '@core/model/types';
import { addClips } from '@core/ops/playlist';
import { createTestServices } from '../../testing';
import { applyAnswer } from '../apply';
import { projectContext } from '../context';
import { runReadTool } from '../read';
import type { AiAction } from '../schema';
import { STUDIO_PROMPT } from '../prompt';

type S = ReturnType<typeof createTestServices>;
const run = (s: S, actions: AiAction[]) => applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });
const BAR = 3840;

/** Services holding the launcher fixture's project (patterns A, B, C, an audio channel and a filled grid). */
function withFixture(grid = true) {
  const f = launcherFixture();
  const project: Project = grid ? f.project : { ...f.project, launcher: undefined as never };
  if (!grid) delete (project as { launcher?: unknown }).launcher;
  const s = createTestServices({ project });
  return { s, f };
}
const launcher = (s: S) => s.doc.getState().project.launcher!;

describe('launcher_slot', () => {
  it('puts a pattern in a slot and sets how it behaves, making the grid the first time, in one undo step', () => {
    const { s } = withFixture(false);
    expect(s.doc.getState().project.launcher).toBeUndefined();
    const before = s.history.status().cursor;
    const res = run(s, [
      { op: 'launcher_slot', track: 2, scene: 3, pattern: 'Pattern B', name: 'Hook', mode: 'toggle', loop: false, quantize: 'beat', follow: { kind: 'next', bars: 2 } },
    ]);
    expect(res.warnings).toEqual([]);
    expect(res.changes).toEqual(['Launcher track 2, scene 3: “Pattern B”, named “Hook”, toggle mode, plays once, quantize 1 beat, next after 2 bars']);
    const l = launcher(s);
    expect(l.trackOrder).toHaveLength(8);
    const slot = l.tracks[l.trackOrder[1]!]!.slots[l.sceneOrder[2]!]!;
    expect(slot).toMatchObject({ name: 'Hook', mode: 'toggle', loop: false, quantize: 'beat', follow: { kind: 'next', bars: 2 } });
    expect(slot.content.kind).toBe('pattern');
    expect(s.history.status().cursor).toBe(before + 1);
    s.history.undo();
    expect(s.doc.getState().project.launcher).toBeUndefined();
  });

  it('takes an audio clip channel, or a playlist clip by id or by track and bar', () => {
    const { s, f } = withFixture();
    s.history.transact('clips', (d) =>
      addClips(d, [
        { kind: 'pattern', id: 'cp' as ClipId, laneId: d.playlist.laneOrder[1]!, start: 4 * BAR, length: 2 * BAR, patternId: f.patterns[2]!, offset: 0 },
        { kind: 'audio', id: 'ca' as ClipId, laneId: d.playlist.laneOrder[2]!, start: 0, length: BAR, channelId: f.audioId, offsetSec: 0.25, gain: 2 },
      ]),
    );
    const res = run(s, [
      { op: 'launcher_slot', track: 3, scene: 1, audio: 'Loop' },
      { op: 'launcher_slot', track: 3, scene: 2, clip: 'ca' },
      { op: 'launcher_slot', track: 3, scene: 3, clip_track: 2, clip_bar: 5 },
    ]);
    expect(res.warnings).toEqual([]);
    const t3 = launcher(s).tracks[launcher(s).trackOrder[2]!]!;
    const [s1, s2, s3] = launcher(s).sceneOrder;
    expect(t3.slots[s1!]!.content).toMatchObject({ kind: 'audio', channelId: f.audioId, offsetSec: 0 });
    expect(t3.slots[s2!]!.content).toMatchObject({ kind: 'audio', offsetSec: 0.25, length: BAR, gain: 2 });
    expect(t3.slots[s3!]!.content).toEqual({ kind: 'pattern', patternId: f.patterns[2] });
  });

  it('changes a slot’s settings without touching what it plays, and clears it', () => {
    const { s, f } = withFixture();
    run(s, [{ op: 'launcher_slot', track: 1, scene: 1, mode: 'gate', follow: { kind: 'stop', bars: 4 } }]);
    const l = launcher(s);
    const slot = () => launcher(s).tracks[l.trackOrder[0]!]!.slots[l.sceneOrder[0]!]!;
    expect(slot()).toMatchObject({ mode: 'gate', follow: { kind: 'stop', bars: 4 }, content: { patternId: f.patterns[0] } });
    run(s, [{ op: 'launcher_slot', track: 1, scene: 1, follow: { kind: 'none' }, mode: 'trigger' }]);
    expect(slot()).toEqual({ content: { kind: 'pattern', patternId: f.patterns[0] } });
    const cleared = run(s, [{ op: 'launcher_slot', track: 1, scene: 1, clear: true }]);
    expect(cleared.changes).toEqual(['Cleared launcher track 1, scene 1']);
    expect(launcher(s).tracks[l.trackOrder[0]!]!.slots[l.sceneOrder[0]!]).toBeUndefined();
  });

  it('says what it could not do', () => {
    const { s } = withFixture();
    const res = run(s, [
      { op: 'launcher_slot', track: 0, scene: 1, pattern: 'Pattern A' },
      { op: 'launcher_slot', track: 1, scene: 99, pattern: 'Pattern A' },
      { op: 'launcher_slot', track: 1, scene: 1, pattern: 'Nope' },
      { op: 'launcher_slot', track: 5, scene: 5, mode: 'trigger' },
      { op: 'launcher_slot', track: 1, scene: 1, mode: 'warp', quantize: 'sometimes', color: 'red' },
      { op: 'launcher_slot', track: 1, scene: 1, audio: 'Synth' },
    ]);
    expect(res.warnings).toEqual([
      'launcher slot: track must be a whole number from 1',
      'launcher slot: scene 99 is out of range (at most 64)',
      'launcher slot: there is no pattern "Nope"',
      'launcher slot: launcher track 5, scene 5 is empty: give it a pattern, audio or clip',
      'launcher slot: “red” is not a hex colour like #c9a24a',
      'launcher slot: unknown mode “warp” (trigger, toggle, gate, retrigger)',
      'launcher slot: unknown quantize “sometimes” (none, beat, bar, 2bars, 4bars)',
      'launcher slot: "Synth" is not an audio clip with a known length',
    ]);
  });
});

describe('launcher_layout', () => {
  it('names scenes and tracks, sets the default quantize, grows the grid and links a track to a playlist track', () => {
    const { s } = withFixture();
    const res = run(s, [
      {
        op: 'launcher_layout',
        quantize: '2bars',
        tracks: 10,
        scenes: 9,
        scene_names: ['Intro', '', 'Drop'],
        track_names: ['Drums', 'Bass'],
        playlist_tracks: [
          { track: 1, playlist_track: 3 },
          { track: 2, playlist_track: 0 },
        ],
      },
    ]);
    expect(res.warnings).toEqual([]);
    const l = launcher(s);
    const p = s.doc.getState().project;
    expect(l.quantize).toBe('2bars');
    expect([l.trackOrder.length, l.sceneOrder.length]).toEqual([10, 9]);
    expect(l.scenes[l.sceneOrder[0]!]!.name).toBe('Intro');
    expect(l.scenes[l.sceneOrder[1]!]!.name).toBe('Scene 2');
    expect(l.scenes[l.sceneOrder[2]!]!.name).toBe('Drop');
    expect(l.tracks[l.trackOrder[1]!]!.name).toBe('Bass');
    expect(l.tracks[l.trackOrder[0]!]!.laneId).toBe(p.playlist.laneOrder[2]);
    expect(l.tracks[l.trackOrder[1]!]!.laneId).toBeUndefined();
  });
});

describe('launcher_play', () => {
  it('launches slots and scenes and stops tracks (live, not an edit)', () => {
    const { s, f } = withFixture();
    const cursor = s.history.status().cursor;
    const res = run(s, [
      { op: 'launcher_play', action: 'launch', track: 1, scene: 2 },
      { op: 'launcher_play', action: 'launch_scene', scene: 1 },
    ]);
    expect(res.warnings).toEqual([]);
    expect(res.edited).toBe(false);
    expect(s.history.status().cursor).toBe(cursor);
    expect(res.ui).toEqual([
      'Launched “Pattern B” (track 1, scene 2): it starts on the next 1 bar boundary',
      'Launched scene 1 “Scene 1”',
    ]);
    // Scene 1 replaced track 1's queued slot and added track 2.
    expect(s.launcher.runs.map((r) => [r.trackId, r.sceneId])).toEqual([
      [f.tracks[0], f.scenes[0]],
      [f.tracks[1], f.scenes[0]],
    ]);
    run(s, [{ op: 'launcher_play', action: 'stop_all' }]);
    s.launcher.seq.reset();
    expect(s.launcher.runs).toHaveLength(0);
  });

  it('says what could not be launched', () => {
    const { s } = withFixture();
    const res = run(s, [
      { op: 'launcher_play', action: 'launch', track: 7, scene: 7 },
      { op: 'launcher_play', action: 'launch_scene', scene: 40 },
      { op: 'launcher_play', action: 'stop_track', track: 40 },
      { op: 'launcher_play', action: 'dance' },
      { op: 'launcher_play', action: 'launch' },
    ]);
    expect(res.warnings).toEqual([
      'launcher play: launcher track 7, scene 7 is empty',
      'launcher play: there is no scene 40',
      'launcher play: there is no launcher track 40',
      'launcher play: unknown action “dance”',
      'launcher play: launch needs track and scene',
    ]);
  });

  it('records a performance: the record is on, and ends when asked', () => {
    const { s } = withFixture();
    run(s, [{ op: 'launcher_play', action: 'record' }]);
    expect(s.launcher.store.getState().recording).toBe(true);
    run(s, [{ op: 'launcher_play', action: 'stop_recording' }]);
    // Nothing was playing: the record is simply over.
    expect(s.launcher.store.getState().recording).toBe(false);
  });

  it('the launcher_play action does nothing without a grid', () => {
    const { s } = withFixture(false);
    const res = run(s, [{ op: 'launcher_play', action: 'launch', track: 1, scene: 1 }]);
    expect(res.warnings).toEqual(['launcher play: the clip launcher is empty: set up slots with launcher_slot first']);
  });
});

describe('reading the launcher', () => {
  it('get_launcher lists the grid with 1-based positions and what each slot does', () => {
    const { s, f } = withFixture();
    run(s, [
      { op: 'launcher_slot', track: 1, scene: 1, mode: 'gate' },
      { op: 'launcher_layout', scene_names: ['Intro'], playlist_tracks: [{ track: 1, playlist_track: 2 }] },
    ]);
    const r = runReadTool(s, 'get_launcher') as {
      quantize: string;
      tracks: { track: number; name: string; playlist_track: number | null }[];
      scenes: { scene: number; name: string }[];
      slots: { track: number; scene: number; name: string; pattern?: string; mode: string; state: string }[];
    };
    expect(r.quantize).toBe('bar');
    expect(r.tracks[0]).toEqual({ track: 1, name: 'Track 1', playlist_track: 2 });
    expect(r.scenes[0]).toEqual({ scene: 1, name: 'Intro' });
    expect(r.slots).toHaveLength(5);
    expect(r.slots[0]).toMatchObject({ track: 1, scene: 1, name: 'Pattern A', pattern: 'Pattern A', mode: 'gate', state: 'idle' });
    void f;
  });

  it('says so when there is no grid', () => {
    const { s } = withFixture(false);
    expect(runReadTool(s, 'get_launcher')).toMatchObject({ empty: true });
  });

  it('the Studio’s context describes the grid, and the prompt explains the actions', () => {
    const { s } = withFixture();
    const text = projectContext(s);
    expect(text).toContain('<launcher>');
    expect(text).toContain('- Scene 1 “Scene 1”: track 1 “Pattern A”; track 2 “Pattern C”');
    expect(STUDIO_PROMPT).toContain('launcher_slot');
    expect(STUDIO_PROMPT).toContain('launcher_play');
  });

  it('leaves the context alone when there is no grid', () => {
    const { s } = withFixture(false);
    expect(projectContext(s)).not.toContain('<launcher>');
  });
});
