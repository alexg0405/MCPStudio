/**
 * Characterization of the voice analysis: the exact events (times, kinds, pitches, features) it finds
 * in a spread of seeded recordings: drum patterns, mixed sequences with hums, glides and legato notes,
 * a breath, clipped kicks, other sample rates, all three modes and both ends of the sensitivity range.
 *
 * It exists so the analysis can be reorganised without changing what it finds. If a deliberate change
 * makes it fail, review the snapshot diff and regenerate it with `vitest -u`.
 */
import { describe, expect, it } from 'vitest';
import { analyzeVoice, type AnalyzeOptions } from './analyze';
import {
  clipInPlace,
  drumPattern,
  mixInto,
  mulberry32,
  noiseFloor,
  renderScore,
  synthBreath,
  synthHat,
  synthHum,
  synthKick,
  type ScoreHit,
} from './test-signals';

interface Recording {
  name: string;
  samples: Float32Array;
  sampleRate: number;
  options?: AnalyzeOptions;
}

/** A random 16-step sequence of drum hits and hums (the same recipe the accuracy tests use). */
function mixedSequence(seed: number, sampleRate: number): Float32Array {
  const rand = mulberry32(seed * 7919);
  const bpm = 100 + Math.floor(rand() * 51);
  const step = 60 / bpm / 4;
  const start = 0.2 + rand() * 0.3;
  const hits: ScoreHit[] = [];
  for (let s = 0; s < 16;) {
    const r = rand();
    const time = start + s * step + (rand() * 2 - 1) * 0.008;
    if (r >= 0.86) {
      const length = 3 + Math.floor(rand() * 3);
      const hz = 80 * Math.pow(2, rand() * 2.3);
      const durationSec = Math.min(0.6, Math.max(0.25, length * step - 0.03));
      hits.push({ time, kind: 'hum', gain: 0.5 + rand() * 0.4, hum: { hz, durationSec } });
      s += length + 1;
      continue;
    }
    const kind = r < 0.4 ? 'kick' : r < 0.58 ? 'snare' : 'hat';
    const gain = kind === 'kick' ? 0.6 + rand() * 0.35 : kind === 'snare' ? 0.4 + rand() * 0.4 : 0.2 + rand() * 0.35;
    hits.push({ time, kind, gain });
    s++;
  }
  return renderScore(sampleRate, start + 17 * step + 0.5, hits, { noiseDb: -60, seed }).samples;
}

function recordings(): Recording[] {
  const list: Recording[] = [];
  const add = (name: string, samples: Float32Array, sampleRate: number, options?: AnalyzeOptions) =>
    list.push({ name, samples, sampleRate, options });

  const patterns: [number, string, number][] = [
    [100, 'k-h-s-h-k-hks-h-', 0.31],
    [128, 'k-hhs-h-k-hhs-hh', 0.4],
    [150, 'khhhshhhkhkhshhh', 0.22],
  ];
  for (const [bpm, pattern, startSec] of patterns) {
    const p = drumPattern({ sampleRate: 48000, bpm, startSec, pattern, jitterMs: 8, noiseDb: -60, seed: bpm });
    add(`pattern ${bpm} bpm`, p.samples, 48000);
  }
  for (let seed = 1; seed <= 6; seed++) add(`mixed sequence ${seed}`, mixedSequence(seed, 48000), 48000);
  for (const sampleRate of [44100, 22050, 16000])
    add(`mixed sequence 3 at ${sampleRate}`, mixedSequence(3, sampleRate), sampleRate);
  add('mixed sequence 2, drums only', mixedSequence(2, 48000), 48000, { mode: 'drums' });
  add('mixed sequence 2, tonal only', mixedSequence(2, 48000), 48000, { mode: 'tonal' });
  add('mixed sequence 4, sensitivity 0', mixedSequence(4, 48000), 48000, { sensitivity: 0 });
  add('mixed sequence 4, sensitivity 1', mixedSequence(4, 48000), 48000, { sensitivity: 1 });
  add('mixed sequence 5, wide minGap', mixedSequence(5, 48000), 48000, { minGapSec: 0.2 });

  const sr = 48000;
  const glide = renderScore(
    sr,
    1.6,
    [{ time: 0.3, kind: 'hum', gain: 0.7, hum: { hz: 110, glideToHz: 220, durationSec: 0.8 } }],
    {
      noiseDb: -65,
    },
  );
  add('glide', glide.samples, sr);
  const legato = renderScore(
    sr,
    2,
    [
      {
        time: 0.3,
        kind: 'hum',
        gain: 0.7,
        hum: {
          hz: 110,
          durationSec: 1.2,
          legato: [
            [147, 0.4],
            [98, 0.8],
          ],
        },
      },
    ],
    { noiseDb: -65 },
  );
  add('legato notes', legato.samples, sr);

  const breath = noiseFloor(sr, 1.6, -65, 5);
  mixInto(breath, synthBreath(sr), 0.4, sr, 0.5);
  mixInto(breath, synthKick(sr), 1.1, sr, 0.8);
  add('breath then kick', breath, sr);

  const clipped = noiseFloor(sr, 1.6, -65, 5);
  mixInto(clipped, clipInPlace(synthKick(sr), 6), 0.3, sr, 0.9);
  mixInto(clipped, synthHum(sr, { hz: 130, durationSec: 0.4 }), 0.9, sr, 0.8);
  add('clipped kick and hum', clipped, sr);

  const hatOverTail = noiseFloor(sr, 1.2, -65, 5);
  mixInto(hatOverTail, synthKick(sr), 0.2, sr, 0.9);
  mixInto(hatOverTail, synthHat(sr), 0.32, sr, 0.35);
  mixInto(hatOverTail, synthHat(sr), 0.8, sr, 0.009);
  add('hat over a kick tail and a quiet hat', hatOverTail, sr, { sensitivity: 1 });

  add('silence', new Float32Array(sr), sr);
  add('noise only', noiseFloor(sr, 1, -50, 3), sr);
  add('very short', new Float32Array([0.5, -0.5, 0.25]), sr);
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

describe('analyzeVoice characterization', () => {
  it('finds the same events in every recording', async () => {
    const lines: string[] = [];
    for (const recording of recordings()) {
      const events = analyzeVoice(recording.samples, recording.sampleRate, recording.options);
      lines.push(`# ${recording.name}: ${events.length} events`);
      for (const event of events) lines.push(JSON.stringify(rounded(event)));
    }
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/voice-analyze.txt');
  });
});
