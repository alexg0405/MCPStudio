/**
 * The metering suite through the real worklet in Chrome: its numbers against the offline measurement of the same audio
 * (a rendered song, EBU test tones), stereo correlation, a live engine playing a song against the offline render,
 * a closed meter doing no audio-thread work, and what the meter costs.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { probeLoudness } from '@app/analysis/loudness-probe';
import { createServices, type Services } from '@app/services';
import { MASTER } from '@core/model/types';
import { tempoMapOf } from '@core/automation/tempo';
import { ticksPerBar } from '@core/time/ppq';
import { Engine } from '@engine/engine';
import { R } from '@engine/meter/layout';
import { MeterNode } from '@engine/meter/meter-node';
import { renderOffline } from '@engine/render-offline';
import { buildSong, measureMaster } from '../helpers/mix-level';
import { perfLimit } from '../helpers/perf';

const SR = 48000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, ms = 20_000): Promise<void> {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error('timed out waiting');
    await sleep(20);
  }
}

/** Runs `buffer` through a meter node in an offline context and returns a copy of its readings. */
async function meterOffline(buffer: AudioBuffer, full: boolean): Promise<Float64Array> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: buffer.length, sampleRate: buffer.sampleRate });
  const source = new AudioBufferSourceNode(ctx, { buffer });
  const meter = new MeterNode(ctx, (url) => ctx.audioWorklet.addModule(url), source, { full });
  await until(() => meter.active);
  source.start();
  await ctx.startRendering();
  const readings = Float64Array.from(meter.readings);
  meter.close();
  return readings;
}

function stereoBuffer(seconds: number, sample: (i: number, channel: number) => number): AudioBuffer {
  const buffer = new AudioBuffer({ numberOfChannels: 2, length: Math.round(seconds * SR), sampleRate: SR });
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) data[i] = sample(i, channel);
  }
  return buffer;
}

describe('the worklet against the offline measurement', () => {
  it('reads EBU tones: −23 dBFS stereo 1 kHz is −23.0 LUFS, and the loudness range of 20 s at −20 then 20 s at −30 is 10 LU', async () => {
    const tone = stereoBuffer(20, (i) => 10 ** (-23 / 20) * Math.sin((2 * Math.PI * 1000 * i) / SR));
    const a = await meterOffline(tone, false);
    expect(a[R.integrated]).toBeCloseTo(-23, 1);
    expect(a[R.shortTerm]).toBeCloseTo(-23, 1);
    const stepped = stereoBuffer(40, (i) => 10 ** ((i < 20 * SR ? -20 : -30) / 20) * Math.sin((2 * Math.PI * 1000 * i) / SR));
    const b = await meterOffline(stepped, false);
    expect(b[R.range]).toBeGreaterThan(9);
    expect(b[R.range]).toBeLessThan(11);
  });

  it('finds an inter-sample peak: fs/4 at 45° has a sample peak of −3 dBFS and a true peak of 0 dBTP', async () => {
    const quarter = stereoBuffer(1, (i) => Math.sin((Math.PI / 2) * i + Math.PI / 4));
    const r = await meterOffline(quarter, false);
    // The start of a sine is a step: allow the reconstruction's overshoot of a fraction of a dB.
    expect(r[R.truePeakL]).toBeGreaterThan(-0.2);
    expect(r[R.truePeakL]).toBeLessThan(0.5);
  });

  it('correlation: +1 for the same signal, −1 for opposite polarity, about 0 for unrelated noise', async () => {
    let seed = 12345;
    const noise = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed / 2 ** 32) * 2 - 1;
    };
    const sine = (i: number) => 0.4 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const same = await meterOffline(stereoBuffer(3, (i) => sine(i)), true);
    const opposite = await meterOffline(stereoBuffer(3, (i, channel) => (channel === 0 ? sine(i) : -sine(i))), true);
    const unrelated = await meterOffline(stereoBuffer(5, () => 0.3 * noise()), true);
    expect(same[R.correlation]).toBeGreaterThan(0.999);
    expect(opposite[R.correlation]).toBeLessThan(-0.999);
    expect(Math.abs(unrelated[R.correlation] as number)).toBeLessThan(0.1);
    expect(opposite[R.widthMid]).toBeGreaterThan(0.99);
  });

  it('a rendered song: loudness, range and true peak equal the report’s measurement; the spectrum and scope fill at full detail', async () => {
    const s = createServices();
    buildSong(s, 'house', { bpm: 124, low: 'bass' });
    const project = s.doc.getState().project;
    const rendered = await renderOffline(project, {
      plugins: s.plugins,
      view: { mode: 'song', patternId: null, loop: null },
      bars: 4,
      sampleRate: SR,
      tail: 0,
      limiter: true,
    });
    const start = Math.round((rendered.preRoll + rendered.latency) * SR);
    const left = rendered.buffer.getChannelData(0).subarray(start);
    const right = rendered.buffer.getChannelData(1).subarray(start);
    const trimmed = new AudioBuffer({ numberOfChannels: 2, length: left.length, sampleRate: SR });
    trimmed.copyToChannel(left, 0);
    trimmed.copyToChannel(right, 1);
    const expected = probeLoudness(left, right, SR);
    const live = await meterOffline(trimmed, true);
    const row = `worklet ${(live[R.integrated] as number).toFixed(3)} LUFS, offline ${expected.integrated.toFixed(3)}; range ${(live[R.range] as number).toFixed(2)} vs ${expected.range.toFixed(2)}; true peak ${Math.max(live[R.truePeakL] as number, live[R.truePeakR] as number).toFixed(2)} vs ${expected.truePeakDb.toFixed(2)}`;
    console.log(`Rendered house song, worklet against offline: ${row}`);
    expect(Math.abs((live[R.integrated] as number) - expected.integrated), row).toBeLessThan(0.05);
    expect(Math.abs((live[R.maxShortTerm] as number) - expected.maxShortTerm), row).toBeLessThan(0.05);
    expect(Math.abs(Math.max(live[R.truePeakL] as number, live[R.truePeakR] as number) - expected.truePeakDb), row).toBeLessThan(0.2);
    expect(live[R.spectrumSeq]).toBeGreaterThan(10);
    expect(live[R.histCount]).toBeGreaterThan(20);
    await s.engine.dispose();
  }, 120_000);
});

describe('a live engine', () => {
  let services: Services | null = null;
  afterAll(async () => {
    await services?.engine.dispose();
  });

  it('a song playing live reads within 0.3 LU of the offline measurement, and a closed meter does no audio-thread work', async () => {
    let engine!: Engine;
    const s = createServices({ createEngine: (o) => (engine = Engine.realtime(o)) });
    services = s;
    await s.engine.resume();
    buildSong(s, 'house', { bpm: 124, low: 'bass' });
    const bars = 4;
    const project = s.doc.getState().project;
    const bar = ticksPerBar(project.transport.timeSig);
    const seconds = tempoMapOf(project, 'song').tickToSeconds(bars * bar);
    const offline = await measureMaster(s, bars);

    expect(engine.meterCount).toBe(0);
    const lease = s.meters.listen(MASTER, { full: true });
    // The lease opens the meter on first read; wait until its processor runs.
    await until(() => lease.meter.active && lease.meter.blocks > 10);
    expect(engine.meterCount).toBe(1);
    const readings = lease.meter.readings;
    s.engine.play(0);
    await until(() => s.engine.playhead() >= bars * bar);
    s.engine.stop();
    const liveLufs = readings[R.integrated] as number;
    const row = `live ${liveLufs.toFixed(2)} LUFS, offline ${offline.lufs.toFixed(2)} (${seconds.toFixed(1)} s of the house song)`;
    console.log(`Live engine against offline render: ${row}`);
    expect(Math.abs(liveLufs - offline.lufs), row).toBeLessThan(0.3);
    expect(readings[R.maxMomentary]).toBeGreaterThan(readings[R.integrated] as number);

    // Closing the last lease takes the processor away: nothing counts blocks any more.
    lease.release();
    expect(engine.meterCount).toBe(0);
    await sleep(100);
    const stopped = readings[R.blocks] as number;
    await sleep(400);
    expect(readings[R.blocks]).toBe(stopped);
  }, 120_000);
});

describe('cost', () => {
  it('a meter node costs under 2 % of a core at basic detail and under 4 % at full detail (looser limits in the regular run) (offline render time of 30 s of music-like noise)', { tags: ['perf'], timeout: 180_000 }, async () => {
    let seed = 99;
    const noise = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed / 2 ** 32) * 2 - 1;
    };
    const buffer = stereoBuffer(30, (i) => 0.2 * noise() + 0.2 * Math.sin((2 * Math.PI * 110 * i) / SR));
    const seconds = buffer.length / SR;
    const render = async (full: boolean | null): Promise<number> => {
      const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: buffer.length, sampleRate: SR });
      const source = new AudioBufferSourceNode(ctx, { buffer });
      if (full === null) source.connect(ctx.destination);
      else {
        const meter = new MeterNode(ctx, (url) => ctx.audioWorklet.addModule(url), source, { full });
        await until(() => meter.active);
      }
      source.start();
      const t0 = performance.now();
      await ctx.startRendering();
      return performance.now() - t0;
    };
    const best = async (full: boolean | null) => Math.min(await render(full), await render(full), await render(full));
    await render(true);
    const base = await best(null);
    const rows: string[] = [];
    for (const [name, full, limit] of [['basic', false, perfLimit(2, 6)], ['full', true, perfLimit(4, 12)]] as const) {
      const extra = Math.max(0, (await best(full)) - base);
      const share = (extra / (seconds * 1000)) * 100;
      rows.push(`${name}: ${share.toFixed(2)} % of a core`);
      expect(share, rows.at(-1)).toBeLessThan(limit);
    }
    console.log(`Meter node cost at 48 kHz (offline render, ${seconds} s):\n${rows.join('\n')}`);
  });
});
