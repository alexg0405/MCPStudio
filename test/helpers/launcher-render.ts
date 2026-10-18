import { produce } from 'immer';
import { LaunchSequencer, type PerformanceTake } from '@core/launcher/sequencer';
import { newId } from '@core/model/ids';
import { KIT_VERSION } from '@core/model/kit';
import type { ChannelId, PatternId, Project, SampleRef } from '@core/model/types';
import { setStep } from '@core/ops/notes';
import { addPattern } from '@core/ops/playlist';
import { patternContent, setSlotContent, ensureCapacity } from '@core/ops/launcher';
import { makePattern } from '@core/model/defaults';
import type { LaunchClock } from '@core/launcher/run';
import { Engine } from '@engine/engine';
import type { EngineOptions, TransportView } from '@engine/api';
import { kitProject, resolver } from './fixtures';

export const SR = 48000;
/** Frames of one render quantum: the finest timing the audio thread has. */
export const BLOCK = 128;

/** A scripted press: runs at (or just after) `at` seconds of the render's clock, against the sequencer and its clock. */
export interface LaunchStep {
  at: number;
  run(seq: LaunchSequencer, clock: LaunchClock): void;
}

export interface LaunchRender {
  buffer: AudioBuffer;
  seq: LaunchSequencer;
  takes: PerformanceTake[];
  /** The context time the transport started at (the first launch from nothing, or the song's start). */
  startedAt: number;
  /** The frame each step ran at. */
  ranAt: number[];
}

/**
 * Renders what the launcher plays through the real engine on an OfflineAudioContext (the launcher's transport
 * and scheduler, mixer, instruments): the steps run between render chunks of one quantum, like presses between
 * scheduler ticks, and the engine is told after each (`launcherChanged`), as the app's session does.
 * `song`: the song transport is started first (and the launcher plays over it); otherwise the first launch starts
 * the launcher on its own.
 */
export async function renderLaunch(
  project: Project,
  steps: readonly LaunchStep[],
  opts: {
    seconds: number;
    song?: boolean;
    view?: TransportView;
    plugins?: ReturnType<typeof resolver>;
    /** Bytes of embedded samples (see TestSamples). */
    samples?: EngineOptions['samples'];
    /**
     * Presses made before the render with nothing playing (they only decide what will be launched): what those runs
     * need (decoded samples, stretched copies) is made first, so the render hears a settled launcher.
     */
    warm?: (seq: LaunchSequencer, clock: LaunchClock) => void;
  } = { seconds: 4 },
): Promise<LaunchRender> {
  const length = Math.ceil(opts.seconds * SR);
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate: SR });
  const engine = new Engine(ctx, { plugins: opts.plugins ?? resolver(), ...(opts.samples ? { samples: opts.samples } : {}) }, true, {
    limiter: false,
  });
  const takes: PerformanceTake[] = [];
  const seq = new LaunchSequencer({ project: () => project, random: () => 0, onTake: (t) => takes.push(t) });
  const ranAt: number[] = [];
  let startedAt = Number.NaN;
  try {
    engine.applyDocChange({ next: project, prev: project, patches: null, origin: 'load' });
    engine.setTransportView(opts.view ?? { mode: 'song', patternId: project.patternOrder[0] as PatternId, loop: null });
    engine.setLauncher(seq);
    await engine.ready();
    if (opts.warm) {
      opts.warm(seq, { playing: false, heardU: 0, earliestU: 0 });
      await engine.launchReady();
      seq.reset();
    }
    if (opts.song) {
      startedAt = 128 / SR;
      engine.startOffline(0, startedAt);
    }
    const pending = [...steps].sort((a, b) => a.at - b.at);
    const step = async (frame: number) => {
      const now = frame / SR;
      while (pending.length && (pending[0] as LaunchStep).at <= now + 1e-9) {
        const s = pending.shift() as LaunchStep;
        const wasPlaying = engine.playing;
        s.run(seq, engine.launcherClock());
        engine.launcherChanged();
        if (!wasPlaying && engine.playing && Number.isNaN(startedAt)) startedAt = ctx.currentTime + 0.012;
        ranAt.push(frame);
      }
      const next = frame + BLOCK;
      engine.pumpOffline(Math.min(opts.seconds, next / SR + 0.25));
      if (!(await engine.syncWorklets())) throw new Error('worklets did not sync');
      if (next < length) void ctx.suspend(next / SR).then(() => step(next));
      await ctx.resume();
    };
    void ctx.suspend(BLOCK / SR).then(() => step(BLOCK));
    const buffer = await ctx.startRendering();
    return { buffer, seq, takes, startedAt, ranAt };
  } finally {
    await engine.dispose();
  }
}

/** A project with a rim-shot channel and a kick channel, patterns A (rim every beat), B (rim on beats 1 and 3), K (kick on beat 1) and a launcher grid. */
export function jamProject(bpm = 120): {
  project: Project;
  rim: ChannelId;
  kick: ChannelId;
  patterns: { A: PatternId; B: PatternId; K: PatternId };
} {
  const { project: base, channels, patternId } = kitProject(
    [
      { generator: 'kit/rim', steps: [] },
      { generator: 'kit/kick', steps: [] },
    ],
    bpm,
  );
  const [rim, kick] = channels as [ChannelId, ChannelId];
  const B = makePattern('B', '#6aa86b').id;
  const K = makePattern('K', '#c9a24a').id;
  const project = produce(base, (d) => {
    for (const s of [0, 4, 8, 12]) setStep(d, patternId, rim, s, true, { rootKey: 60, velocity: 1 });
    addPattern(d, makePattern('B', '#6aa86b', B));
    for (const s of [0, 8]) setStep(d, B, rim, s, true, { rootKey: 60, velocity: 1 });
    addPattern(d, makePattern('K', '#c9a24a', K));
    setStep(d, K, kick, 0, true, { rootKey: 60, velocity: 1 });
    const l = ensureCapacity(d, 2, 3);
    const [t1, t2] = l.trackOrder;
    const [s1, s2] = l.sceneOrder;
    setSlotContent(d, t1!, s1!, patternContent(patternId));
    setSlotContent(d, t1!, s2!, patternContent(B));
    setSlotContent(d, t2!, s1!, patternContent(K));
  });
  return { project, rim, kick, patterns: { A: patternId, B, K } };
}

export function kitSample(generator: string): SampleRef {
  return { id: newId.sample(), name: generator, source: { kind: 'builtin', generator, version: KIT_VERSION } };
}
