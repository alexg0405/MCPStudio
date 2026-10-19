/**
 * Characterization of comping: the clips planned for seeded takes and segments (crossfades, fades, gains, seams),
 * swipes, take stepping, reading a comp back from its clips, the edits found and laid back over a rebuilt comp,
 * and shifted take parts, all exactly. It exists so comp.ts can be reorganised without changing a tick.
 *
 * If a deliberate change makes it fail, review the snapshot diff and regenerate it with `vitest -u`.
 */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../io/hash';
import { constantTempo } from '../time/ppq';
import { mulberry32 } from '../voice/test-signals';
import {
  applyCompEdits,
  findCompEdits,
  planComp,
  readComp,
  shiftTakePart,
  stepTake,
  swipeSegments,
  takeAt,
  wholeTake,
  type CompSegment,
  type CompSpan,
} from './comp';

const BAR = 3840;

/** Takes recorded over the same stretch: each a clip (sometimes two, with a gap) with its own gain and fades. */
function takes(seed: number): CompSpan[] {
  const rand = mulberry32(seed);
  const spans: CompSpan[] = [];
  const count = 2 + Math.floor(rand() * 3);
  for (let take = 0; take < count; take++) {
    const clips = rand() < 0.3 ? 2 : 1;
    let at = Math.floor(rand() * 4) * 240;
    for (let c = 0; c < clips; c++) {
      const length = 4 * BAR - Math.floor(rand() * 3) * 960 - c * BAR;
      const start = at;
      const span: CompSpan = {
        index: take,
        ref: `t${take}c${c}`,
        start,
        length,
        offsetAt: (tick) => 1.3 + (tick - start) / 2000,
      };
      if (rand() < 0.4) span.gain = 0.5 + rand() * 0.5;
      if (rand() < 0.4) span.fadeIn = 0.01 + rand() * 0.02;
      if (rand() < 0.4) span.fadeOut = 0.01 + rand() * 0.02;
      spans.push(span);
      at = start + length + 960 * (1 + Math.floor(rand() * 3));
    }
  }
  return spans;
}

function segmentsFor(seed: number, spans: readonly CompSpan[]): CompSegment[] {
  const rand = mulberry32(seed * 3);
  const takesHere = [...new Set(spans.map((s) => s.index))];
  const out: CompSegment[] = [];
  let at = 0;
  while (at < 4 * BAR) {
    const length = 480 * (1 + Math.floor(rand() * 12));
    out.push({
      take: takesHere[Math.floor(rand() * takesHere.length)] as number,
      from: at,
      to: Math.min(4 * BAR, at + length),
    });
    at += length + (rand() < 0.2 ? 240 : 0);
  }
  return out;
}

const text = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v));

/** A short fingerprint of a value's exact content, and how many items it holds. */
async function fp(value: unknown): Promise<string> {
  const hash = await sha256Hex(new TextEncoder().encode(text(value)));
  const items = Array.isArray(value) ? value.length : 0;
  return `${hash.slice(0, 12)} (${items})`;
}

describe('comp characterization', () => {
  it('plans, reads and edits comps the same way', async () => {
    const lines: string[] = [];
    for (let seed = 1; seed <= 25; seed++) {
      const spans = takes(seed);
      const segments = segmentsFor(seed, spans);
      for (const bpm of [90, 140]) {
        const tempo = constantTempo(bpm);
        for (const crossfadeSec of [undefined, 0, 0.05, 0.8]) {
          const plan = planComp(segments, spans, { tempo, crossfadeSec });
          lines.push(`#${seed} ${bpm} bpm xfade ${crossfadeSec}: ${await fp(plan)}`);
        }
      }
      const tempo = constantTempo(120);
      const plan = planComp(segments, spans, { tempo });
      lines.push(
        `#${seed} read: ${await fp(readComp(plan.map((p) => ({ start: p.start, length: p.length, take: p.take }))))}`,
      );
      const handMade = plan.map((p, i) => ({
        take: p.take,
        start: p.start,
        length: p.length,
        gain: i % 3 === 0 ? 0.7 : p.gain,
        fadeIn: i % 4 === 0 ? 0.03 : p.fadeIn,
        fadeOut: i % 5 === 0 ? 0 : p.fadeOut,
      }));
      const edits = findCompEdits(handMade, plan);
      lines.push(`#${seed} edits: ${await fp(edits)}`);
      const rebuilt = planComp(swipeSegments(segments, spans, 0, BAR, 2 * BAR), spans, { tempo });
      lines.push(`#${seed} rebuilt: ${await fp(applyCompEdits(rebuilt, edits))}`);
      lines.push(`#${seed} no edits: ${await fp(applyCompEdits(rebuilt, []))}`);
      for (const take of [0, 1]) {
        const moved = shiftTakePart(segments, edits, take, BAR, 3 * BAR, 480);
        lines.push(`#${seed} shift take ${take}: ${await fp(moved)}`);
      }
      lines.push(`#${seed} whole take 1: ${await fp(wholeTake(spans, 1))}`);
      for (const [from, to] of [
        [0, BAR],
        [BAR, 3 * BAR],
        [3 * BAR, 4 * BAR + 960],
      ] as const) {
        lines.push(
          `#${seed} [${from}, ${to}] plays take ${takeAt(segments, from, to)}, next ${stepTake(segments, spans, from, to, 1)}, previous ${stepTake(segments, spans, from, to, -1)}`,
        );
      }
    }
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/comp-plans.txt');
  });
});
