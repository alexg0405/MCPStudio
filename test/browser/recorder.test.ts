import { afterAll, describe, expect, it } from 'vitest';
import { Engine } from '@engine/engine';
import recorderUrl from '@engine/recorder.worklet.ts?worker&url';
import { REC_MODE, REC_STATE, RECORDER_ID } from '@engine/recorder-id';
import { resolver } from '../helpers/fixtures';

/**
 * Loops a known signal back through a MediaStream into the recorder (no acoustic path) to check
 * the clock math: where bar 1 lands in the recording.
 */
describe('recorder', { tags: ['realtime'] }, () => {
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

  it('a measured round trip replaces the output and input latency estimate (Hum to notes and the performance recorder use it)', async () => {
    const dest = ctx.createMediaStreamDestination();
    const handle = await engine.record(dest.stream, {
      bpm: 120,
      beatsPerBar: 4,
      countInBeats: 4,
      bars: 1,
      click: false,
      // The browser's estimate would say five seconds; the calibrated round trip says 200 ms and wins.
      inputLatency: 5,
      roundTrip: 0.2,
      playAlong: false,
    });
    const osc = new OscillatorNode(ctx, { frequency: 440 });
    const gain = new GainNode(ctx, { gain: 0.8 });
    osc.connect(gain).connect(dest);
    osc.start(handle.barOneTime + 0.5);
    osc.stop(handle.barOneTime + 0.55);
    const rec = await handle.done;
    const onset = rec.samples.findIndex((v) => Math.abs(v) > 0.2) / rec.sampleRate;
    // Bar 1 is placed 0.2 s after the click was sent, whatever the browser reports: this loopback has no delay.
    const error = onset - (rec.barOneSec - 0.2) - 0.5;
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

  it('keeps its timing when the input stalls (the gap becomes silence)', async () => {
    const sr = 48000;
    const length = sr / 2;
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length, sampleRate: sr });
    await ctx.audioWorklet.addModule(recorderUrl);
    const data = new SharedArrayBuffer(length * 4);
    const state = new SharedArrayBuffer(8);
    const node = new AudioWorkletNode(ctx, RECORDER_ID, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { data, state, start: new SharedArrayBuffer(8) },
    });
    node.connect(ctx.destination);
    const src = new ConstantSourceNode(ctx, { offset: 1 });
    src.connect(node);
    src.start();
    Atomics.store(new Int32Array(state), REC_STATE.mode, REC_MODE.recording);
    // The input goes away for 100 quanta (Chrome then gives the processor zero input channels).
    const [cut, back] = [128 * 50, 128 * 150];
    void ctx.suspend(cut / sr).then(() => {
      src.disconnect();
      void ctx.resume();
    });
    void ctx.suspend(back / sr).then(() => {
      src.connect(node);
      void ctx.resume();
    });
    await ctx.startRendering();
    const samples = new Float32Array(data);
    const written = Atomics.load(new Int32Array(state), REC_STATE.written);
    // Recorded through to the end on the clock, not shortened by the gap.
    expect(written).toBe(length);
    expect(samples[cut - 1]).toBe(1);
    expect(samples[(cut + back) / 2]).toBe(0);
    expect(samples[back + 128]).toBe(1);
  });
});
