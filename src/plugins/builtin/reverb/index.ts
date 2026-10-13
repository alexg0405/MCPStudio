import { defineEffect, p } from '@agstudio/sdk';
import { generateReverbIR } from './ir.kernel';

/** Crossfade between the old and the new impulse response, seconds. */
const XFADE = 0.12;
/** Knob drags regenerate the IR this long after the last change. */
const DEBOUNCE_MS = 150;

const params = {
  decay: p.float(0.2, 10, 2.2, {
    label: 'Decay',
    unit: 's',
    scale: 'log',
    group: 'Room',
    hint: 'Time for the reverb to fade by 60 dB (RT60)',
    // Each change rebuilds the impulse response: not for automation.
    automatable: false,
  }),
  preDelay: p.float(0, 0.2, 0.02, {
    label: 'Pre-delay',
    unit: 's',
    group: 'Room',
    hint: 'Gap before the reverb starts',
  }),
  damping: p.float(0, 1, 0.5, {
    label: 'Damping',
    unit: '%',
    group: 'Room',
    hint: 'How much faster the highs die away',
    automatable: false,
  }),
  size: p.float(0, 1, 0.6, {
    label: 'Size',
    unit: '%',
    group: 'Room',
    hint: 'Room size: how far apart the early reflections are',
    automatable: false,
  }),
  mix: p.float(0, 1, 0.3, { label: 'Mix', unit: '%', group: 'Output', hint: 'Dry/wet balance (equal power)' }),
};

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
 * Convolution reverb with a procedurally generated stereo impulse response (see ir.kernel.ts).
 * Decay, damping and size changes regenerate the IR (debounced while playing, immediately during an
 * export) into a second ConvolverNode and crossfade to it, because swapping a convolver's buffer in
 * place would click and cut its tail.
 */
export default defineEffect({
  id: 'agstudio.reverb',
  name: 'Reverb',
  version: 1,
  category: 'Reverb',
  description: 'Algorithmic-style convolution reverb: decay, pre-delay, damping and room size.',
  params,
  presets: [
    { name: 'Room', params: { decay: 0.8, size: 0.35, damping: 0.6, preDelay: 0.008, mix: 0.25 } },
    { name: 'Hall', params: { decay: 3.2, size: 0.85, damping: 0.4, preDelay: 0.03, mix: 0.3 } },
    { name: 'Plate', params: { decay: 1.8, size: 0.5, damping: 0.15, preDelay: 0.01, mix: 0.3 } },
    { name: 'Ambience', params: { decay: 0.5, size: 0.2, damping: 0.7, preDelay: 0, mix: 0.2 } },
    { name: 'Cathedral', params: { decay: 7, size: 1, damping: 0.5, preDelay: 0.05, mix: 0.35 } },
  ],

  create(host) {
    const ac = host.audioContext;
    const P = host.params;
    const input = new GainNode(ac);
    const output = new GainNode(ac);
    const dry = new GainNode(ac);
    const wet = new GainNode(ac);
    const preDelay = new DelayNode(ac, { maxDelayTime: 0.5, delayTime: P.preDelay.value });
    P.preDelay.bind(preDelay.delayTime);
    // Equal-power dry/wet.
    P.mix.bind(dry.gain, (m) => Math.cos((m * Math.PI) / 2));
    P.mix.bind(wet.gain, (m) => Math.sin((m * Math.PI) / 2));
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
      return t;
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
    P.decay.onChange(changed);
    P.damping.onChange(changed);
    P.size.onChange(changed);

    return {
      input,
      output,
      get tailTime() {
        return P.preDelay.value + P.decay.value * 1.3;
      },
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
        for (const lane of lanes) {
          lane.conv.disconnect();
          lane.gain.disconnect();
        }
        for (const n of [input, output, dry, wet, preDelay]) n.disconnect();
      },
    };
  },
});
