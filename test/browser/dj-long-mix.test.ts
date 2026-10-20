/**
 * DJ mode foundations end to end: a mix of long synthetic songs (each at its own tempo,
 * beat-matched by time-stretching to the project tempo, overlapping in transitions) plays and
 * exports within a memory budget for decoded audio, with no late events and every song in sync.
 *
 * VITE_LONG_EXPORT=1 also runs a 64-minute mix export and prints its time and memory (a measurement,
 * not part of the normal run: it renders an hour of audio).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createServices, type Services } from '@app/services';
import { runExport, type AudioExportSettings } from '@app/export/audio-export';
import { probeAudio } from '@app/actions/samples';
import { importSampleBytes } from '@app/persistence/sample-import';
import { tempoMapOf } from '@core/automation/tempo';
import { encodeWav } from '@core/io/wav';
import { createEmptyProject } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import { MASTER, type AudioClip, type AudioClipChannel, type LaneId, type Project, type SampleRef } from '@core/model/types';
import { PPQ } from '@core/time/ppq';
import { retryWhenOverloaded } from '../helpers/overload';

const SR = 48000;
const MB = 1024 * 1024;
const LIMITER = Math.round(0.0013 * SR) / SR;

/** A "song": a 5 ms click on every beat at `bpm` over a quiet chord, stereo, 16-bit WAV. */
function songBytes(seconds: number, bpm: number, k: number): Uint8Array {
  const n = Math.round(seconds * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const f = 110 * 2 ** (k / 12);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const v = 0.04 * Math.sin(2 * Math.PI * f * t) + 0.03 * Math.sin(2 * Math.PI * 1.5 * f * t);
    l[i] = v;
    r[i] = v * 0.8;
  }
  const beat = 60 / bpm;
  for (let b = 0; b * beat < seconds - 0.01; b++) {
    const at = Math.round(b * beat * SR);
    for (let j = 0; j < 0.005 * SR && at + j < n; j++) {
      const c = 0.7 * Math.exp(-j / (0.001 * SR)) * (j % 2 ? -1 : 1);
      l[at + j]! += c;
      r[at + j]! += c;
    }
  }
  return encodeWav([l, r], SR, { bitDepth: 16 });
}

interface Mix {
  project: Project;
  /** Where each song's clip starts and ends (song ticks). */
  clips: Array<{ start: number; end: number }>;
}

/** Songs back to back, each overlapping the next by `overlapBars`, all stretched to `bpm`. */
async function buildMix(count: number, seconds: number, bpm: number, overlapBars: number): Promise<Mix> {
  const refs: Array<SampleRef & { bpm: number }> = [];
  for (let k = 0; k < count; k++) {
    const songBpm = 118 + k * 1.5;
    const bytes = songBytes(seconds, songBpm, k);
    const facts = await probeAudio(bytes);
    const ref = await importSampleBytes(bytes, `Song ${k + 1}.wav`);
    refs.push({ ...ref, ...facts!, bpm: songBpm });
  }
  const clips: Mix['clips'] = [];
  const project = produce(createEmptyProject(), (d) => {
    d.transport.bpm = bpm;
    let at = 0;
    refs.forEach((ref, k) => {
      const ch: AudioClipChannel = {
        kind: 'audioClip',
        id: newId.channel(),
        name: ref.name,
        color: '#5f8fbf',
        muted: false,
        solo: false,
        volume: 0.8,
        pan: 0,
        output: MASTER,
        sampleId: ref.id,
        stretch: 'stretch',
        sourceBpm: ref.bpm,
      };
      d.samples[ref.id] = ref;
      d.channels[ch.id] = ch;
      d.channelOrder.push(ch.id);
      // Stretch mode plays one source beat per song beat: the clip is as many beats as the song.
      const length = Math.floor((seconds * ref.bpm) / 60) * PPQ;
      const clip: AudioClip = {
        kind: 'audio',
        id: newId.clip(),
        laneId: d.playlist.laneOrder[k % 2] as LaneId,
        start: at,
        length,
        channelId: ch.id,
        offsetSec: 0,
      };
      d.playlist.clips[clip.id] = clip;
      clips.push({ start: at, end: at + length });
      at += length - overlapBars * 4 * PPQ;
    });
  });
  return { project, clips };
}

const settings = (patch: Partial<AudioExportSettings>): AudioExportSettings => ({
  range: 'song',
  codec: 'wav',
  wavBits: 16,
  flacBits: 24,
  mp3Kbps: 320,
  sampleRate: SR,
  normalize: false,
  stems: false,
  masterChain: true,
  stemsTo: 'folder',
  ...patch,
});

/** A file in OPFS to export into (a real file handle: the export streams into it). */
async function opfsFile(name: string): Promise<FileSystemFileHandle> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('test-exports', { create: true });
  return dir.getFileHandle(name, { create: true });
}

/** The 16-bit stereo WAV's left channel around a frame (±`half` frames). */
async function wavWindow(file: File, frame: number, half: number): Promise<Float32Array> {
  const from = Math.max(0, frame - half);
  const bytes = new Uint8Array(await file.slice(44 + from * 4, 44 + (frame + half) * 4).arrayBuffer());
  const v = new DataView(bytes.buffer);
  const out = new Float32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = v.getInt16(i * 4, true) / 32768;
  return out;
}

/** Frame (relative to the window start) where |x| first exceeds 0.3. */
function firstLoud(x: Float32Array): number {
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]!) > 0.3) return i;
  return -1;
}

async function memory(): Promise<number | null> {
  const p = performance as Performance & { measureUserAgentSpecificMemory?(): Promise<{ bytes: number }> };
  if (!p.measureUserAgentSpecificMemory || !crossOriginIsolated) return null;
  try {
    return (await p.measureUserAgentSpecificMemory()).bytes;
  } catch {
    return null;
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('a DJ mix of long songs', () => {
  const services: Services[] = [];
  afterAll(async () => {
    for (const s of services) await s.engine.dispose();
  });

  it('plays and exports six long songs, beat-matched, within the memory budget', { tags: ['realtime'], timeout: 300_000 }, async (test) => {
    await retryWhenOverloaded(test, async () => {
      for (const old of services.splice(0)) await old.engine.dispose(); // an earlier attempt's engine
      // Stretched copies made by earlier runs are kept in OPFS: start without them, so they are made here.
      await (await navigator.storage.getDirectory()).removeEntry('derived', { recursive: true }).catch(() => {});
      const mix = await buildMix(6, 60, 126, 8);
      const s = createServices({ project: mix.project });
      services.push(s);
      s.view.getState().setMode('song');
      // 6 songs ≈ 140 MB decoded plus as much stretched: far over this budget.
      const budget = 100 * MB;
      s.sampleCache.budgetBytes = budget;
      const tempo = tempoMapOf(mix.project, 'song');

      // Playing: start just before two transitions; what plays is decoded, stretched and pinned in time.
      await s.engine.resume();
      for (const k of [1, 4]) {
        s.engine.play(mix.clips[k]!.start - 4 * PPQ);
        await wait(2500);
        expect(s.engine.playing).toBe(true);
      }
      const stats = s.engine.stats();
      s.engine.stop();
      expect(stats.lateEvents).toBe(0);
      const played = s.sampleCache.stats();
      expect(played.peakBytes).toBeLessThanOrEqual(budget * 1.3);

      // Exporting the whole mix (5 minutes) into a file.
      s.sampleCache.resetPeak();
      const handle = await opfsFile('dj-mix.wav');
      const t0 = performance.now();
      const res = await runExport(s, settings({}), { kind: 'file', handle, name: 'dj-mix.wav' });
      const ms = performance.now() - t0;
      const cache = s.sampleCache.stats();
      console.log(
        `DJ mix: ${res.seconds.toFixed(0)} s exported in ${(ms / 1000).toFixed(1)} s; decoded audio peak ` +
          `${(cache.peakBytes / MB).toFixed(0)} MB (budget ${budget / MB} MB, ${cache.evictions} evictions, ` +
          `${cache.decodes} decodes); while playing ${(played.peakBytes / MB).toFixed(0)} MB, late events ${stats.lateEvents}`,
      );
      expect(cache.peakBytes).toBeLessThanOrEqual(budget * 1.3);
      expect(cache.evictions).toBeGreaterThan(0);
      // Each song decoded about once (not again and again as the budget churns).
      expect(cache.decodes).toBeLessThanOrEqual(2 * mix.clips.length);
      const end = tempo.tickToSeconds(mix.clips[mix.clips.length - 1]!.end);
      expect(res.seconds).toBeGreaterThan(end - 0.5);

      // Every song in sync and whole: on every third beat of each song, a click on time, at full level.
      const file = await handle.getFile();
      const half = Math.round(0.02 * SR);
      let checked = 0;
      for (const [k, c] of mix.clips.entries()) {
        for (let tick = c.start + PPQ; tick < c.end - PPQ; tick += 3 * PPQ) {
          const frame = Math.round(tempo.tickToSeconds(tick) * SR);
          const w = await wavWindow(file, frame, half);
          const hit = firstLoud(w);
          const label = `song ${k + 1}, beat ${(tick - c.start) / PPQ}`;
          expect(hit, label).toBeGreaterThan(0);
          // The master's safety limiter looks 1.3 ms ahead (exports keep that delay); the stretch
          // places each hit within 2 ms.
          expect(Math.abs((hit - half) / SR - LIMITER), label).toBeLessThan(0.0025);
          let peak = 0;
          for (let i = hit; i < Math.min(w.length, hit + 48); i++) peak = Math.max(peak, Math.abs(w[i]!));
          // 0.7 × 0.8: one click, not dulled by interpolation or split by the stretch.
          expect(peak, label).toBeGreaterThan(0.5);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(200);
    });
  });

  it.skipIf(!import.meta.env.VITE_LONG_EXPORT)(
    'measures a 64-minute mix export (sixteen 4.5-minute songs)',
    async () => {
      // Exports and songs of earlier runs take up the test profile's storage.
      const root = await navigator.storage.getDirectory();
      for (const name of ['test-exports', 'derived', 'tmp']) await root.removeEntry(name, { recursive: true }).catch(() => {});
      const mix = await buildMix(16, 270, 126, 16);
      const s = createServices({ project: mix.project });
      services.push(s);
      s.view.getState().setMode('song');
      // 16 songs are 1.6 GB decoded (and as much stretched): a budget well under that.
      const budget = Number(import.meta.env.VITE_LONG_EXPORT_BUDGET_MB ?? 400) * MB;
      s.sampleCache.budgetBytes = budget;
      s.sampleCache.resetPeak();
      const before = await memory();
      // A file handle that counts what is written and keeps none of it: this measures rendering and
      // encoding, not storage (the test profile's OPFS refuses single files near 1 GB).
      let written = 0;
      const handle = {
        name: 'long-mix.wav',
        createWritable: async () => ({
          write: async (data: Uint8Array | { data: Uint8Array }) => {
            if (data instanceof Uint8Array) written += data.byteLength;
          },
          seek: async () => {},
          close: async () => {},
          abort: async () => {},
        }),
      } as unknown as FileSystemFileHandle;
      let peakMem = before ?? 0;
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          const m = await memory();
          if (m !== null) peakMem = Math.max(peakMem, m);
          await wait(5000);
        }
      })();
      const t0 = performance.now();
      const res = await runExport(s, settings({ wavBits: 24 }), { kind: 'file', handle, name: 'long-mix.wav' });
      const ms = performance.now() - t0;
      sampling = false;
      await sampler;
      const cache = s.sampleCache.stats();
      console.log(
        `64-minute mix: ${(res.seconds / 60).toFixed(1)} min exported in ${(ms / 1000).toFixed(0)} s ` +
          `(${(res.seconds / (ms / 1000)).toFixed(1)}x realtime); decoded audio peak ${(cache.peakBytes / MB).toFixed(0)} MB ` +
          `(budget ${budget / MB} MB, ${cache.decodes} decodes, ${cache.evictions} evictions); page memory ${before === null ? 'n/a' : `${(before / MB).toFixed(0)} MB before, peak ${(peakMem / MB).toFixed(0)} MB`}; ` +
          `file ${(written / MB).toFixed(0)} MB`,
      );
      expect(res.seconds).toBeGreaterThan(3600);
    },
    3_600_000,
  );
});
