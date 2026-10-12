import { expect, it } from 'vitest';

// Proves the browser test project runs in real Chrome with a working Web Audio implementation.
it('renders audio offline in Chrome', async () => {
  const sampleRate = 48000;
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: sampleRate / 10, sampleRate });
  const osc = new OscillatorNode(ctx, { frequency: 440 });
  osc.connect(ctx.destination);
  osc.start(0);
  const buffer = await ctx.startRendering();
  const data = buffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] ?? 0));
  expect(peak).toBeGreaterThan(0.9);
  expect(typeof AudioWorkletNode).toBe('function');
});
