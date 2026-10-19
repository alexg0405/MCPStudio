/**
 * Characterization of take planning: the takes planned for seeded recordings (loops, punches, late captures, short
 * passes, tempos) and the trims, all exactly. It exists so takes.ts can be reorganised without changing a tick.
 *
 * If a deliberate change makes it fail, review the snapshot diff and regenerate it with `vitest -u`.
 */
import { describe, expect, it } from 'vitest';
import { constantTempo } from '../time/ppq';
import { mulberry32 } from '../voice/test-signals';
import {
  audibleTake,
  frameAtTick,
  planTakes,
  tickAtFrame,
  trimToTakes,
  type CaptureAnchor,
  type TakeInput,
} from './takes';

const BAR = 3840;
const SR = 48000;

function recording(seed: number): TakeInput {
  const rand = mulberry32(seed);
  const bpm = 90 + Math.floor(rand() * 60);
  const tempo = constantTempo(bpm);
  const hasLoop = rand() < 0.75;
  const loop = hasLoop ? { start: BAR * Math.floor(rand() * 3), end: 0 } : null;
  if (loop) loop.end = loop.start + BAR * (1 + Math.floor(rand() * 3));
  const startTick = loop
    ? loop.start + (rand() < 0.3 ? -BAR : Math.floor(rand() * 4) * 960)
    : Math.floor(rand() * 3) * 960;
  const passes = loop ? 1 + Math.floor(rand() * 4) : 1;
  const anchors: CaptureAnchor[] = [];
  const passFrames = loop
    ? Math.round(tempo.tickToSeconds(loop.end) * SR - tempo.tickToSeconds(loop.start) * SR)
    : 6 * SR;
  let frame = rand() < 0.2 ? 5000 : 0;
  for (let pass = 0; pass < passes; pass++) {
    const from = pass === 0 ? startTick : (loop?.start ?? startTick);
    for (let a = 0; a < 3; a++) {
      anchors.push({
        frame: frame + a * Math.floor(passFrames / 3),
        tick: from + a * Math.floor((passFrames / 3 / SR) * (bpm / 60) * 960),
        iter: pass + 3,
      });
    }
    frame += passFrames;
  }
  const punch =
    rand() < 0.4
      ? { start: (loop?.start ?? 0) + 960, end: (loop?.start ?? 0) + BAR - 960 }
      : rand() < 0.1
        ? null
        : undefined;
  return {
    anchors,
    sampleRate: SR,
    frames: frame - Math.floor(rand() * 0.4 * passFrames),
    tempo,
    loop,
    punch,
    startTick,
    endTick: rand() < 0.3 ? startTick + 5 * BAR : undefined,
    minTicks: rand() < 0.2 ? 960 : undefined,
  };
}

describe('take planning characterization', () => {
  it('plans the same takes for every recording', () => {
    const lines: string[] = [];
    for (let seed = 1; seed <= 80; seed++) {
      const input = recording(seed);
      const takes = planTakes(input);
      lines.push(
        `#${seed}: ${JSON.stringify(takes.map((t) => [t.pass, t.start, t.length, Math.round(t.offsetSec * 1e6) / 1e6, t.complete]))} audible ${audibleTake(takes)}`,
      );
      const trimmed = trimToTakes(takes, input.tempo, SR, input.frames, seed % 2 ? 1 : 0.25);
      lines.push(
        `#${seed} trim: ${trimmed.from}-${trimmed.to} ${JSON.stringify(trimmed.takes.map((t) => Math.round(t.offsetSec * 1e6) / 1e6))}`,
      );
      const anchors = input.anchors;
      lines.push(
        `#${seed} frame at ${anchors[0]!.tick + 700}: ${frameAtTick(anchors, input.tempo, SR, anchors[0]!.tick + 700)}, tick at frame 12345: ${tickAtFrame(anchors, input.tempo, SR, 12345)}`,
      );
    }
    expect(lines.join('\n') + '\n').toMatchSnapshot();
  });
});
