import { afterAll, describe, expect, it } from 'vitest';
import { Engine } from '@engine/engine';
import { resolver } from '../helpers/fixtures';

/**
 * Loops a known signal back through a MediaStream into the recorder (no acoustic path) to check
 * the clock math: where bar 1 lands in the recording.
 */
describe('recorder', () => {
  const engine = Engine.realtime({ plugins: resolver() });
  const ctx = engine.ctx as AudioContext;
  afterAll(() => engine.dispose());

  it('records bars after a count-in and locates bar 1 in the audio', async () => {
    await engine.resume();
    const dest = ctx.createMediaStreamDestination();
    const handle = await engine.record(dest.stream, {
      bpm: 120,
      beatsPerBar: 4,
      countInBeats: 4,
      bars: 1,
      click: false,
      inputLatency: 0,
      playAlong: false,
    });
    expect(handle.position()).toBeLessThan(0); // counting in
    // A tone burst on beat 2 of bar 1 (0.5 s after bar 1 at 120 BPM).
    const osc = new OscillatorNode(ctx, { frequency: 440 });
    const gain = new GainNode(ctx, { gain: 0.8 });
    osc.connect(gain).connect(dest);
    osc.start(handle.barOneTime + 0.5);
    osc.stop(handle.barOneTime + 0.55);

    const rec = await handle.done;
    expect(rec.sampleRate).toBe(ctx.sampleRate);
    // At least the bar and its tail (the loopback stream can start late when the machine is busy).
    expect(rec.samples.length / rec.sampleRate).toBeGreaterThan(2);
    const onset = rec.samples.findIndex((v) => Math.abs(v) > 0.2) / rec.sampleRate;
    expect(onset).toBeGreaterThan(0);
    // The recorder adds the output latency for a human answering the click; this loopback has none.
    // The loopback stream itself adds a little delay (more on a busy machine), never less.
    const latency = ctx.outputLatency || ctx.baseLatency || 0;
    const error = onset - (rec.barOneSec - latency) - 0.5;
    expect(error).toBeGreaterThan(-0.01);
    expect(error).toBeLessThan(0.15);
  });

  it('stops early and can be cancelled', async () => {
    const dest = ctx.createMediaStreamDestination();
    const opts = {
      bpm: 140,
      beatsPerBar: 4,
      countInBeats: 0,
      bars: 4,
      click: true,
      inputLatency: 0.01,
      playAlong: false,
    };
    const a = await engine.record(dest.stream, opts);
    await new Promise((r) => setTimeout(r, 300));
    a.stop();
    const rec = await a.done;
    expect(rec.samples.length / rec.sampleRate).toBeLessThan(1);
    const b = await engine.record(dest.stream, opts);
    b.cancel();
    await expect(b.done).rejects.toMatchObject({ name: 'AbortError' });
  });
});
