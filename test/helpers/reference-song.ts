/**
 * What the reference-matching tests share (`test/browser/reference*.test.ts`): a synthetic reference song written as a WAV, and
 * the loudness of the busiest part of a project as the engine renders it.
 */
import { Measurer } from '@app/analysis/measure';
import type { Services } from '@app/services';
import { busiestWindow } from '@app/mix/auto-level';
import { PATTERNS, MINOR, chord, renderTestSong } from '@core/dj/test-songs';
import { encodeWav } from '@core/io/wav';
import { ticksPerBar } from '@core/time/ppq';
import { renderOffline } from '@engine/render-offline';
import { tempoMapOf } from '@core/automation/tempo';

export const RATE = 44100;
export const TARGET = -8;
export const BAR = 3840;

/** The reference as a WAV file: the structure above, scaled so its integrated loudness is −8 LUFS. */
export function referenceFile() {
  const all = { kick: true, snare: true, hats: true, bass: true, pads: true };
  const song = renderTestSong({
    sampleRate: RATE,
    bpm: 128,
    pattern: PATTERNS.house,
    offset: 0.2,
    tail: 0.2,
    chords: [chord(57, MINOR), chord(50, MINOR), chord(52, [0, 4, 7]), chord(57, MINOR)],
    parts: [
      { bars: 16, kick: true, hats: true, level: 0.7 },
      { bars: 32, ...all, crash: true },
      { bars: 16, pads: true, level: 0.6 },
      { bars: 32, ...all, crash: true },
    ],
  });
  const m = new Measurer(RATE);
  m.push(song.mono, song.mono);
  const gain = Math.pow(10, (TARGET - m.result().lufs) / 20);
  const scaled = song.mono.map((v) => v * gain);
  const wav = encodeWav([scaled, scaled], RATE, { bitDepth: 32 });
  return { name: 'Reference – Drops.wav', arrayBuffer: async () => wav.slice().buffer, scaledPeak: 0.9 * gain, partStarts: song.partStarts };
}

/** The busiest part of the song rendered again, as heard (master chain, Limiter), measured on its own. */
export async function loudnessOfBusiestPart(s: Services) {
  const p = s.doc.getState().project;
  const w = busiestWindow(p, null)!;
  const tempo = tempoMapOf(p, w.mode);
  const toTick = w.fromTick + w.bars * ticksPerBar(p.transport.timeSig);
  const rate = 48000;
  const frames = Math.round((tempo.tickToSeconds(toTick) - tempo.tickToSeconds(w.fromTick)) * rate);
  const r = await renderOffline(p, {
    plugins: s.plugins,
    view: { mode: w.mode, patternId: w.patternId, loop: null },
    bars: w.bars,
    fromTick: w.fromTick,
    sampleRate: rate,
    tail: 0,
    limiter: true,
  });
  const start = Math.round((r.preRoll + r.latency) * rate);
  const m = new Measurer(rate, true);
  m.push(r.buffer.getChannelData(0).subarray(start, start + frames), r.buffer.getChannelData(1).subarray(start, start + frames));
  return { ...m.result(), window: w };
}
