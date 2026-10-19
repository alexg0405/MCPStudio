/**
 * A comp that plays takes of two recordings (offline render through the real engine): after "Add these takes to the
 * comp", a part of the comp taken from the second recording is that recording's audio, the rest is the first's. The
 * two recordings are different tones, so what plays where can be read back from the pitch.
 */
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { tempoMapOf } from '@core/automation/tempo';
import { newId } from '@core/model/ids';
import { MASTER, type AudioClipChannel, type ChannelId, type Project, type SampleRef } from '@core/model/types';
import { addChannel, addSample } from '@core/ops/channels';
import { addTakeGroup, addTakesToComp, compSwipe, newTakeGroup } from '@core/ops/comp';
import { takeGroups } from '@core/query/takes';
import { renderOffline } from '@engine/render-offline';
import { audioClipProject, autocorrelationPitch, sine, TestSamples } from '../helpers/audio';
import { resolver } from '../helpers/fixtures';

const SR = 48000;
const LIMITER = Math.round(0.0013 * SR);
const BAR = 3840; // 2 s at 120 BPM

/** Adds a recording of `seconds` of a tone as a channel with a sample. */
function addRecording(project: Project, samples: TestSamples, hz: number, name: string): { project: Project; channelId: ChannelId } {
  const tone = sine(hz, 4, SR);
  const ref: SampleRef = samples.add([tone, tone.slice()], SR, name);
  const channelId = newId.channel();
  const next = produce(project, (d) => {
    addSample(d, ref);
    const channel: AudioClipChannel = {
      kind: 'audioClip',
      id: channelId,
      name,
      color: '#5f8fbf',
      muted: false,
      solo: false,
      volume: 1,
      pan: 0,
      output: MASTER,
      sampleId: ref.id,
    };
    addChannel(d, channel);
  });
  return { project: next, channelId };
}

async function render(project: Project, samples: TestSamples) {
  const r = await renderOffline(project, {
    plugins: resolver(),
    samples: samples.provider,
    view: { mode: 'song', patternId: null, loop: null },
    bars: 1,
    sampleRate: SR,
    tail: 0.2,
  });
  return r.buffer.getChannelData(0).subarray(Math.round(r.preRoll * SR) + LIMITER);
}

describe('a comp of two recordings', () => {
  it('the segments play the audio of the recording they were taken from', async () => {
    const samples = new TestSamples();
    const empty = audioClipProject(samples.add([sine(100, 1, SR)], SR), [], { bpm: 120 });
    const first = addRecording(empty.project, samples, 440, 'Rec 1');
    const second = addRecording(first.project, samples, 880, 'Rec 2');
    const tempo = tempoMapOf(second.project, 'song');
    const groupA = newTakeGroup();
    const groupB = newTakeGroup();
    const merged = produce(second.project, (d) => {
      addTakeGroup(d, {
        group: groupA,
        name: 'Rec 1',
        channelId: first.channelId,
        takes: [0, 1].map((i) => ({ start: 0, length: BAR, offsetSec: i * 2 })),
        audible: 1,
        first: 0,
        tempo,
      });
      addTakeGroup(d, {
        group: groupB,
        name: 'Rec 2',
        channelId: second.channelId,
        takes: [0, 1].map((i) => ({ start: 0, length: BAR, offsetSec: i * 2 })),
        audible: 1,
        first: 3,
        tempo,
      });
      addTakesToComp(d, groupB, groupA, tempo);
      // The comp plays the second recording's first take (take 3) for beat 2 of the bar (0.5 s – 1.0 s).
      compSwipe(d, groupA, 2, BAR / 4, BAR / 2, tempo);
    });
    const group = takeGroups(merged).find((g) => g.id === groupA)!;
    expect(takeGroups(merged)).toHaveLength(1);
    expect(group.comp.map((c) => c.channelId)).toEqual([first.channelId, second.channelId, first.channelId]);
    const out = await render(merged, samples);
    const hz = (from: number, to: number) => autocorrelationPitch(out, SR, Math.round(from * SR), Math.round(to * SR), 200, 1200);
    expect(hz(0.1, 0.4)).toBeCloseTo(440, -1);
    expect(hz(0.6, 0.9)).toBeCloseTo(880, -1);
    expect(hz(1.2, 1.9)).toBeCloseTo(440, -1);
  });
});
