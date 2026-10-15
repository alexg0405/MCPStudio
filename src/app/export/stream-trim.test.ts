import { describe, expect, it } from 'vitest';
import { StreamTrimmer } from './stream-trim';

/** A render: silence, music (1.0) from `start` for `music` frames, a tail (0.5) of `tail` frames, silence. */
function render(total: number, start: number, music: number, tail: number): Float32Array[] {
  const x = new Float32Array(total);
  for (let i = start; i < start + music; i++) x[i] = 1;
  for (let i = start + music; i < start + music + tail; i++) x[i] = 0.5;
  return [x, x.slice()];
}

function run(t: StreamTrimmer, channels: Float32Array[], piece: number): Float32Array {
  const out: number[] = [];
  const total = channels[0]!.length;
  for (let f = 0; f < total; f += piece)
    for (const p of t.push(channels.map((c) => c.slice(f, f + piece)), f)) out.push(...p[0]!);
  for (const p of t.finish(total)) out.push(...p[0]!);
  return new Float32Array(out);
}

describe('StreamTrimmer', () => {
  it('keeps the music and the audible tail plus 10 ms, however the render is split', () => {
    const r = render(1000, 100, 300, 50);
    for (const piece of [1, 7, 64, 1000]) {
      const out = run(new StreamTrimmer(100, 300, { extra: 10 }), r, piece);
      expect(out.length).toBe(300 + 50 + 10);
      expect(out[0]).toBe(1);
      expect(out[299]).toBe(1);
      expect(out[349]).toBe(0.5);
      expect(out[350]).toBe(0);
    }
  });

  it('keeps all the music even when it ends in silence, and stops at the end of the render', () => {
    const quiet = render(500, 100, 0, 0);
    expect(run(new StreamTrimmer(100, 300, { extra: 10 }), quiet, 33).length).toBe(310);
    const loudToTheEnd = render(420, 100, 300, 100);
    expect(run(new StreamTrimmer(100, 300, { extra: 10 }), loudToTheEnd, 50).length).toBe(320);
  });

  it('gives exactly the fixed length (stems), padding with silence', () => {
    const r = render(400, 100, 300, 0);
    expect(run(new StreamTrimmer(100, 300, { length: 250, extra: 10 }), r, 64).length).toBe(250);
    const short = run(new StreamTrimmer(100, 300, { length: 450, extra: 10 }), r, 64);
    expect(short.length).toBe(450);
    expect(short[449]).toBe(0);
  });
});
