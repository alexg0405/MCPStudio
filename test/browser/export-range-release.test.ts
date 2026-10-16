/**
 * Exporting a part of the song (a loop region): notes still sounding where the region ends, or that
 * end exactly there (a chord that lasts to the end of the section: the usual case), are released
 * there, so the tail after it dies away instead of holding them for the whole tail.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createServices, type Services } from '@app/services';
import { runExport } from '@app/export/audio-export';
import { decodePcm } from '@core/io/wav';
import type { ClipId, LaneId } from '@core/model/types';
import { addClips } from '@core/ops/playlist';
import threeOsc from '../../src/plugins/builtin/three-osc';
import wavetable from '../../src/plugins/builtin/wavetable';
import { instrumentProject } from '../helpers/instruments';

const BAR = 3840;
const SR = 48000;

const rmsDb = (c: Float32Array, from: number, to: number) => {
  let s = 0;
  for (let i = from; i < to; i++) s += c[i]! * c[i]!;
  return 10 * Math.log10(s / Math.max(1, to - from) + 1e-14);
};

describe('exporting a loop region', () => {
  const services: Services[] = [];
  afterAll(async () => {
    for (const s of services) await s.engine.dispose();
  });

  /** Exports bars [from, from + bars) of a song of 2-bar pattern clips holding `notes`; the file's samples. */
  async function exportRegion(def: typeof threeOsc, notes: { at: number; len: number; key: number }[], from: number, bars: number) {
    const { project: base, patternId } = instrumentProject(def, notes, { bars: 2, bpm: 120 });
    const project = produce(base, (d) => {
      addClips(
        d,
        [0, 2, 4, 6].map((b, i) => ({
          kind: 'pattern' as const,
          id: `c${i}` as ClipId,
          laneId: d.playlist.laneOrder[0] as LaneId,
          start: b * BAR,
          length: 2 * BAR,
          patternId,
          offset: 0,
        })),
      );
    });
    const s = createServices({ project });
    services.push(s);
    s.view.getState().setMode('song');
    s.view.getState().setLoop({ start: from * BAR, end: (from + bars) * BAR });
    const files = new Map<string, Uint8Array>();
    await runExport(
      s,
      { range: 'loop', codec: 'wav', wavBits: 32, flacBits: 24, mp3Kbps: 192, sampleRate: SR, normalize: false, stems: false, masterChain: true, stemsTo: 'zip' },
      { kind: 'memory', files, name: 'part.wav' },
    );
    return decodePcm(files.get('part.wav')!)!.channels[0]!;
  }

  it.each([
    ['3xOsc', threeOsc],
    ['Wavetable', wavetable],
  ])('%s: a note that ends exactly where the region ends does not ring on', async (_name, def) => {
    // Notes of 2 beats at beat 4 of each 2-bar clip: they end at bar 3.5, where the region ends too.
    const ch = await exportRegion(def, [{ at: 4, len: 2, key: 49 }, { at: 0, len: 4, key: 56 }], 2, 1.5);
    const musical = 3; // seconds: 1.5 bars at 120 BPM
    expect(rmsDb(ch, Math.round(2.2 * SR), Math.round(2.9 * SR))).toBeGreaterThan(-45); // the note sounds in the region
    // The release (a fraction of a second) is all that follows: the file ends when the sound has died away.
    expect(ch.length).toBeGreaterThan(musical * SR);
    expect(ch.length).toBeLessThan((musical + 0.6) * SR);
  });

  it.each([
    ['3xOsc', threeOsc],
    ['Wavetable', wavetable],
  ])('%s: a note that goes on past the end of the region is released at it', async (_name, def) => {
    const ch = await exportRegion(def, [{ at: 0, len: 8, key: 56 }], 2, 1);
    const musical = 2;
    expect(rmsDb(ch, Math.round(0.5 * SR), Math.round(1.5 * SR))).toBeGreaterThan(-45);
    // The release (a fraction of a second) is all that follows: the file ends when the sound has died away.
    expect(ch.length).toBeGreaterThan(musical * SR);
    expect(ch.length).toBeLessThan((musical + 0.6) * SR);
  });
});
