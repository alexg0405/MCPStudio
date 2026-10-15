import { defineEffect, type PluginHost } from '@agstudio/sdk';
import processor from './reverb.worklet.ts?worker&url';
import { generateReverbIR } from './ir.kernel';
import { REVERB_ID, reverbParams, reverbTail, type ReverbEngine } from './params';

/** Crossfade between the old and the new impulse response, seconds. */
const XFADE = 0.12;
/** Knob drags regenerate the IR this long after the last change. */
const DEBOUNCE_MS = 150;
/** Crossfade when the Engine changes, seconds. */
const ENGINE_XFADE = 0.05;

type Host = PluginHost<typeof reverbParams, undefined>;

// Recently used impulse responses (AudioBuffers aren't tied to a context, so instances share them).
const irCache = new Map<string, AudioBuffer>();

function impulse(sampleRate: number, decay: number, damping: number, size: number): AudioBuffer {
  const key = `${sampleRate}|${decay}|${damping}|${size}`;
  const hit = irCache.get(key);
  if (hit) {
    irCache.delete(key);
    irCache.set(key, hit);
    return hit;
  }
  const [l, r] = generateReverbIR({ sampleRate, decay, damping, size });
  const buffer = new AudioBuffer({ numberOfChannels: 2, length: l.length, sampleRate });
  buffer.copyToChannel(l, 0);
  buffer.copyToChannel(r, 1);
  irCache.set(key, buffer);
  for (const old of irCache.keys()) {
    if (irCache.size <= 6) break;
    irCache.delete(old);
  }
  return buffer;
}

/**
 * The convolution engine: a procedurally generated stereo impulse response (see ir.kernel.ts).
 * Decay, damping and size changes regenerate the IR (debounced while playing, immediately during an
 * export) into a second ConvolverNode and crossfade to it, because swapping a convolver's buffer in
 * place would click and cut its tail. Built only while the Engine is Convolution.
 */
function convolution(host: Host) {
  const ac = host.audioContext;
  const P = host.params;
  const input = new GainNode(ac);
  const output = new GainNode(ac);
  const dry = new GainNode(ac);
  const wet = new GainNode(ac);
  const preDelay = new DelayNode(ac, { maxDelayTime: 0.5, delayTime: P.preDelay.value });
  const offs = [
    P.preDelay.bind(preDelay.delayTime),
    // Equal-power dry/wet.
    P.mix.bind(dry.gain, (m) => Math.cos((m * Math.PI) / 2)),
    P.mix.bind(wet.gain, (m) => Math.sin((m * Math.PI) / 2)),
  ];
  input.connect(dry).connect(output);
  input.connect(preDelay);
  wet.connect(output);

  const lanes = [0, 1].map(() => {
    const conv = new ConvolverNode(ac, { disableNormalization: true });
    const gain = new GainNode(ac, { gain: 0 });
    conv.connect(gain).connect(wet);
    return { conv, gain, fed: false };
  });
  type Lane = (typeof lanes)[number];
  const feed = (lane: Lane, on: boolean) => {
    if (lane.fed === on) return;
    lane.fed = on;
    if (on) preDelay.connect(lane.conv);
    else preDelay.disconnect(lane.conv);
  };
  const build = () => impulse(ac.sampleRate, P.decay.value, P.damping.value, P.size.value);

  let active = 0;
  const first = lanes[0] as Lane;
  first.conv.buffer = build();
  first.gain.gain.value = 1;
  feed(first, true);

  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };
  let pending: ReturnType<typeof setTimeout> | null = null;

  const regenerate = () => {
    const buffer = build();
    const from = lanes[active] as Lane;
    if (from.conv.buffer === buffer) return;
    if (host.offline || ac.currentTime === 0) {
      from.conv.buffer = buffer;
      return;
    }
    const to = lanes[1 - active] as Lane;
    feed(to, true);
    to.conv.buffer = buffer;
    const t = ac.currentTime;
    from.gain.gain.cancelAndHoldAtTime(t);
    from.gain.gain.linearRampToValueAtTime(0, t + XFADE);
    to.gain.gain.cancelScheduledValues(t);
    to.gain.gain.setValueAtTime(0, t);
    to.gain.gain.linearRampToValueAtTime(1, t + XFADE);
    active = 1 - active;
    // The faded-out convolver stops receiving input (saves CPU) once the fade is over.
    later(XFADE * 1000 + 60, () => {
      if (lanes[active] !== from) feed(from, false);
    });
  };
  const changed = () => {
    if (host.offline) {
      regenerate();
      return;
    }
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      regenerate();
    }, DEBOUNCE_MS);
  };
  offs.push(P.decay.onChange(changed), P.damping.onChange(changed), P.size.onChange(changed));

  return {
    input,
    output,
    reset() {
      // Setting the buffer again clears the convolver's tail.
      const lane = lanes[active] as Lane;
      const buffer = lane.conv.buffer;
      if (buffer) lane.conv.buffer = buffer;
    },
    dispose() {
      if (pending) clearTimeout(pending);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const off of offs) off();
      for (const lane of lanes) {
        lane.conv.disconnect();
        lane.gain.disconnect();
      }
      for (const n of [input, output, dry, wet, preDelay]) n.disconnect();
    },
  };
}

/**
 * Two engines behind the same knobs. Algorithmic (the default): the AudioWorklet kernel in
 * kernel.ts, a feedback delay network whose cost doesn't depend on Decay, with the mix inside it.
 * Convolution: the original ConvolverNode engine, built only while chosen. Switching crossfades
 * the two; the one faded out stops getting input (an unfed kernel sleeps once its tail is over).
 */
export default defineEffect({
  id: REVERB_ID,
  name: 'Reverb',
  version: 1,
  category: 'Reverb',
  description:
    'Stereo reverb: decay, pre-delay, damping and room size. The algorithmic engine is light on the CPU at any length; the convolution engine is the original sound.',
  params: reverbParams,
  processor,
  presets: [
    { name: 'Room', params: { decay: 0.8, size: 0.35, damping: 0.6, preDelay: 0.008, mix: 0.25 } },
    { name: 'Hall', params: { decay: 3.2, size: 0.85, damping: 0.4, preDelay: 0.03, mix: 0.3 } },
    { name: 'Plate', params: { decay: 1.8, size: 0.5, damping: 0.15, preDelay: 0.01, mix: 0.3 } },
    { name: 'Ambience', params: { decay: 0.5, size: 0.2, damping: 0.7, preDelay: 0, mix: 0.2 } },
    { name: 'Cathedral', params: { decay: 7, size: 1, damping: 0.5, preDelay: 0.05, mix: 0.35 } },
  ],

  async create(host) {
    const ac = host.audioContext;
    const P = host.params;
    const port = await host.worklet({ numberOfInputs: 1, outputChannelCount: [2] });
    const input = new GainNode(ac);
    const output = new GainNode(ac);

    let engine: ReverbEngine = P.engine.value;
    const algorithmic = new GainNode(ac, { gain: engine === 'algorithmic' ? 1 : 0 });
    port.node.connect(algorithmic).connect(output);
    let kernelFed = false;
    const feedKernel = (on: boolean) => {
      if (kernelFed === on) return;
      kernelFed = on;
      if (on) input.connect(port.node);
      else input.disconnect(port.node);
    };
    feedKernel(engine === 'algorithmic');

    type Conv = ReturnType<typeof convolution> & { fade: GainNode };
    let conv: Conv | null = null;
    const openConvolution = (gain: number): Conv => {
      if (conv) return conv;
      const c = convolution(host);
      const fade = new GainNode(ac, { gain });
      c.output.connect(fade).connect(output);
      input.connect(c.input);
      return (conv = { ...c, fade });
    };
    const closeConvolution = () => {
      if (!conv) return;
      conv.dispose();
      conv.fade.disconnect();
      conv = null;
    };
    if (engine === 'convolution') openConvolution(1);

    const timers = new Set<ReturnType<typeof setTimeout>>();
    const ramp = (param: AudioParam, to: number, t: number) => {
      param.cancelAndHoldAtTime(t);
      param.linearRampToValueAtTime(to, t + ENGINE_XFADE);
    };
    const switchTo = (next: ReverbEngine, time: number) => {
      if (next === engine) return;
      engine = next;
      const immediate = host.offline || ac.currentTime === 0;
      const t = Math.max(time, ac.currentTime);
      if (next === 'algorithmic') {
        feedKernel(true);
        if (immediate || !conv) {
          algorithmic.gain.value = 1;
          closeConvolution();
          return;
        }
        ramp(algorithmic.gain, 1, t);
        ramp(conv.fade.gain, 0, t);
      } else {
        const c = openConvolution(immediate ? 1 : 0);
        if (immediate) {
          algorithmic.gain.value = 0;
          feedKernel(false);
          return;
        }
        ramp(c.fade.gain, 1, t);
        ramp(algorithmic.gain, 0, t);
      }
      // Once the fade is over, the engine faded out stops getting input (or is torn down).
      const timer = setTimeout(
        () => {
          timers.delete(timer);
          if (engine === 'algorithmic') closeConvolution();
          else feedKernel(false);
        },
        (t - ac.currentTime + ENGINE_XFADE) * 1000 + 60,
      );
      timers.add(timer);
    };
    const offEngine = P.engine.onChange((value, time) => switchTo(value, time));

    return {
      input,
      output,
      get tailTime() {
        return reverbTail(P.decay.value, P.preDelay.value);
      },
      reset() {
        port.reset();
        conv?.reset();
      },
      dispose() {
        offEngine();
        for (const t of timers) clearTimeout(t);
        timers.clear();
        closeConvolution();
        port.dispose();
        for (const n of [input, output, algorithmic]) n.disconnect();
      },
    };
  },
});
