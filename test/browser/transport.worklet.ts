import { EffectKernel, registerKernel } from '@agstudio/sdk/worklet';

/**
 * Writes the song transport it sees as audio: left = beat / 8, right = 0.5 while playing and 0.25
 * while stopped (a reference level, so a constant gain on the way out doesn't matter).
 */
class BeatOut extends EffectKernel {
  process(_input: Float32Array[], output: Float32Array[], n: number): void {
    const t = this.transport;
    const l = output[0] as Float32Array;
    const r = (output[1] ?? output[0]) as Float32Array;
    for (let i = 0; i < n; i++) {
      l[i] = t.beatAt(i) / 8;
      r[i] = t.playing ? 0.5 : 0.25;
    }
  }
}

registerKernel('test.beat-out', {}, BeatOut);
