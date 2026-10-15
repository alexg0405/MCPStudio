/**
 * Long audio (DJ mode foundations): the shared sample cache and its budget, decoding around the
 * playhead, clips whose sample arrives late, and pins on what is playing.
 */
import { describe, expect, it } from 'vitest';
import { playbackMode } from '@core/audio/playback';
import { constantTempo } from '@core/time/ppq';
import type { AudioClip, ClipId, LaneId, ChannelId } from '@core/model/types';
import { createClipPlayer } from '@engine/clip-player';
import { SampleCache } from '@engine/samples';

const SR = 48000;

function ramp(seconds: number): AudioBuffer {
  // A ramp makes any offset error visible: out[i] − in[i] is constant only when the offset is right.
  const b = new AudioBuffer({ length: seconds * SR, numberOfChannels: 1, sampleRate: SR });
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (i % SR) / SR;
  return b;
}

const clip = (length: number): AudioClip => ({
  kind: 'audio',
  id: 'clip_a' as ClipId,
  laneId: 'lane_a' as LaneId,
  start: 0,
  length,
  channelId: 'ch_a' as ChannelId,
  offsetSec: 0,
});

describe('clip player with buffers that arrive late', () => {
  it('starts a clip in sync once its sample is decoded, and pins the buffer while it plays', async () => {
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 2 * SR, sampleRate: SR });
    const sample = ramp(4);
    const cache = new SampleCache();
    cache.put('s', sample);
    let ready = false;
    let requests = 0;
    const player = createClipPlayer(ctx, {
      mode: () => playbackMode({}),
      base: () => (ready ? { buffer: sample, key: 's' } : null),
      duration: () => (ready ? sample.duration : null),
      stretched: () => null,
      request: () => requests++,
      hold: (key) => cache.pin(key),
    });
    player.output.connect(ctx.destination);
    const tempo = constantTempo(120);
    // The clip starts at 0.1 s (song tick 0) but its sample only arrives at 0.5 s.
    const c = clip(tempo.secondsToTick(1.5));
    player.startClip({ time: 0.1, noteId: 1, key: 60, velocity: 1, clip: c, tick: 0, tempo });
    expect(requests).toBe(1);
    expect(cache.isPinned('s')).toBe(false);
    void ctx.suspend(0.5).then(() => {
      ready = true;
      player.refresh();
      expect(cache.isPinned('s')).toBe(true);
      void ctx.resume();
    });
    const out = (await ctx.startRendering()).getChannelData(0);
    // Silent until the sample arrived, then the sample from where the song is (no delay, no shift).
    expect(Math.max(...out.subarray(0, Math.round(0.5 * SR)).map(Math.abs))).toBe(0);
    const from = Math.round(0.56 * SR);
    for (let i = from; i < from + 4800; i++) expect(out[i]).toBeCloseTo(sample.getChannelData(0)[i - Math.round(0.1 * SR)]!, 5);
    // Finished (clip end at 1.6 s): the pin goes on the next sweep.
    player.sweep();
    expect(cache.isPinned('s')).toBe(false);
  });
});
