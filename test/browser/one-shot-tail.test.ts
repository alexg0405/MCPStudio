/**
 * An export keeps the whole of a one-shot sample that starts at the very end of the song. Samplers, Drum Pads and the
 * Slicer play a sample to its end after the key goes up (Sampler with the envelope off, pads and one-shot slices at
 * full decay), so the export's tail has to follow the sample's length. The tail probe (`measureTail`) decodes nothing,
 * so the length comes from `host.samples.durationSec`: the project's record, else the file's header. The probes here
 * start with a cold sample cache (the app's realtime engine has usually decoded the sample by the time anyone exports,
 * which hides the problem for a Sampler, but not for Drum Pads and the Slicer, whose tail was a fixed 4 and 2 s), then
 * one test goes through the real export.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createServices, type Services } from '@app/services';
import { runExport } from '@app/export/audio-export';
import { trimExport } from '@app/export/export-wav';
import { importSampleBytes } from '@app/persistence/sample-import';
import { decodePcm, encodeWav } from '@core/io/wav';
import type { ClipId, LaneId, SampleRef } from '@core/model/types';
import { addClips } from '@core/ops/playlist';
import { measureTail, renderOffline } from '@engine/render-offline';
import { SampleCache } from '@engine/samples';
import type { ParamValue, PluginDef } from '@agstudio/sdk';
import drumPads from '../../src/plugins/builtin/drum-pads';
import sampler from '../../src/plugins/builtin/sampler';
import slicer from '../../src/plugins/builtin/slicer';
import { TestSamples } from '../helpers/audio';
import { resolver } from '../helpers/fixtures';
import { instrumentProject } from '../helpers/instruments';

const SR = 48000;
const BAR = 3840;
/** The length of the one-shot. */
const SECONDS = 6;
/** The last sixteenth of a one-bar song at 120 BPM: 3.75 beats = 1.875 s. */
const NOTE_AT = 1.875;
/** Seconds of music: one bar at 120 BPM. */
const MUSIC = 2;

/** A 330 Hz tone that fades linearly to nothing over `SECONDS`: audible nearly to its end. */
const oneShot = () =>
  new Float32Array(SECONDS * SR).map((_, i) => 0.6 * (1 - i / (SECONDS * SR)) * Math.sin((2 * Math.PI * 330 * i) / SR));

const db = (c: Float32Array, from: number, to: number) => {
  let s = 0;
  for (let i = from; i < to; i++) s += c[i]! * c[i]!;
  return 10 * Math.log10(s / Math.max(1, to - from) + 1e-14);
};
const at = (sec: number) => Math.round(sec * SR);

/** The export holds the whole sample (`seconds` long from NOTE_AT): it sounds to near its end, long after the one bar. */
function expectWhole(ch: Float32Array, seconds = SECONDS) {
  const end = NOTE_AT + seconds;
  // Sounding at 5/6 of the way through the sample, far later than the 2 s the song lasts.
  expect(db(ch, at(NOTE_AT + seconds * 0.82), at(NOTE_AT + seconds * 0.88))).toBeGreaterThan(-45);
  expect(ch.length).toBeGreaterThan(at(end - 0.15));
  // Its tail decays to silence: quieter and quieter to the end of the file, with no cut-off.
  const last = db(ch, ch.length - at(0.05), ch.length);
  expect(last).toBeLessThan(db(ch, at(NOTE_AT + seconds * 0.82), at(NOTE_AT + seconds * 0.88)) - 6);
  expect(last).toBeLessThan(-45);
  expect(Math.abs(ch[ch.length - 1]!)).toBeLessThan(0.01);
  // Nothing much is padded on after it.
  expect(ch.length).toBeLessThan(at(end + 1.0));
}

describe('exports keep one-shot samples that start at the end of the song (cold sample cache)', () => {
  async function render(def: PluginDef, slot: string, key: number, params: Record<string, ParamValue>, recorded = true) {
    const samples = new TestSamples();
    const ref = samples.add([oneShot()], SR, 'six seconds');
    // Older projects don't record the length: it is read from the file's header.
    const { durationSec: _length, ...unrecorded } = ref;
    const { project, patternId } = instrumentProject(def, [{ at: 3.75, len: 0.25, key }], {
      params,
      samples: { [slot]: recorded ? ref : (unrecorded as SampleRef) },
      bars: 1,
      bpm: 120,
    });
    const plugins = resolver(def);
    // The probe with nothing decoded yet, as when an export starts on a cold cache: the tail has to come from the lengths.
    const tail = await measureTail(project, { plugins, samples: samples.provider }, SR);
    // The render itself gets the sample decoded (a cold Sampler drops a note that arrives before its decode is done),
    // and the tail the cold probe measured.
    const cache = new SampleCache(samples.provider);
    await cache.load(ref, new OfflineAudioContext(1, 1, SR));
    const r = await renderOffline(project, {
      plugins,
      sampleCache: cache,
      view: { mode: 'pattern', patternId, loop: null },
      bars: 1,
      sampleRate: SR,
      tail,
    });
    return { ch: trimExport(r, MUSIC)[0]!, tail };
  }

  it('Sampler, envelope off', async () => {
    const { ch, tail } = await render(sampler as unknown as PluginDef, 'main', 60, {});
    expect(tail).toBeGreaterThanOrEqual(SECONDS);
    expectWhole(ch);
  });

  it('Sampler, envelope off, the length known only from the file header', async () => {
    const { ch, tail } = await render(sampler as unknown as PluginDef, 'main', 60, {}, false);
    expect(tail).toBeGreaterThanOrEqual(SECONDS);
    expectWhole(ch);
  });

  it('Sampler, played an octave below its root: it lasts twice as long, and all of it is kept', async () => {
    const { ch } = await render(sampler as unknown as PluginDef, 'main', 48, {});
    expectWhole(ch, 2 * SECONDS);
  });

  it('Sampler on a completely cold cache: an export right away still plays its first note', async () => {
    const samples = new TestSamples();
    const ref = samples.add([oneShot()], SR, 'six seconds');
    const { project, patternId } = instrumentProject(sampler as unknown as PluginDef, [{ at: 0, len: 1, key: 60 }], {
      params: {},
      samples: { main: ref },
      bars: 1,
      bpm: 120,
    });
    // Nothing decoded beforehand: the Sampler must wait for its sample before the render starts.
    const r = await renderOffline(project, {
      plugins: resolver(sampler as unknown as PluginDef),
      sampleCache: new SampleCache(samples.provider),
      view: { mode: 'pattern', patternId, loop: null },
      bars: 1,
      sampleRate: SR,
      tail: 0,
    });
    const ch = trimExport(r, MUSIC)[0]!;
    expect(db(ch, 0, at(0.5))).toBeGreaterThan(-20);
  });

  it('Sampler with the envelope on still ends with its release', async () => {
    const { tail } = await render(sampler as unknown as PluginDef, 'main', 60, { envelope: true, release: 0.3 });
    expect(tail).toBeLessThan(2);
  });

  it('Drum Pads, a pad with the sample at full decay', async () => {
    const { ch } = await render(drumPads as unknown as PluginDef, 'pad1', 36, {});
    expectWhole(ch);
  });

  it('Drum Pads, a pad with a short decay keeps only that', async () => {
    const { tail } = await render(drumPads as unknown as PluginDef, 'pad1', 36, { pad1Decay: 0.5 });
    expect(tail).toBeLessThan(5);
  });

  it('Slicer, one-shot, the whole sample as one slice', async () => {
    const { ch } = await render(slicer as unknown as PluginDef, 'main', 60, {
      mode: 'grid',
      gridSlices: 1,
      playback: 'oneshot',
      level: 0,
    });
    expectWhole(ch);
  });
});

describe('the real export', () => {
  const services: Services[] = [];
  afterAll(async () => {
    for (const s of services) await s.engine.dispose();
  });

  it('keeps a 6-second one-shot sampler note at the very end of the song', async () => {
    const stored = await importSampleBytes(encodeWav([oneShot()], SR, { bitDepth: 16 }), 'six seconds.wav');
    const ref: SampleRef = { ...stored, durationSec: SECONDS, sampleRate: SR, channels: 1 };
    const def = sampler as unknown as PluginDef;
    const { project: base, patternId } = instrumentProject(def, [{ at: 3.75, len: 0.25, key: 60 }], {
      samples: { main: ref },
      bars: 1,
      bpm: 120,
    });
    const project = produce(base, (d) => {
      addClips(d, [
        { kind: 'pattern', id: 'c1' as ClipId, laneId: d.playlist.laneOrder[0] as LaneId, start: 0, length: BAR, patternId, offset: 0 },
      ]);
    });
    const s = createServices({ project });
    services.push(s);
    s.view.getState().setMode('song');
    const files = new Map<string, Uint8Array>();
    await runExport(
      s,
      { range: 'song', codec: 'wav', wavBits: 32, flacBits: 24, mp3Kbps: 192, sampleRate: SR, normalize: false, stems: false, masterChain: true, stemsTo: 'zip' },
      { kind: 'memory', files, name: 'song.wav' },
    );
    expectWhole(decodePcm(files.get('song.wav')!)!.channels[0]!);
  });
});
