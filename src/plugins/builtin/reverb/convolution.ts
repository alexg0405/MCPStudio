import type { PluginHost } from '@agstudio/sdk';
import { impulseResponse } from './impulse-cache';
import type { reverbParams } from './params';
import { createTimers } from './timers';

/** The host an effect of the Reverb sees (it keeps no document state of its own). */
export type ReverbHost = PluginHost<typeof reverbParams, undefined>;

/** Crossfade between the old and the new impulse response, seconds. */
const IMPULSE_FADE_SEC = 0.12;
/** Extra time before a faded-out convolver stops being fed, so the fade has certainly finished, milliseconds. */
const FADE_OUT_MARGIN_MS = 60;
/** Knob drags regenerate the IR this long after the last change, milliseconds. */
const REGENERATE_DEBOUNCE_MS = 150;
/** The longest pre-delay the node can hold, seconds (the knob stops at 0.2). */
const MAX_PRE_DELAY_SEC = 0.5;

/** What the Reverb's main file needs from the convolution engine. */
export interface ConvolutionEngine {
  input: GainNode;
  output: GainNode;
  /** Clears the tail. */
  reset(): void;
  dispose(): void;
}

/**
 * One convolver and the gain that fades it. A lane only receives input while it is the sounding one or still
 * fading out, because a convolver costs CPU for as long as it is fed.
 */
class ConvolverLane {
  readonly convolver: ConvolverNode;
  readonly fade: GainNode;
  private isFed = false;

  constructor(
    ac: BaseAudioContext,
    private readonly source: AudioNode,
    wet: AudioNode,
  ) {
    this.convolver = new ConvolverNode(ac, { disableNormalization: true });
    this.fade = new GainNode(ac, { gain: 0 });
    this.convolver.connect(this.fade).connect(wet);
  }

  feed(on: boolean): void {
    if (this.isFed === on) return;
    this.isFed = on;
    if (on) this.source.connect(this.convolver);
    else this.source.disconnect(this.convolver);
  }

  dispose(): void {
    this.convolver.disconnect();
    this.fade.disconnect();
  }
}

/** The dry/wet network in front of the lanes: dry straight through, wet through the pre-delay (equal power). */
function buildMixer(host: ReverbHost) {
  const ac = host.audioContext;
  const params = host.params;
  const input = new GainNode(ac);
  const output = new GainNode(ac);
  const dry = new GainNode(ac);
  const wet = new GainNode(ac);
  const preDelay = new DelayNode(ac, { maxDelayTime: MAX_PRE_DELAY_SEC, delayTime: params.preDelay.value });
  const unbind = [
    params.preDelay.bind(preDelay.delayTime),
    params.mix.bind(dry.gain, (mix) => Math.cos((mix * Math.PI) / 2)),
    params.mix.bind(wet.gain, (mix) => Math.sin((mix * Math.PI) / 2)),
  ];
  input.connect(dry).connect(output);
  input.connect(preDelay);
  wet.connect(output);
  return { input, output, dry, wet, preDelay, unbind };
}

/**
 * The convolution engine: a procedurally generated stereo impulse response (see ir.kernel.ts).
 * Decay, damping and size changes regenerate the IR (debounced while playing, immediately during an
 * export) into a second ConvolverNode and crossfade to it, because swapping a convolver's buffer in
 * place would click and cut its tail. Built only while the Engine is Convolution.
 */
export function createConvolution(host: ReverbHost): ConvolutionEngine {
  const ac = host.audioContext;
  const params = host.params;
  const { input, output, dry, wet, preDelay, unbind } = buildMixer(host);
  const lanes = [new ConvolverLane(ac, preDelay, wet), new ConvolverLane(ac, preDelay, wet)] as const;
  const timers = createTimers();
  const currentImpulse = () =>
    impulseResponse(ac.sampleRate, params.decay.value, params.damping.value, params.size.value);

  let sounding = lanes[0];
  sounding.convolver.buffer = currentImpulse();
  sounding.fade.gain.value = 1;
  sounding.feed(true);

  /** Fades from the sounding lane to the other one, loaded with the new impulse response. */
  function crossfadeTo(buffer: AudioBuffer): void {
    const from = sounding;
    const to = from === lanes[0] ? lanes[1] : lanes[0];
    to.feed(true);
    to.convolver.buffer = buffer;
    const now = ac.currentTime;
    from.fade.gain.cancelAndHoldAtTime(now);
    from.fade.gain.linearRampToValueAtTime(0, now + IMPULSE_FADE_SEC);
    to.fade.gain.cancelScheduledValues(now);
    to.fade.gain.setValueAtTime(0, now);
    to.fade.gain.linearRampToValueAtTime(1, now + IMPULSE_FADE_SEC);
    sounding = to;
    // The faded-out convolver stops receiving input (saves CPU) once the fade is over.
    timers.later(IMPULSE_FADE_SEC * 1000 + FADE_OUT_MARGIN_MS, () => {
      if (sounding !== from) from.feed(false);
    });
  }

  function regenerate(): void {
    const buffer = currentImpulse();
    if (sounding.convolver.buffer === buffer) return;
    // Nothing is playing yet (or this is an export): swap in place, there is no tail to cut.
    if (host.offline || ac.currentTime === 0) {
      sounding.convolver.buffer = buffer;
      return;
    }
    crossfadeTo(buffer);
  }

  let debounce: ReturnType<typeof setTimeout> | null = null;
  function onImpulseSettingChanged(): void {
    if (host.offline) {
      regenerate();
      return;
    }
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      regenerate();
    }, REGENERATE_DEBOUNCE_MS);
  }
  unbind.push(
    params.decay.onChange(onImpulseSettingChanged),
    params.damping.onChange(onImpulseSettingChanged),
    params.size.onChange(onImpulseSettingChanged),
  );

  return {
    input,
    output,
    reset() {
      // Setting the buffer again clears the convolver's tail.
      const buffer = sounding.convolver.buffer;
      if (buffer) sounding.convolver.buffer = buffer;
    },
    dispose() {
      if (debounce) clearTimeout(debounce);
      timers.clear();
      for (const stop of unbind) stop();
      for (const lane of lanes) lane.dispose();
      for (const node of [input, output, dry, wet, preDelay]) node.disconnect();
    },
  };
}
