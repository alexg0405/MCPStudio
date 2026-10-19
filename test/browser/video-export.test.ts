/**
 * Export as video through the real pipeline (services, offline render, the video Worker with WebCodecs):
 * the file is decoded back in the page (a <video> element and decodeAudioData) and checked for its
 * duration, its pictures, its sound, and that the sound and the beat pulse line up to within one frame.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createServices, type Services } from '@app/services';
import { DEFAULT_VIDEO_THEME } from '@app/export/video/frames';
import { runVideoExport, type VideoExportSettings } from '@app/export/video/video-export';
import { probeFormats } from '@app/export/video/support';
import type { ClipId, LaneId, Project } from '@core/model/types';
import { addClips } from '@core/ops/playlist';
import { VIDEO_FORMAT_INFO, type VideoFormat } from '@core/video/formats';
import { frameCountFor } from '@core/video/timing';
import { kitProject } from '../helpers/fixtures';
import { perfLimit, settle } from '../helpers/perf';
import { parseMp4, readSamples } from '../helpers/mp4-parse';
import { parseWebm } from '../helpers/webm-parse';

const BAR = 3840;
const FPS = 30;

/** 128 BPM: a beat every 0.46875 s, which falls between video frames (30 fps), not on them. */
const BPM = 128;
const BEAT = 60 / BPM;

/** A kick on every beat and a hat between them, three bars. */
function song(bars = 3): Project {
  const kit = kitProject(
    [
      { generator: 'kit/kick', steps: [0, 4, 8, 12] },
      { generator: 'kit/hat-closed', steps: [2, 6, 10, 14] },
    ],
    BPM,
  );
  return produce(kit.project, (d) => {
    addClips(d, [
      {
        kind: 'pattern',
        id: 'c1' as ClipId,
        laneId: d.playlist.laneOrder[0] as LaneId,
        start: 0,
        length: bars * BAR,
        patternId: kit.patternId,
        offset: 0,
      },
    ]);
  });
}

const settings = (patch: Partial<VideoExportSettings> = {}): VideoExportSettings => ({
  range: 'song',
  style: 'minimal',
  size: '1080p',
  fps: FPS,
  format: 'webm-vp9',
  title: 'Test song',
  artist: 'AGstudio',
  normalize: false,
  scale: 0.25,
  theme: DEFAULT_VIDEO_THEME,
  ...patch,
});

// ---------------------------------------------------------------- reading a video back in the page

async function loadVideo(bytes: Uint8Array, mime: string): Promise<HTMLVideoElement> {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }));
  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () => reject(new Error(`the video did not load: ${video.error?.message ?? video.error?.code}`));
  });
  return video;
}

async function seek(video: HTMLVideoElement, t: number): Promise<void> {
  await new Promise<void>((resolve) => {
    video.onseeked = () => resolve();
    video.currentTime = t;
  });
  // Let the frame reach the compositor.
  await new Promise((r) => requestAnimationFrame(() => r(null)));
}

/** Pixels of the video's current frame. */
function grab(video: HTMLVideoElement, canvas: HTMLCanvasElement): ImageData {
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(video, 0, 0, canvas.width, canvas.height);
  return g.getImageData(0, 0, canvas.width, canvas.height);
}

function lum(d: ImageData, x0 = 0, y0 = 0, x1 = d.width, y1 = d.height): number {
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * d.width + x) * 4;
      sum += 0.2126 * (d.data[i] as number) + 0.7152 * (d.data[i + 1] as number) + 0.0722 * (d.data[i + 2] as number);
      n++;
    }
  return sum / n;
}

function stdev(d: ImageData): number {
  const mean = lum(d);
  let acc = 0;
  for (let i = 0; i < d.data.length; i += 4) {
    const v = 0.2126 * (d.data[i] as number) + 0.7152 * (d.data[i + 1] as number) + 0.0722 * (d.data[i + 2] as number);
    acc += (v - mean) ** 2;
  }
  return Math.sqrt(acc / (d.data.length / 4));
}

async function decodeSound(bytes: Uint8Array): Promise<AudioBuffer> {
  return new OfflineAudioContext(2, 1, 48000).decodeAudioData(bytes.slice().buffer as ArrayBuffer);
}

describe('video export', () => {
  const services: Services[] = [];
  const make = (project: Project) => {
    const s = createServices({ project });
    services.push(s);
    s.view.getState().setMode('song');
    return s;
  };
  afterAll(async () => {
    for (const s of services) await s.engine.dispose();
  });

  const exportTo = async (s: Services, patch: Partial<VideoExportSettings> = {}) => {
    const files = new Map<string, Uint8Array>();
    const progress: number[] = [];
    const res = await runVideoExport(
      s,
      settings(patch),
      { kind: 'memory', files, name: 'v' },
      { onProgress: (p) => progress.push(p.fraction) },
    );
    return { bytes: files.get('v')!, res, progress };
  };

  /**
   * The rising edge of the beat pulse in the frames around each beat, against the click in the sound.
   * Frame i is shown at i / fps; the click is the first loud sample of the decoded sound.
   */
  async function checkSync(video: HTMLVideoElement, sound: AudioBuffer, beats: number[]) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(1920 * 0.25);
    canvas.height = Math.round(1080 * 0.25);
    const x = sound.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]!));
    const out: Array<{ beat: number; click: number; frame: number; offsetMs: number }> = [];
    for (const b of beats) {
      // The click: the first sample above a fifth of the loudest within the beat.
      let i = Math.max(0, Math.floor((b - 0.02) * sound.sampleRate));
      const end = Math.floor((b + 0.3) * sound.sampleRate);
      while (i < end && Math.abs(x[i]!) < 0.2 * peak) i++;
      const click = i / sound.sampleRate;
      // Frames around the beat, in a region only the glow reaches (left of the middle, clear of text and ring).
      const first = Math.max(0, Math.ceil(b * FPS) - 3);
      const series: number[] = [];
      for (let f = first; f < first + 10; f++) {
        await seek(video, Math.max(0, f) / FPS + 0.002);
        const d = grab(video, canvas);
        series.push(
          lum(
            d,
            Math.round(d.width * 0.03),
            Math.round(d.height * 0.42),
            Math.round(d.width * 0.13),
            Math.round(d.height * 0.58),
          ),
        );
      }
      const lo = Math.min(...series);
      const hi = Math.max(...series);
      expect(hi - lo, `the pulse is visible at beat ${b}`).toBeGreaterThan(4);
      const rise = series.findIndex((v) => v >= lo + 0.5 * (hi - lo));
      const frame = first + rise;
      out.push({ beat: b, click, frame, offsetMs: (frame / FPS - click) * 1000 });
    }
    return out;
  }

  const formats: VideoFormat[] = ['webm-vp9', 'mp4-h264'];
  for (const format of formats) {
    describe(format, () => {
      it('makes a file Chrome plays: right length, real pictures, sound, and the pulse on the click', async () => {
        const support = await probeFormats('1080p', FPS, 0.25);
        if (support[format]) {
          console.warn(`skipping ${format}: ${support[format]}`);
          return;
        }
        const s = make(song());
        const info = VIDEO_FORMAT_INFO[format];
        const { bytes, res, progress } = await exportTo(s, { format });
        expect(res.name).toBe('v');
        expect(res.bytes).toBe(bytes.length);
        expect(res.frames).toBe(frameCountFor(res.seconds, FPS));
        // 3 bars at 128 BPM is 5.6 s of music, plus a short tail.
        expect(res.seconds).toBeGreaterThan(5.6);
        expect(res.seconds).toBeLessThan(9);
        // The progress bar only goes forward and reaches the end.
        for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
        expect(progress.at(-1)).toBe(1);

        // The container's own structure.
        if (info.container === 'webm') {
          const f = parseWebm(bytes);
          expect(f.docType).toBe('webm');
          expect(f.segmentSize).toBe(bytes.length - f.segmentStart);
          expect(f.tracks.map((t) => t.codecId)).toEqual(['V_VP9', 'A_OPUS']);
          expect(f.tracks[0]).toMatchObject({ width: 480, height: 270 });
          const blocks = f.clusters.flatMap((c) => c.blocks);
          for (let i = 1; i < blocks.length; i++) expect(blocks[i]!.ms).toBeGreaterThanOrEqual(blocks[i - 1]!.ms);
          const video = blocks.filter((b) => b.track === 1);
          expect(video).toHaveLength(res.frames);
          // Key frames about every two seconds (frames 0, 60, 120…), each opening a cluster.
          expect(video.filter((b) => b.key).map((b) => b.ms)).toEqual(
            Array.from({ length: Math.ceil(res.frames / 60) }, (_, k) => Math.round((k * 60 * 1000) / FPS)),
          );
          expect(f.cues.length).toBe(f.clusters.length);
          expect(Math.abs(f.info.duration / 1000 - res.seconds)).toBeLessThanOrEqual(1 / FPS + 0.001);
        } else {
          const f = parseMp4(bytes);
          expect(f.tracks.map((t) => t.entry)).toEqual(['avc1', 'mp4a']);
          expect(f.top.map((b) => b.type)).toEqual(['ftyp', 'moov', 'free', 'mdat']);
          expect(readSamples(bytes, f.tracks[0]!)).toHaveLength(res.frames);
          expect(f.tracks[0]!.stss![0]).toBe(1);
          expect(Math.abs(f.movie.duration / 1000 - res.seconds)).toBeLessThanOrEqual(1 / FPS + 0.001);
        }

        // Chrome plays it: the length is the audio's within one frame.
        const video = await loadVideo(bytes, info.mime);
        expect(video.videoWidth).toBe(480);
        expect(video.videoHeight).toBe(270);
        expect(Math.abs(video.duration - res.seconds)).toBeLessThanOrEqual(1 / FPS + 0.002);

        // The pictures are real and change.
        const canvas = document.createElement('canvas');
        canvas.width = 480;
        canvas.height = 270;
        const looks: ImageData[] = [];
        for (const t of [0.01, 1.01, 2.5, 4.01]) {
          await seek(video, t);
          looks.push(grab(video, canvas));
        }
        for (const d of looks) {
          expect(lum(d)).toBeGreaterThan(15);
          expect(stdev(d)).toBeGreaterThan(8);
        }
        const [a, b] = looks;
        let differ = 0;
        for (let i = 0; i < a!.data.length; i += 4)
          if (Math.abs((a!.data[i] as number) - (b!.data[i] as number)) > 20) differ++;
        expect(differ).toBeGreaterThan(50);

        // The sound is there and the same length.
        const sound = await decodeSound(bytes);
        expect(sound.numberOfChannels).toBe(2);
        expect(Math.abs(sound.duration - res.seconds)).toBeLessThanOrEqual(1 / FPS + 0.02);
        let sum = 0;
        const left = sound.getChannelData(0);
        for (const v of left) sum += v * v;
        expect(Math.sqrt(sum / left.length)).toBeGreaterThan(0.01);

        // The click and the pulse line up within one frame.
        const sync = await checkSync(
          video,
          sound,
          [0, 1, 2, 3, 4, 5, 7, 10].map((k) => k * BEAT),
        );
        const worst = Math.max(...sync.map((r) => Math.abs(r.offsetMs)));
        // One frame at 30 fps is 33.3 ms (plus the click's own attack).
        expect(worst, JSON.stringify(sync)).toBeLessThanOrEqual(1000 / FPS + 3);
      }, 240_000);
    });
  }

  describe('shapes, looks and options', () => {
    it('makes every style at every shape, and 60 fps', async () => {
      const s = make(song(1));
      for (const [size, w, h] of [
        ['vertical', 270, 480],
        ['square', 270, 270],
      ] as const)
        for (const style of ['bars', 'wave', 'circle', 'minimal'] as const) {
          const { bytes, res } = await exportTo(s, { style, size, scale: 0.25 });
          const f = parseWebm(bytes);
          expect(f.tracks[0], `${style} ${size}`).toMatchObject({ width: w, height: h });
          expect(f.clusters.flatMap((c) => c.blocks).filter((b) => b.track === 1)).toHaveLength(res.frames);
        }
      const { bytes, res } = await exportTo(s, { fps: 60, size: 'square', scale: 0.25 });
      const f = parseWebm(bytes);
      expect(f.tracks[0]!.defaultDuration).toBe(Math.round(1e9 / 60));
      expect(res.frames).toBe(frameCountFor(res.seconds, 60));
      // Key frames every two seconds: every 120 frames.
      const keys = f.clusters.flatMap((c) => c.blocks).filter((b) => b.track === 1 && b.key);
      expect(keys.map((b) => b.ms)).toEqual(Array.from({ length: Math.ceil(res.frames / 120) }, (_, k) => 2000 * k));
    });

    it('uses a picture as the background, and AV1 where the browser can make it', async () => {
      const s = make(song(1));
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 64;
      const g = c.getContext('2d')!;
      g.fillStyle = '#2060ff';
      g.fillRect(0, 0, 64, 64);
      const image = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
      const plain = await exportTo(s, { style: 'minimal' });
      const pictured = await exportTo(s, { style: 'minimal', image });
      const grab1 = async (bytes: Uint8Array) => {
        const v = await loadVideo(bytes, 'video/webm');
        await seek(v, 0.7);
        const cv = document.createElement('canvas');
        cv.width = 480;
        cv.height = 270;
        const d = grab(v, cv);
        // The left edge, away from the text: the picture's blue against the plain brown.
        let r = 0;
        let b = 0;
        let n = 0;
        for (let y = 100; y < 170; y++)
          for (let x = 10; x < 60; x++) {
            const i = (y * d.width + x) * 4;
            r += d.data[i]!;
            b += d.data[i + 2]!;
            n++;
          }
        return { r: r / n, b: b / n };
      };
      const a = await grab1(plain.bytes);
      const p = await grab1(pictured.bytes);
      expect(p.b - p.r).toBeGreaterThan(a.b - a.r + 15);
      if ((await probeFormats('1080p', FPS, 0.25))['webm-av1'] === null) {
        const av1 = await exportTo(s, { format: 'webm-av1' });
        const f = parseWebm(av1.bytes);
        expect(f.tracks[0]!.codecId).toBe('V_AV1');
        expect(f.tracks[0]!.codecPrivate!.length).toBeGreaterThanOrEqual(4);
        const v = await loadVideo(av1.bytes, 'video/webm');
        await seek(v, 0.5);
        const cv = document.createElement('canvas');
        cv.width = 480;
        cv.height = 270;
        expect(stdev(grab(v, cv))).toBeGreaterThan(8);
      }
    });

    it('says so, and writes nothing, when the background picture cannot be read', async () => {
      const s = make(song(1));
      const files = new Map<string, Uint8Array>();
      const image = new Blob(['not a picture'], { type: 'image/png' });
      await expect(runVideoExport(s, settings({ image }), { kind: 'memory', files, name: 'v' })).rejects.toThrow(
        /could not be read/,
      );
      expect(files.size).toBe(0);
    });

    it('exports just a part of the song, normalizes, and can be cancelled', async () => {
      const s = make(song(3));
      const whole = await exportTo(s, { scale: 0.25 });
      const part = await exportTo(s, { scale: 0.25, range: { from: BAR, to: 2 * BAR } });
      // One bar of three at 128 BPM is 1.875 s of music against 5.6.
      expect(whole.res.seconds - part.res.seconds).toBeGreaterThan(3.2);
      expect(whole.res.seconds - part.res.seconds).toBeLessThan(4.3);
      const loudness = async (bytes: Uint8Array) => {
        const x = (await decodeSound(bytes)).getChannelData(0);
        let sum = 0;
        for (const v of x) sum += v * v;
        return Math.sqrt(sum / x.length);
      };
      const norm = await exportTo(s, { scale: 0.25, normalize: true });
      expect(await loudness(norm.bytes)).toBeGreaterThan(1.05 * (await loudness(whole.bytes)));
      expect(norm.progress.at(-1)).toBe(1);
      // Cancelling stops the render and leaves no file behind.
      const files = new Map<string, Uint8Array>();
      const controller = new AbortController();
      const run = runVideoExport(
        s,
        settings({ scale: 0.25 }),
        { kind: 'memory', files, name: 'v' },
        {
          signal: controller.signal,
          onProgress: (p) => {
            if (p.fraction > 0.2) controller.abort();
          },
        },
      );
      await expect(run).rejects.toThrow();
      expect(files.size).toBe(0);
    });
  });

  it('makes a three-minute song as MP4 and WebM: every cluster and index entry in place, seeking to the end works', async () => {
    const s = make(song(96));
    for (const format of ['mp4-h264', 'webm-vp9'] as VideoFormat[]) {
      const { bytes, res } = await exportTo(s, { format, scale: 0.2, fps: 30 });
      // 96 bars at 128 BPM is 180 s.
      expect(res.seconds).toBeGreaterThan(180);
      expect(res.seconds).toBeLessThan(184);
      expect(res.frames).toBe(frameCountFor(res.seconds, FPS));
      if (format === 'webm-vp9') {
        const f = parseWebm(bytes);
        expect(f.clusters.length).toBe(Math.ceil(res.frames / 60));
        expect(f.cues).toHaveLength(f.clusters.length);
        for (const c of f.clusters.slice(0, -1)) expect(c.blocks.length).toBeGreaterThan(40);
      } else {
        const f = parseMp4(bytes);
        expect(f.top.map((b) => b.type)).toEqual(['ftyp', 'moov', 'free', 'mdat']);
        expect(f.tracks[0]!.sizes).toHaveLength(res.frames);
        expect(f.tracks[0]!.stss).toHaveLength(Math.ceil(res.frames / 60));
      }
      const video = await loadVideo(bytes, VIDEO_FORMAT_INFO[format].mime);
      const detail =
        format === 'mp4-h264'
          ? JSON.stringify(parseMp4(bytes).tracks.map((t) => [t.duration, t.mediaDuration, t.timescale, t.elst])) +
            parseMp4(bytes).movie.duration
          : '';
      expect(
        Math.abs(video.duration - res.seconds),
        `${format} ${video.duration} vs ${res.seconds} ${detail}`,
      ).toBeLessThanOrEqual(1 / FPS + 0.002);
      await seek(video, res.seconds - 1);
      const cv = document.createElement('canvas');
      cv.width = 384;
      cv.height = 216;
      const d = grab(video, cv);
      expect(stdev(d), `${format} near the end`).toBeGreaterThan(8);
    }
  });

  // Speed of the whole pipeline (render, draw, encode, mux) at 1080p30: seconds of video made per second of work.
  describe('speed at 1080p, 30 fps', () => {
    for (const format of ['webm-vp9', 'mp4-h264'] as VideoFormat[]) {
      it(`${format} encodes faster than the limit`, { tags: ['perf'], timeout: 300_000 }, async () => {
        const support = await probeFormats('1080p', FPS);
        if (support[format]) {
          console.warn(`skipping ${format}: ${support[format]}`);
          return;
        }
        const s = make(song(4));
        let last = { seconds: 0, took: 0, bytes: 0, frames: 0 };
        const speed = await settle(
          async () => {
            const { res } = await exportTo(s, { format, scale: 1 });
            last = res;
            return res.seconds / res.took;
          },
          (v) => v >= perfLimit(3, 1),
          { attempts: 2, better: 'higher' },
        );
        console.info(
          `VIDEO SPEED ${format} 1080p30: ${speed.toFixed(2)}x realtime (${last.seconds.toFixed(1)} s of video in ${last.took.toFixed(1)} s, ${last.frames} frames, ${(last.bytes / 1e6).toFixed(2)} MB, ${((last.bytes * 8) / last.seconds / 1e6).toFixed(2)} Mbit/s)`,
        );
        expect(speed).toBeGreaterThanOrEqual(perfLimit(3, 1));
      });
    }
  });
});
