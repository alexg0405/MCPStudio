/** A small project for the launcher's tests: three one-bar patterns of notes on one instrument, an audio channel. */
import { produce } from 'immer';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance, makePattern, paletteColor } from '../model/defaults';
import { newId } from '../model/ids';
import type {
  AudioClipChannel,
  ChannelId,
  LaunchTrackId,
  PatternId,
  Project,
  SampleId,
  SceneId,
} from '../model/types';
import { MASTER } from '../model/types';
import { addChannel } from '../ops/channels';
import { addPattern } from '../ops/playlist';
import { ensureCapacity, patternContent, setSlotContent } from '../ops/launcher';

export interface LauncherFixture {
  project: Project;
  channelId: ChannelId;
  audioId: ChannelId;
  patterns: PatternId[];
  tracks: LaunchTrackId[];
  scenes: SceneId[];
}

/**
 * Patterns A, B, C (A: a note on every beat, B: one note per bar, C: two notes) on one instrument channel, an audio
 * channel with a 2 s sample, and the default 8×8 launcher grid: track 1 holds A, B, C in scenes 1–3, track 2 holds C, B in
 * scenes 1, 2.
 */
export function launcherFixture(): LauncherFixture {
  let channelId = '' as ChannelId;
  let audioId = '' as ChannelId;
  const patterns: PatternId[] = [];
  const base = createEmptyProject({ title: 'Launcher' });
  const project = produce(base, (d) => {
    const ch = makeInstrumentChannel('Synth', makePluginInstance('builtin.test', 1, {}), { color: paletteColor(0), output: MASTER });
    channelId = ch.id;
    addChannel(d, ch);
    const sampleId = 'smp_launch_test' as SampleId;
    d.samples[sampleId] = {
      id: sampleId,
      name: 'Loop',
      source: { kind: 'builtin', generator: 'kit/kick', version: 1 },
      durationSec: 2,
    } as never;
    const a: AudioClipChannel = {
      kind: 'audioClip',
      id: newId.channel(),
      name: 'Loop',
      color: paletteColor(1),
      muted: false,
      solo: false,
      volume: 0.78,
      pan: 0,
      output: MASTER,
      sampleId,
    };
    audioId = a.id;
    addChannel(d, a);
    const noteTicks = [[0, 960, 1920, 2880], [0], [0, 1920]];
    ['A', 'B', 'C'].forEach((name, i) => {
      const pat = makePattern(`Pattern ${name}`, paletteColor(i + 2));
      pat.notes[channelId] = {};
      for (const tick of noteTicks[i] ?? []) {
        const id = newId.note();
        pat.notes[channelId][id] = { id, tick, length: 240, key: 60 + i, velocity: 0.8 };
      }
      patterns.push(pat.id);
      addPattern(d, pat);
    });
    const l = ensureCapacity(d, 2, 3);
    const [t1, t2] = l.trackOrder;
    const [s1, s2, s3] = l.sceneOrder;
    setSlotContent(d, t1!, s1!, patternContent(patterns[0]!));
    setSlotContent(d, t1!, s2!, patternContent(patterns[1]!));
    setSlotContent(d, t1!, s3!, patternContent(patterns[2]!));
    setSlotContent(d, t2!, s1!, patternContent(patterns[2]!));
    setSlotContent(d, t2!, s2!, patternContent(patterns[1]!));
  });
  const l = project.launcher!;
  return { project, channelId, audioId, patterns, tracks: l.trackOrder.slice(), scenes: l.sceneOrder.slice() };
}
