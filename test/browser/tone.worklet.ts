import { p } from '@agstudio/sdk/params';
import { at, InstrumentKernel, registerKernel, type ParamBlock } from '@agstudio/sdk/worklet';

const TONE = { level: p.float(0, 1, 1) };

/** A 1 kHz sine at 0.25 × level while any note is held (bit-exact: no native oscillators). */
class Tone extends InstrumentKernel<typeof TONE> {
  private held = 0;
  private phase = 0;
  noteOn(): void {
    this.held++;
  }
  noteOff(): void {
    this.held = Math.max(0, this.held - 1);
  }
  render(out: Float32Array[], from: number, to: number, params: ParamBlock<typeof TONE>): void {
    if (this.held === 0) return;
    const step = (2 * Math.PI * 1000) / this.sampleRate;
    const l = out[0] as Float32Array;
    const r = out[1] as Float32Array;
    for (let i = from; i < to; i++) {
      const v = 0.25 * at(params.level, i) * Math.sin(this.phase);
      this.phase += step;
      if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
      l[i] = (l[i] as number) + v;
      r[i] = (r[i] as number) + v;
    }
  }
}

/** White noise at 0.25 while any note is held (seeded: renders repeat exactly). */
class Noise extends InstrumentKernel {
  private held = 0;
  noteOn(): void {
    this.held++;
  }
  noteOff(): void {
    this.held = Math.max(0, this.held - 1);
  }
  render(out: Float32Array[], from: number, to: number): void {
    if (this.held === 0) return;
    const l = out[0] as Float32Array;
    const r = out[1] as Float32Array;
    for (let i = from; i < to; i++) {
      const v = 0.25 * (this.host.rand() * 2 - 1);
      l[i] = (l[i] as number) + v;
      r[i] = (r[i] as number) + v;
    }
  }
}

registerKernel('test.tone', TONE, Tone);
registerKernel('test.noise', {}, Noise);
