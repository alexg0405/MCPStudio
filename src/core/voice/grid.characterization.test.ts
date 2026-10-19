/**
 * Characterization of the step grid: the tempo estimated from seeded onset lists, the steps events are
 * quantized to (with swing, 1/32 resolution, bar limits and other meters) and the text summary of the
 * result, all exactly. It exists so the grid code can be reorganised without changing what it finds.
 *
 * If a deliberate change makes it fail, review the snapshot diff and regenerate it with `vitest -u`.
 */
import { describe, expect, it } from 'vitest';
import type { VoiceEvent, VoiceKind } from './analyze';
import { describeEvents, estimateBpm, quantizeToGrid, type QuantizeOptions } from './grid';
import { mulberry32 } from './test-signals';

function voiceEvent(time: number, kind: VoiceKind, rand: () => number): VoiceEvent {
  const tonal = kind === 'tonal';
  const pitch = tonal ? 36 + Math.round(rand() * 12) + (rand() < 0.3 ? 0.4 : 0) : null;
  return {
    time,
    duration: 0.03 + rand() * 0.3,
    strength: rand(),
    kind,
    confidence: 0.2 + rand() * 0.8,
    pitch,
    pitchEnd: pitch === null ? null : pitch + (rand() < 0.4 ? 3 : 0),
    features: { centroid: 0, lowRatio: 0, highRatio: 0, zcr: 0, periodicity: 0 },
  };
}

/** Events on a groove at `bpm` with timing jitter; a mix of kinds, some doubled on a step. */
function groove(seed: number, bpm: number, jitterMs: number, startSec: number, steps = 40): VoiceEvent[] {
  const rand = mulberry32(seed);
  const stepSec = 60 / bpm / 4;
  const kinds: VoiceKind[] = ['kick', 'snare', 'hat', 'hat', 'tonal'];
  const events: VoiceEvent[] = [];
  for (let s = 0; s < steps; s++) {
    if (rand() < 0.45) continue;
    const kind = kinds[Math.floor(rand() * kinds.length)] as VoiceKind;
    const swung = s % 2 === 1 ? stepSec * 0.15 : 0;
    const jitter = ((rand() * 2 - 1) * jitterMs) / 1000;
    events.push(voiceEvent(startSec + s * stepSec + swung + jitter, kind, rand));
    if (rand() < 0.1) events.push(voiceEvent(startSec + s * stepSec + jitter + 0.01, kind, rand));
    if (rand() < 0.08) events.push(voiceEvent(startSec + (s + 0.5) * stepSec + jitter, 'hat', rand));
  }
  return events;
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

describe('step grid characterization', () => {
  it('estimates the same tempo for every groove', () => {
    const lines: string[] = [];
    for (const bpm of [70, 84, 90, 100, 110, 120, 128, 140, 150, 174]) {
      for (const jitter of [0, 12, 30]) {
        const events = groove(bpm + jitter, bpm, jitter, 0.31);
        lines.push(
          `${bpm} bpm, ±${jitter} ms: ${estimateBpm(events)} (range 60–200: ${estimateBpm(events, { min: 60, max: 200 })})`,
        );
      }
    }
    lines.push(`two events: ${estimateBpm(groove(1, 120, 0, 0).slice(0, 2))}`);
    lines.push(`none: ${estimateBpm([])}`);
    expect(lines.join('\n') + '\n').toMatchSnapshot();
  });

  it('quantizes and describes the same way', async () => {
    const lines: string[] = [];
    const options: [string, QuantizeOptions][] = [
      ['plain', {}],
      ['swing .4', { swing: 0.4 }],
      ['1/32', { resolution: 0.5 }],
      ['1/32 swing .2', { resolution: 0.5, swing: 0.2 }],
    ];
    for (const [bpm, seed, startSec] of [
      [96, 11, 0.2],
      [128, 12, 0.437],
      [150, 13, 0],
    ] as const) {
      const events = groove(seed, bpm, 18, startSec);
      for (const [label, opts] of options) {
        const quantized = quantizeToGrid(events, { bpm, startSec }, opts);
        lines.push(`# ${bpm} bpm ${label}: ${quantized.length} events`);
        lines.push(
          JSON.stringify(
            rounded(quantized.map((q) => [q.step, q.lengthSteps, q.kind, q.offsetMs, q.strength, q.pitch])),
          ),
        );
        lines.push(describeEvents(quantized));
      }
      const limited = quantizeToGrid(events, { bpm, startSec, bars: 2 });
      lines.push(`# ${bpm} bpm 2 bars: ${limited.length} events`);
      lines.push(describeEvents(limited));
      const waltz = quantizeToGrid(events, { bpm, startSec, beatsPerBar: 3, stepsPerBeat: 2 });
      lines.push(`# ${bpm} bpm 3/4 at 2 steps: ${waltz.length} events`);
      lines.push(describeEvents(waltz, { stepsPerBar: 6, stepsPerBeat: 2 }));
    }
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/voice-grid.txt');
  });
});
