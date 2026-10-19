/**
 * Characterization of the sample browser's analysis: the exact measurements (`extractFeatures`), category
 * scores and the whole `analyzeSample` result for a spread of synthetic sounds (drum hits, an 808, a clap, hums,
 * a pad, noise, silence, loops) at two sample rates, with and without file-name hints.
 *
 * It exists so the measuring code can be reorganised without changing what it finds. If a deliberate change
 * makes it fail, review the snapshot diff and regenerate it with `vitest -u`.
 */
import { describe, expect, it } from 'vitest';
import {
  mulberry32,
  mixInto,
  noiseFloor,
  synthBreath,
  synthHat,
  synthHum,
  synthKick,
  synthSnare,
} from '../voice/test-signals';
import { analyzeSample, findOnsets, loopTempo } from './analyze';
import { categoryScores } from './classify';
import { extractFeatures, monoMix } from './features';

interface Sound {
  name: string;
  channels: Float32Array[];
  sampleRate: number;
  path?: string;
  rootKey?: number;
}

/** A decaying low sine that rings on: an 808. */
function bass808(sampleRate: number, hz: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate;
    const glide = hz * (1 + 0.8 * Math.exp(-t / 0.03));
    out[i] = 0.9 * Math.sin(2 * Math.PI * glide * t) * Math.exp(-t / 0.9) * Math.min(1, t / 0.003);
  }
  return out;
}

/** Three short noise bursts a few ms apart: a clap. */
function clap(sampleRate: number): Float32Array {
  const out = new Float32Array(Math.round(0.4 * sampleRate));
  const rand = mulberry32(5);
  for (const startSec of [0, 0.012, 0.024]) {
    const start = Math.round(startSec * sampleRate);
    for (let k = 0; k < 0.012 * sampleRate; k++) {
      out[start + k] = (out[start + k] as number) + (rand() * 2 - 1) * 0.5 * Math.exp(-k / (0.004 * sampleRate));
    }
  }
  for (let k = Math.round(0.036 * sampleRate); k < out.length; k++) {
    out[k] = (rand() * 2 - 1) * 0.4 * Math.exp(-(k / sampleRate - 0.036) / 0.08);
  }
  return out;
}

/** A sustained chord: three harmonic tones with a slow attack. */
function pad(sampleRate: number): Float32Array {
  const out = new Float32Array(Math.round(2.5 * sampleRate));
  for (const hz of [220, 277.2, 329.6]) {
    const tone = synthHum(sampleRate, { hz, durationSec: 2.5, attackSec: 0.2, releaseSec: 0.4 });
    for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) + (tone[i] as number) * 0.3;
  }
  return out;
}

/** Two bars of kick, snare and hats at a tempo. */
function drumLoop(sampleRate: number, bpm: number): Float32Array {
  const beat = 60 / bpm;
  const out = new Float32Array(Math.round(8 * beat * sampleRate));
  const kick = synthKick(sampleRate);
  const snare = synthSnare(sampleRate);
  const hat = synthHat(sampleRate);
  for (let b = 0; b < 8; b++) {
    mixInto(out, b % 4 === 0 || b % 4 === 2 ? kick : snare, b * beat, sampleRate, 0.8);
    mixInto(out, hat, b * beat + beat / 2, sampleRate, 0.4);
  }
  return out;
}

function sounds(): Sound[] {
  const list: Sound[] = [];
  for (const sampleRate of [44100, 48000]) {
    const add = (name: string, samples: Float32Array, extra: Partial<Sound> = {}) =>
      list.push({ name: `${name} @${sampleRate}`, channels: [samples], sampleRate, ...extra });
    add('kick', synthKick(sampleRate));
    add('snare', synthSnare(sampleRate));
    add('hat', synthHat(sampleRate));
    add('open hat', synthHat(sampleRate, 3, 0.5));
    add('808', bass808(sampleRate, 48, 2));
    add('clap', clap(sampleRate));
    add('hum', synthHum(sampleRate, { hz: 196, durationSec: 0.9 }));
    add('hum glide', synthHum(sampleRate, { hz: 196, glideToHz: 98, durationSec: 0.8 }));
    add('pad', pad(sampleRate));
    add('breath', synthBreath(sampleRate, 1.4));
    add('noise', noiseFloor(sampleRate, 1, -12, 3));
    add(
      'dc offset kick',
      synthKick(sampleRate).map((v) => v + 0.2),
    );
    add('silence', new Float32Array(sampleRate));
    add('tiny', new Float32Array(16));
    add('drum loop 120', drumLoop(sampleRate, 120));
    add('drum loop 90 (named)', drumLoop(sampleRate, 90), { path: 'Loops/Drum Loop 90 BPM.wav' });
    add('kick (named)', synthKick(sampleRate), { path: 'Drums/Kick Heavy.wav' });
    add('hat (named shaker)', synthHat(sampleRate, 3, 0.06), { path: 'Perc/Shaker 02.wav' });
    add('tuned 808', bass808(sampleRate, 55, 1.5), { rootKey: 33 });
    add('one-shot named loop', synthHum(sampleRate, { hz: 220, durationSec: 2 }), {
      path: 'Melodic Loop Am 110bpm.wav',
    });
  }
  const sr = 48000;
  const left = synthHum(sr, { hz: 262, durationSec: 0.7 });
  const right = new Float32Array(left.length);
  right.set(synthKick(sr).subarray(0, left.length));
  list.push({ name: 'stereo hum and kick', channels: [left, right], sampleRate: sr });
  return list;
}

/** Rounds every number so a different platform's last-bit differences cannot fail the snapshot. */
function rounded(value: unknown): unknown {
  if (typeof value === 'number') return Math.round(value * 1e6) / 1e6;
  if (Array.isArray(value)) return value.map(rounded);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, rounded(inner)]));
  }
  return value;
}

describe('sample analysis characterization', () => {
  it('measures, scores and analyzes every sound the same way', async () => {
    const lines: string[] = [];
    for (const sound of sounds()) {
      const mono = monoMix(sound.channels, sound.sampleRate);
      const features = extractFeatures(mono, sound.sampleRate);
      lines.push(`# ${sound.name}`);
      lines.push(`features ${JSON.stringify(rounded(features))}`);
      lines.push(`scores ${JSON.stringify(rounded(categoryScores(features)))}`);
      lines.push(`onsets ${JSON.stringify(rounded(findOnsets(mono, sound.sampleRate)))}`);
      const analysis = analyzeSample(sound.channels, sound.sampleRate, { path: sound.path, rootKey: sound.rootKey });
      lines.push(`analysis ${JSON.stringify(rounded(analysis))}`);
    }
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/sample-analysis.txt');
  });

  it('reads the tempo of loops the same way', () => {
    const lines: string[] = [];
    for (const [bpm, hint] of [
      [120, {}],
      [90, {}],
      [174, { bpm: 174 }],
      [100, { bpm: 200 }],
    ] as const) {
      const sampleRate = 44100;
      const loop = drumLoop(sampleRate, bpm);
      lines.push(
        `${bpm} ${JSON.stringify(hint)}: ${JSON.stringify(loopTempo(loop, sampleRate, loop.length / sampleRate, hint))}`,
      );
    }
    expect(lines.join('\n') + '\n').toMatchInlineSnapshot(`
      "120 {}: {"bpm":120,"bars":2,"fitsBars":true}
      90 {}: {"bpm":90,"bars":2,"fitsBars":true}
      174 {"bpm":174}: {"bpm":174,"bars":2,"fitsBars":true}
      100 {"bpm":200}: {"bpm":200,"bars":4,"fitsBars":true}
      "
    `);
  });
});
