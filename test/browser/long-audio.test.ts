/**
 * Long audio (DJ mode foundations): the shared sample cache and its budget, decoding around the
 * playhead, clips whose sample arrives late, and pins on what is playing.
 */
import { describe, expect, it } from 'vitest';
import { playbackMode } from '@core/audio/playback';
import { constantTempo } from '@core/time/ppq';
import type { AudioClip, ClipId, LaneId, ChannelId } from '@core/model/types';
import { createClipPlayer } from '@engine/clip-player';
import { renderOffline } from '@engine/render-offline';
import { SampleCache, type DerivedAudioStore } from '@engine/samples';
import { audioClipProject, harmonicTone, TestSamples } from '../helpers/audio';
import { resolver } from '../helpers/fixtures';
import { readAudioInfo } from '@core/io/audio-info';
import { encodeFlac } from '@core/io/flac';
import { encodeWav } from '@core/io/wav';
import { encodeMp3 } from '@app/export/mp3';
import { probeAudio } from '@app/actions/samples';

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

/** The first index where two signals differ (−1: identical). Cheap to report, unlike a deep diff. */
function firstDifference(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

/** A DerivedAudioStore in memory that counts reads and writes. */
function memoryStore() {
  const files = new Map<string, Uint8Array>();
  const counts = { gets: 0, hits: 0, puts: 0 };
  const store: DerivedAudioStore = {
    async get(key) {
      counts.gets++;
      const f = files.get(key);
      if (f) counts.hits++;
      return f ? f.slice() : null;
    },
    async put(key, bytes) {
      counts.puts++;
      files.set(key, bytes.slice());
    },
    has: async (key) => files.has(key),
  };
  return { store, files, counts };
}

describe('time-stretched clips', () => {
  const BAR = 3840;

  it("stretches only the part a clip plays, keeps the copy on disk and reads it back identically", async () => {
    // A minute of tone at 100 BPM; the clip plays 2 bars from 30 s in, at 120 BPM.
    const samples = new TestSamples();
    const tone = harmonicTone(220, 60, SR, 0.3);
    const ref = samples.add([tone, tone.slice()], SR);
    const { project } = audioClipProject(ref, [{ start: 0, length: 2 * BAR, offsetSec: 30 }], {
      bpm: 120,
      channel: { stretch: 'stretch', sourceBpm: 100 },
    });
    const disk = memoryStore();
    const render = async (cache: SampleCache) => {
      const r = await renderOffline(project, {
        plugins: resolver(),
        sampleCache: cache,
        view: { mode: 'song', patternId: null, loop: null },
        bars: 2,
        sampleRate: SR,
        tail: 0.2,
      });
      return r.buffer.getChannelData(0).slice();
    };
    const first = new SampleCache(samples.provider, { store: disk.store });
    const a = await render(first);
    expect(disk.counts.puts).toBe(1);
    const key = [...disk.files.keys()][0]!;
    // 2 bars at 120 BPM = 4 s of song = 4.8 s of source (+1 s margins, whole seconds): 29…36 s,
    // played 1.2× as fast, so the copy is 1/1.2 as long.
    expect(key).toMatch(/\|st2:0\.83333:29-36$/);
    const copy = first.peek(key)!;
    expect(copy.duration).toBeCloseTo(7 / 1.2, 2);
    // A new session (fresh cache, same disk): the copy is read back, not made again.
    const second = new SampleCache(samples.provider, { store: disk.store });
    const b = await render(second);
    expect(disk.counts.hits).toBe(1);
    expect(disk.counts.puts).toBe(1);
    expect(firstDifference(a, b)).toBe(-1);
  });
});

describe('audio file headers', () => {
  it('give the same duration, rate and channels as decoding the file (WAV, FLAC, MP3)', async () => {
    const rate = 44100;
    const tone = harmonicTone(330, 7.3, rate, 0.4);
    const files = {
      wav: encodeWav([tone, tone], rate, { bitDepth: 16 }),
      flac: encodeFlac([tone, tone], rate, { bitDepth: 16 }),
      mp3: encodeMp3([tone, tone], rate, 192),
    };
    const ctx = new OfflineAudioContext(1, 1, rate);
    for (const [name, bytes] of Object.entries(files)) {
      const info = readAudioInfo(bytes);
      const decoded = await ctx.decodeAudioData(bytes.slice().buffer);
      expect(info, name).not.toBeNull();
      expect(info!.sampleRate, name).toBe(rate);
      expect(info!.channels, name).toBe(decoded.numberOfChannels);
      // Our MP3 has LAME's gapless header, so its length is exact too.
      expect(Math.abs(info!.durationSec - decoded.duration), name).toBeLessThan(1e-6);
      // probeAudio answers from the header (a decode wouldn't know the file's own rate).
      expect(await probeAudio(bytes), name).toEqual({ durationSec: info!.durationSec, sampleRate: rate, channels: info!.channels });
    }
  });
});
