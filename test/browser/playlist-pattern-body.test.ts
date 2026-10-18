/**
 * The notes drawn inside a pattern clip on the playlist (headless Chrome): the cached per-zoom paths
 * look the same as drawing every note of every repeat straight onto the canvas (the way it was drawn
 * before), at several zooms, offsets and repeats, and a pattern used by many clips is drawn quickly.
 */
import { describe, expect, it } from 'vitest';
import type { ChannelId, Note, Pattern, PatternClip, TimeSignature } from '@core/model/types';
import { newId } from '@core/model/ids';
import { Rng } from '@agstudio/sdk/dsp/random';
import { Viewport } from '@ui/timeline/viewport';
import { drawPatternBody } from '@ui/features/playlist/pattern-body';
import type { ClipPaint } from '@ui/features/playlist/clip-paint';

const TS: TimeSignature = { num: 4, den: 4 };
const BAR = 3840;
const W = 700;
const H = 160;
const VEL_STEPS = [0.45, 0.65, 0.82, 1] as const;

function makePattern(count: number, bars: number, seed: number, longNotes = false): Pattern {
  const rng = new Rng(seed);
  const notes: Record<string, Note> = {};
  for (let i = 0; i < count; i++) {
    const id = newId.note();
    const length = longNotes ? 240 + Math.floor(rng.next() * bars * BAR) : 120 + Math.floor(rng.next() * 960);
    // Notes stay inside the pattern, except the long ones (they run into the next repeat).
    const room = longNotes ? bars * BAR * 0.98 : bars * BAR - length;
    notes[id] = { id, tick: Math.floor(rng.next() * room), length, key: 40 + Math.floor(rng.next() * 40), velocity: 0.2 + rng.next() * 0.8 };
  }
  return {
    id: newId.pattern(),
    name: 'P',
    color: '#4aa3ff',
    stepCount: 16,
    length: bars * BAR,
    notes: { ch_a: notes },
  } as unknown as Pattern;
}

/** The previous drawing, kept here as the reference: every note of every repeat into one path per step. */
function drawReference(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  pattern: Pattern,
  clip: PatternClip,
  x: number,
  w: number,
  y: number,
  h: number,
  paint: ClipPaint,
): void {
  const all = Object.values(pattern.notes['ch_a' as ChannelId] as Record<string, Note>).sort((a, b) => a.tick - b.tick);
  let lo = 127;
  let hi = 0;
  for (const n of all) {
    lo = Math.min(lo, n.key);
    hi = Math.max(hi, n.key);
  }
  const length = pattern.length as number;
  const range = Math.max(8, hi - lo + 1);
  const rowH = Math.max(1, Math.min(4, h / range - (h / range > 2.5 ? 0.6 : 0)));
  const ppt = vp.pxPerTick;
  const round = rowH >= 2;
  const left = Math.max(x, 0);
  const right = Math.min(x + w, vp.width);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 1, y, w - 2, h);
  ctx.clip();
  ctx.fillStyle = paint.content;
  const base = ctx.globalAlpha;
  for (let level = 0; level < VEL_STEPS.length; level++) {
    const lov = level === 0 ? -1 : (VEL_STEPS[level - 1] as number);
    const hiv = VEL_STEPS[level] as number;
    let any = false;
    ctx.beginPath();
    for (let rep = Math.floor(clip.offset / length); rep * length < clip.offset + clip.length; rep++) {
      const repStart = clip.start - clip.offset + rep * length;
      for (const n of all) {
        const v = n.velocity;
        if (level < VEL_STEPS.length - 1 ? v <= lov || v > hiv : v <= lov) continue;
        const s = repStart + n.tick;
        if (s + n.length < clip.start || s >= clip.start + clip.length) continue;
        const nx = vp.tickToX(s);
        const nw = Math.max(1.5, n.length * ppt - 1);
        if (nx > right || nx + nw < left) continue;
        const ny = y + h - ((n.key - lo + 1 + (range - (hi - lo + 1)) / 2) / range) * h;
        if (round && nw >= 3) ctx.roundRect(nx, ny, nw, rowH, Math.min(rowH / 2, nw / 2));
        else ctx.rect(nx, ny, nw, rowH);
        any = true;
      }
    }
    if (!any) continue;
    ctx.globalAlpha = base * (0.4 + 0.6 * hiv);
    ctx.fill();
  }
  ctx.globalAlpha = base;
  ctx.restore();
}

const canvas = () => {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#202428';
  ctx.fillRect(0, 0, W, H);
  return ctx;
};

/** Mean difference per channel (0-255) between two canvases, and the share of pixels off by a lot. */
function difference(a: CanvasRenderingContext2D, b: CanvasRenderingContext2D): { mean: number; bad: number } {
  const da = a.getImageData(0, 0, W, H).data;
  const db = b.getImageData(0, 0, W, H).data;
  let sum = 0;
  let bad = 0;
  for (let i = 0; i < da.length; i += 4) {
    const d = Math.abs((da[i] as number) - (db[i] as number)) + Math.abs((da[i + 1] as number) - (db[i + 1] as number)) + Math.abs((da[i + 2] as number) - (db[i + 2] as number));
    sum += d / 3;
    if (d / 3 > 40) bad++;
  }
  return { mean: sum / (W * H), bad: bad / (W * H) };
}

const paint = { content: '#e8eef5' } as unknown as ClipPaint;

describe('pattern clip body (UI)', { timeout: 60_000 }, () => {
  const cases: { name: string; ppt: number; scroll: number; clip: Partial<PatternClip>; bars: number; long?: boolean; picture?: boolean }[] = [
    // Drawn as a picture per repeat, on whole pixels: dense random notes may shift by up to a pixel.
    { name: 'zoomed out, a clip of several repeats', ppt: 0.011, scroll: 0, clip: { start: BAR, length: 24 * BAR }, bars: 4, picture: true },
    { name: 'mid zoom, a clip starting inside its pattern (offset)', ppt: 0.05, scroll: 2 * BAR, clip: { start: 3 * BAR, length: 9 * BAR, offset: BAR + 700 }, bars: 4 },
    { name: 'zoomed in, scrolled into the middle of a long clip', ppt: 0.15, scroll: 30 * BAR, clip: { start: 0, length: 64 * BAR }, bars: 2 },
    { name: 'notes longer than the pattern', ppt: 0.04, scroll: 0, clip: { start: 2 * BAR, length: 8 * BAR }, bars: 1, long: true },
  ];
  for (const c of cases) {
    it(`looks like the plain drawing: ${c.name}`, () => {
      const pattern = makePattern(1500, c.bars, 7, c.long);
      const vp = new Viewport(10, 0.001, 2);
      vp.width = W;
      vp.height = H;
      vp.pxPerTick = c.ppt;
      vp.scrollTick = c.scroll;
      const clip = { kind: 'pattern', id: newId.clip(), laneId: 'lane', patternId: pattern.id, offset: 0, ...c.clip } as PatternClip;
      const x = vp.tickToX(clip.start);
      const w = clip.length * c.ppt;
      const fresh = canvas();
      const ref = canvas();
      drawPatternBody(fresh, vp, pattern, TS, clip, x, w, 10, H - 20, paint);
      drawReference(ref, vp, pattern, clip, x, w, 10, H - 20, paint);
      const d = difference(fresh, ref);
      expect(d.mean).toBeLessThan(c.picture ? 6 : 0.6);
      expect(d.bad).toBeLessThan(c.picture ? 0.08 : 0.01);
      // A second draw uses the cached paths and looks the same.
      const again = canvas();
      drawPatternBody(again, vp, pattern, TS, clip, x, w, 10, H - 20, paint);
      expect(difference(again, fresh).mean).toBe(0);
    });
  }

  it('draws a 3000-note pattern used by 60 clips much faster than note by note', () => {
    const pattern = makePattern(3000, 4, 11);
    const vp = new Viewport(10, 0.001, 2);
    vp.width = W;
    vp.height = H;
    vp.pxPerTick = 0.011;
    const clips = Array.from({ length: 60 }, (_, i) => ({ kind: 'pattern', id: newId.clip(), laneId: 'lane', patternId: pattern.id, offset: 0, start: (i % 6) * 4 * BAR, length: 4 * BAR }) as PatternClip);
    const time = (draw: (ctx: CanvasRenderingContext2D, c: PatternClip) => void) => {
      const ctx = canvas();
      const t0 = performance.now();
      for (let frame = 0; frame < 5; frame++) for (const c of clips) draw(ctx, c);
      ctx.getImageData(0, 0, 1, 1);
      return performance.now() - t0;
    };
    const geometry = (c: PatternClip) => [vp.tickToX(c.start), c.length * vp.pxPerTick] as const;
    const reference = time((ctx, c) => drawReference(ctx, vp, pattern, c, geometry(c)[0], geometry(c)[1], 10, H - 20, paint));
    const cached = time((ctx, c) => drawPatternBody(ctx, vp, pattern, TS, c, geometry(c)[0], geometry(c)[1], 10, H - 20, paint));
    expect(cached).toBeLessThan(reference / 4);
  });
});
