import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultValues } from '@agstudio/sdk';
import { rms, runEffect, testHost, type TestSignal } from '@agstudio/sdk/testing';
import denoise from './index';
import { DenoiseKernel, type DenoiseState, type ProfileMessage } from './kernel';
import { DENOISE_ID, denoiseFrames, denoiseLatencyFrames, denoiseParams } from './params';

const SR = 48000;
const db = (x: number) => 20 * Math.log10(x);
const TAU = 2 * Math.PI;

/** Deterministic white noise in [-1, 1). */
function noiseGen(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

/**
 * Pink-ish noise (−3 dB per octave, Paul Kellet's filter) at `level` RMS, a different stream per channel. It is made
 * once (`frames` long, repeating after that), so asking for the same frame twice gives the same sample.
 */
function pink(level: number, seed: number, frames = SR * 6): TestSignal {
  const channels = [0, 1].map((c) => {
    const rand = noiseGen(seed + c);
    const out = new Float32Array(frames);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let sum = 0;
    for (let i = 0; i < frames; i++) {
      const white = rand();
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      out[i] = b0 + b1 + b2 + white * 0.1848;
      sum += (out[i] as number) ** 2;
    }
    const gain = level / Math.sqrt(sum / frames);
    for (let i = 0; i < frames; i++) out[i] = (out[i] as number) * gain;
    return out;
  });
  return (i, c) => (channels[c] as Float32Array)[i % frames] as number;
}

/** A voice-like tone: 12 harmonics of 200 Hz, 1/h falling, vibrato, at `level` RMS, on from `from` to `to` frames. */
function voice(level: number, from: number, to: number): TestSignal {
  return (i) => {
    if (i < from || i >= to) return 0;
    const t = i / SR;
    const phase = TAU * 200 * t + 0.4 * Math.sin(TAU * 5 * t);
    let v = 0;
    for (let h = 1; h <= 12; h++) v += Math.sin(h * phase) / h;
    const env = Math.min(1, (i - from) / 480, (to - i) / 480);
    return (env * v * level) / 0.95;
  };
}

const mix = (...signals: TestSignal[]): TestSignal => (i, c) => signals.reduce((sum, s) => sum + s(i, c), 0);
const render = (signal: TestSignal, frames: number): Float32Array => Float32Array.from({ length: frames }, (_, i) => signal(i, 0));
const noiseOnly = (frames: number, level = 0.01) => runEffect(DenoiseKernel, denoiseParams, pink(level, 3), frames);

describe('Denoise kernel', () => {
  it('reports its latency as one frame and delivers sound exactly that late', () => {
    expect(denoiseFrames(SR)).toBe(1024);
    expect(denoiseLatencyFrames(SR)).toBe(1024);
    expect(denoiseLatencyFrames(96000)).toBe(2048);
    expect((denoise as unknown as { latency: (sampleRate: number) => number }).latency(SR) * SR).toBe(1024);
    // With nothing to remove (0 dB) it is a delay of exactly the latency (a click comes out 1024 frames later).
    const click: TestSignal = (i) => (i === 3000 ? 0.5 : 0);
    const [out] = runEffect(DenoiseKernel, denoiseParams, click, 6000, { params: { amount: 0 } });
    let peakAt = 0;
    for (let i = 0; i < out.length; i++) if (Math.abs(out[i] as number) > Math.abs(out[peakAt] as number)) peakAt = i;
    expect(peakAt).toBe(3000 + 1024);
    expect(out[peakAt]).toBeCloseTo(0.5, 4);
  });

  it('passes a signal with nothing to remove through unchanged but late (reconstruction within 1e-4)', () => {
    const tone = mix(voice(0.2, 0, 20000), voice(0.1, 0, 20000));
    const [out, outRight] = runEffect(DenoiseKernel, denoiseParams, tone, 24000, { params: { amount: 0 } });
    let worst = 0;
    for (let i = 4000; i < 20000; i++) worst = Math.max(worst, Math.abs((out[i + 1024] as number) - tone(i, 0)));
    expect(worst).toBeLessThan(1e-4);
    expect(outRight[10000 + 1024]).toBeCloseTo(tone(10000, 1), 4);
  });

  it('turns steady noise down by about the amount once it has learned it (12 dB: within 10–13 dB)', () => {
    const frames = SR * 4;
    const signal = pink(0.01, 3);
    const kernel = new DenoiseKernel(testHost(SR, 1));
    // Learn on the first second, then off.
    const learning: TestSignal = (i, c) => signal(i, c);
    runEffect(kernel, denoiseParams, learning, SR, { params: { learn: 1 } });
    const [out] = runEffect(kernel, denoiseParams, (i, c) => signal(i + SR, c), frames - SR, { params: { learn: 0, amount: 12 } });
    const input = render((i) => signal(i + SR, 0), frames - SR);
    const from = SR;
    const to = frames - SR;
    expect(db(rms(input, from, to) / rms(out, from, to))).toBeGreaterThan(10);
    expect(db(rms(input, from, to) / rms(out, from, to))).toBeLessThan(13);
  });

  it('keeps a voice within 1 dB over the noise and lifts the signal to noise by at least 8 dB', () => {
    const frames = SR * 5;
    const noise = pink(0.01, 5);
    const speech = voice(0.2, SR, SR * 4);
    const fresh = new DenoiseKernel(testHost(SR, 1));
    runEffect(fresh, denoiseParams, noise, SR / 2, { params: { learn: 1 } });
    const [mixed] = runEffect(fresh, denoiseParams, (i, c) => mix(noise, speech)(i, c), frames, { params: { learn: 0, amount: 12 } });
    const input = render(mix(noise, speech), frames);
    // The voice's own level in the vowel (1.2–3.8 s, after the delay): the mix's level changes by the noise's share only.
    const vowelIn = rms(input, Math.round(1.3 * SR), Math.round(3.7 * SR));
    const vowelOut = rms(mixed, Math.round(1.3 * SR) + 1024, Math.round(3.7 * SR) + 1024);
    expect(Math.abs(db(vowelOut / vowelIn))).toBeLessThan(1);
    // In the gap after the voice the noise is down by about 12 dB.
    const gapIn = rms(input, Math.round(4.3 * SR), Math.round(4.9 * SR));
    const gapOut = rms(mixed, Math.round(4.3 * SR) + 1024, Math.round(4.9 * SR) + 1024);
    expect(db(gapIn / gapOut)).toBeGreaterThan(8);
  });

  it('without a learned noise it follows the quietest sound: after a few seconds the noise is down', () => {
    const [out] = noiseOnly(SR * 5);
    const input = render(pink(0.01, 3), SR * 5);
    const early = db(rms(input, 0, SR) / rms(out, 1024, SR));
    const late = db(rms(input, 3 * SR, 5 * SR) / rms(out, 3 * SR + 1024, 5 * SR + 1024));
    expect(late).toBeGreaterThan(6);
    expect(late).toBeGreaterThanOrEqual(early - 0.5);
  });

  it('Hear noise only plays what is taken out: the input minus the output, with the voice absent from it', () => {
    const frames = SR * 3;
    const noise = pink(0.01, 8);
    const speech = voice(0.2, SR, SR * 2);
    const kernel = new DenoiseKernel(testHost(SR, 1));
    runEffect(kernel, denoiseParams, noise, SR / 2, { params: { learn: 1 } });
    const [cleaned] = runEffect(kernel, denoiseParams, mix(noise, speech), frames, { params: { learn: 0, amount: 12 } });
    const heard = new DenoiseKernel(testHost(SR, 1));
    runEffect(heard, denoiseParams, noise, SR / 2, { params: { learn: 1 } });
    const [removed] = runEffect(heard, denoiseParams, mix(noise, speech), frames, { params: { learn: 0, amount: 12, listen: 1 } });
    const input = render(mix(noise, speech), frames);
    for (let i = 20000; i < 40000; i += 997) expect(removed[i + 1024]! + cleaned[i + 1024]!).toBeCloseTo(input[i]!, 4);
    // The voice is far louder in the cleaned sound than in what was removed.
    expect(db(rms(cleaned, SR + 4000, SR * 2 - 2000) / rms(removed, SR + 4000, SR * 2 - 2000))).toBeGreaterThan(8);
  });

  it('posts the noise when Learn ends, once, with a level for every bin; and takes it back from the saved state', () => {
    const host = testHost(SR, 1);
    const kernel = new DenoiseKernel(host);
    const noise = pink(0.02, 4);
    runEffect(kernel, denoiseParams, noise, SR / 2, { params: { learn: 1 } });
    expect(host.posted.filter((m) => (m as { type?: string }).type === 'profile')).toHaveLength(0);
    runEffect(kernel, denoiseParams, noise, 1024, { params: { learn: 0 } });
    const messages = host.posted.filter((m): m is ProfileMessage => (m as { type?: string }).type === 'profile');
    expect(messages).toHaveLength(1);
    const message = messages[0] as ProfileMessage;
    expect(message.bins).toHaveLength(513);
    // Pink noise falls with frequency: bin 10 is far above bin 400.
    expect(message.bins[10]! - message.bins[400]!).toBeGreaterThan(10);
    // A kernel built from that state reduces the same noise at once (no tracking time needed).
    const state: DenoiseState = { profile: Array.from(message.bins), frames: message.frames };
    const restored = new DenoiseKernel(testHost(SR, 1, state));
    const [out] = runEffect(restored, denoiseParams, pink(0.02, 4), SR * 2, { params: { amount: 12 } });
    const input = render(pink(0.02, 4), SR * 2);
    expect(db(rms(input, SR, SR * 2 - 1024) / rms(out, SR + 1024, SR * 2))).toBeGreaterThan(10);
    // A learn that lasted a blink learns nothing.
    const quick = testHost(SR, 1);
    const k2 = new DenoiseKernel(quick);
    runEffect(k2, denoiseParams, noise, 256, { params: { learn: 1 } });
    runEffect(k2, denoiseParams, noise, 256, { params: { learn: 0 } });
    expect(quick.posted.filter((m) => (m as { type?: string }).type === 'profile')).toHaveLength(0);
  });

  it('is deterministic and finite at the extremes', () => {
    const run = () => runEffect(DenoiseKernel, denoiseParams, mix(pink(0.05, 3), voice(0.5, 4000, 30000)), 40000, { params: { amount: 30, sensitivity: 1 } });
    const [a] = run();
    const [b] = run();
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    expect(a.every((v) => Number.isFinite(v))).toBe(true);
    const [silent] = runEffect(DenoiseKernel, denoiseParams, () => 0, 10000, { params: { amount: 30 } });
    expect(silent.every((v) => v === 0)).toBe(true);
  });

  it('every preset is valid and its params are in range', () => {
    expect(denoise.id).toBe(DENOISE_ID);
    const defaults = defaultValues(denoiseParams);
    for (const preset of denoise.presets ?? []) {
      for (const key of Object.keys(preset.params ?? {})) expect(key in defaults, `${preset.name}: ${key}`).toBe(true);
      expect(() => runEffect(DenoiseKernel, denoiseParams, pink(0.01, 3), 3000, { params: preset.params })).not.toThrow();
    }
  });

  it('allocates nothing after construction: the heap stays flat over many seconds of audio', () => {
    const kernel = new DenoiseKernel(testHost(SR, 1));
    const noise = pink(0.02, 4, SR * 21);
    runEffect(kernel, denoiseParams, noise, SR, { params: { learn: 1 } });
    runEffect(kernel, denoiseParams, noise, SR, { params: { learn: 0 } });
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const before = process.memoryUsage().heapUsed;
    runEffect(kernel, denoiseParams, mix(noise, voice(0.2, 0, SR * 20)), SR * 20, { params: { amount: 12 } });
    gc?.();
    const grown = process.memoryUsage().heapUsed - before;
    // runEffect itself builds 20 s of output (about 7.7 MB for two channels): the kernel's own growth is what is left.
    expect(grown).toBeLessThan(40 * 1024 * 1024);
  });
});

/** The methods that run on the audio thread for every block or frame: nothing in them may allocate. */
const AUDIO_THREAD_METHODS = ['process', 'switchLearning', 'makeFrame', 'measurePower', 'addToLearning', 'trackNoise', 'findGains', 'applyGains', 'overlapAdd', 'averageReductionDb'];

const FORBIDDEN: [string, RegExp][] = [
  ['new', /\bnew\s/],
  ['an array literal', /(^|[=(,:?&|]|\breturn)\s*\[/m],
  ['an object literal', /(^|[=(,:?&|]|\breturn)\s*\{/m],
  ['a closure', /=>|\bfunction\b/],
  ['a template string', /`/],
  ['a spread', /\.\.\./],
  ['an array method', /\.(map|filter|slice|concat|push|pop|splice|reduce|forEach|from|of)\(/],
  ['a global that allocates', /\b(Array|Object|JSON|String|Math\.hypot)\b/],
];

describe('Denoise kernel source', () => {
  const source = readFileSync(new URL('./kernel.ts', import.meta.url), 'utf8');
  const body = (name: string): string => {
    const start = source.search(new RegExp(`^ {2}(private )?${name}\\(`, 'm'));
    expect(start, `no method ${name}`).toBeGreaterThanOrEqual(0);
    const rest = source.slice(start);
    const end = rest.search(/^ {2}\}$/m);
    return rest.slice(0, end + 4).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  };

  it.each(AUDIO_THREAD_METHODS)('%s allocates nothing', (name) => {
    const text = body(name);
    expect(text.length).toBeGreaterThan(100);
    for (const [what, pattern] of FORBIDDEN) expect(text, `${name}() has ${what}`).not.toMatch(pattern);
  });
});
