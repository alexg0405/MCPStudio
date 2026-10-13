import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { newId } from '@core/model/ids';
import { KIT_VERSION } from '@core/model/kit';
import type { AudioClipChannel, ClipId, LaneId, SampleRef } from '@core/model/types';
import { addChannel, addSample } from '@core/ops/channels';
import { addClips } from '@core/ops/playlist';
import { renderOffline } from '@engine/render-offline';
import { kitProject, onsets, resolver } from '../helpers/fixtures';

const SR = 48000;
const LIMITER = Math.round(0.0013 * SR);

describe('song mode render', () => {
  it('plays pattern clips and an audio clip at their playlist positions', async () => {
    const { project: base, patternId } = kitProject([{ generator: 'kit/rim', steps: [0] }], 120);
    const lanes = base.playlist.laneOrder as LaneId[];
    const sample: SampleRef = {
      id: newId.sample(),
      name: 'Rim',
      source: { kind: 'builtin', generator: 'kit/rim', version: KIT_VERSION },
    };
    const audio: AudioClipChannel = {
      kind: 'audioClip',
      id: newId.channel(),
      name: 'Rim clip',
      color: '#fff',
      muted: false,
      solo: false,
      volume: 0.78,
      pan: 0,
      output: base.mixer.order[0]!,
      sampleId: sample.id,
    };
    const project = produce(base, (d) => {
      addSample(d, sample);
      addChannel(d, audio);
      addClips(d, [
        { kind: 'pattern', id: 'c1' as ClipId, laneId: lanes[0]!, start: 0, length: 3840, patternId, offset: 0 },
        { kind: 'pattern', id: 'c2' as ClipId, laneId: lanes[0]!, start: 7680, length: 3840, patternId, offset: 0 },
        {
          kind: 'audio',
          id: 'a1' as ClipId,
          laneId: lanes[1]!,
          start: 3840,
          length: 1920,
          channelId: audio.id,
          offsetSec: 0,
        },
      ]);
    });
    const { buffer, preRoll } = await renderOffline(project, {
      plugins: resolver(),
      view: { mode: 'song', patternId, loop: null },
      bars: 3,
      sampleRate: SR,
    });
    const found = onsets(buffer, 0.05, 0.3);
    // 120 BPM: bars start at 0, 2 and 4 seconds.
    const expected = [0, 2, 4].map((s) => Math.round((s + preRoll) * SR) + LIMITER);
    expect(found).toHaveLength(3);
    found.forEach((f, i) => expect(Math.abs(f - (expected[i] as number))).toBeLessThanOrEqual(48));
  });

  it('honours the loop region in song mode', async () => {
    const { project: base, patternId } = kitProject([{ generator: 'kit/rim', steps: [0, 8] }], 120);
    const lanes = base.playlist.laneOrder as LaneId[];
    const project = produce(base, (d) => {
      addClips(d, [
        { kind: 'pattern', id: 'c1' as ClipId, laneId: lanes[0]!, start: 0, length: 3840 * 4, patternId, offset: 0 },
      ]);
    });
    // Loop beats 3–4 of bar 1 (ticks 1920–3840): only the step-8 hit (tick 1920) repeats, once per second.
    const { buffer, preRoll } = await renderOffline(project, {
      plugins: resolver(),
      view: { mode: 'song', patternId, loop: { start: 1920, end: 3840 } },
      bars: 1,
      sampleRate: SR,
    });
    void preRoll;
    const found = onsets(buffer, 0.05, 0.3);
    expect(found.length).toBe(2);
    expect(Math.abs((found[1]! - found[0]!) / SR - 1)).toBeLessThan(0.002);
  });
});
