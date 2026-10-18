/**
 * Launched audio follows the song's tempo the way playlist audio clips do, through the real engine (offline renders):
 * a 'stretch' channel plays the same time-stretched copy (pitch stays put when the song tempo differs from the loop's
 * source BPM), 'resample' follows tempo automation (the loop's beats stay on the song's beats).
 */
import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { contentFromAudioChannel, ensureCapacity, setSlotContent } from '@core/ops/launcher';
import type { AudioClipChannel, ChannelId, Project } from '@core/model/types';
import { audioClipProject, autocorrelationPitch, clickTrain, onsetFrames, TestSamples } from '../helpers/audio';
import { automate, pt } from '../helpers/automation';
import { renderLaunch, SR } from '../helpers/launcher-render';

const BAR = 3840;

const stereo = (x: Float32Array) => [x, x.slice()];

/** A project with one audio-clip channel on a launcher slot (track 1, scene 1), at `bpm`. */
function audioSlotProject(signal: Float32Array, bpm: number, channel: Partial<AudioClipChannel>) {
  const samples = new TestSamples();
  const ref = samples.add(stereo(signal), SR);
  const { project: base, channelId } = audioClipProject(ref, [], { bpm, channel });
  const project = produce(base, (d) => {
    const l = ensureCapacity(d, 1, 1);
    const content = contentFromAudioChannel(d as unknown as Project, channelId)!;
    setSlotContent(d, l.trackOrder[0]!, l.sceneOrder[0]!, content);
  });
  const l = project.launcher!;
  return { samples, project, channelId: channelId as ChannelId, track: l.trackOrder[0]!, scene: l.sceneOrder[0]! };
}

/** 220 Hz for two seconds, then 330 Hz, four seconds of sound. */
function twoTones(): Float32Array {
  const tone = new Float32Array(4 * SR);
  for (let i = 0; i < tone.length; i++) {
    const hz = i < 2 * SR ? 220 : 330;
    tone[i] = 0.3 * Math.sin((2 * Math.PI * hz * i) / SR) + 0.1 * Math.sin((4 * Math.PI * hz * i) / SR);
  }
  return tone;
}

describe('launched audio follows the song tempo', () => {
  it("a 'stretch' channel keeps its pitch when the song tempo differs from the loop's source BPM, like the playlist; 'resample' does not", async () => {
    const play = async (stretch: 'stretch' | 'resample') => {
      // Recorded at 100 BPM, the song runs at 150: one pass is 4 s of sound in 2.667 s.
      const s = audioSlotProject(twoTones(), 150, { stretch, sourceBpm: 100 });
      const r = await renderLaunch(s.project, [{ at: 0.02, run: (seq, clk) => seq.launch(s.track, s.scene, clk) }], {
        seconds: 2.9,
        samples: s.samples.provider,
        warm: (seq, clk) => seq.launch(s.track, s.scene, clk),
      });
      return { out: r.buffer.getChannelData(0), at: Math.round(r.startedAt * SR) };
    };
    const st = await play('stretch');
    const w = (a: { at: number }, from: number, to: number): [number, number] => [a.at + Math.round(from * SR), a.at + Math.round(to * SR)];
    // Source 2 s = 1.333 s of song: 220 Hz before, 330 Hz after, at their own pitch.
    const p1 = autocorrelationPitch(st.out, SR, ...w(st, 0.2, 1.1));
    const p2 = autocorrelationPitch(st.out, SR, ...w(st, 1.5, 2.4));
    console.log(`launched stretch at 150 BPM from a 100 BPM loop: ${p1.toFixed(2)} Hz then ${p2.toFixed(2)} Hz (source 220, 330)`);
    expect(p1).toBeCloseTo(220, 0);
    expect(p2).toBeCloseTo(330, 0);
    const rs = await play('resample');
    expect(autocorrelationPitch(rs.out, SR, ...w(rs, 0.2, 1.1))).toBeCloseTo(330, 0);
  });

  it('a resampled loop follows tempo automation: its beats land on the song beats through a tempo change', async () => {
    // Clicks on every beat of a 120 BPM recording, 8 s. 120 BPM for two bars of the song, 180 from bar 3.
    const clicks = clickTrain(0.5, 8, SR, 0.05);
    const s = audioSlotProject(clicks, 120, { stretch: 'resample', sourceBpm: 120 });
    const { project } = automate(
      s.project,
      { kind: 'tempo' },
      [pt(0, 0.5, { shape: 'hold' }), pt(2 * BAR, 1, { shape: 'hold' })],
      [{ start: 0, length: 10 * BAR, lane: 1 }],
    );
    // The press (heard 0.5 s in) waits for bar 2 (2 s): the pass starts at tick 3840 and crosses the change at 7680 (4 s).
    const r = await renderLaunch(project, [{ at: 0.5, run: (seq, clk) => seq.launch(s.track, s.scene, clk) }], {
      seconds: 9,
      song: true,
      samples: s.samples.provider,
      warm: (seq, clk) => seq.launch(s.track, s.scene, clk),
    });
    const out = r.buffer.getChannelData(0);
    const songSec = (tick: number) => (tick < 2 * BAR ? tick / 1920 : 4 + (tick - 2 * BAR) / 2880);
    // The song's transport started at r.startedAt (tick 0). Click i is source second 0.05 + 0.5 i: one source beat per song
    // beat, so song tick BAR + 960 · (i + 0.1) from the pass start.
    const want = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => r.startedAt + songSec(BAR + 960 * (i + 0.1)));
    const got = onsetFrames(out, SR, 0.3, 0.1).map((f) => f / SR);
    const n = Math.min(want.length, got.length);
    expect(n).toBeGreaterThanOrEqual(9);
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(got[i]! - want[i]!));
    console.log(`launched resample through a 120→180 BPM change: ${n} beats, worst error ${(worst * 1000).toFixed(2)} ms`);
    expect(worst).toBeLessThan(0.004);
  });
});
