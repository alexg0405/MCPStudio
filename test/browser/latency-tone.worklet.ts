import { p } from '@agstudio/sdk/params';
import { at, InstrumentKernel, registerKernel, type ParamBlock } from '@agstudio/sdk/worklet';

const TONE = { level: p.float(0, 1, 1) };

/**
 * The latency tests' instrument: a 1 kHz sine at 0.25 × level that starts at full strength on the note-on frame and
 * stops on the last note-off (or all-notes-off), so a probe sees exactly when the engine got the event to the output.
 */
class LatencyTone extends InstrumentKernel<typeof TONE> {
  private held = 0;
  private phase = 0;
  noteOn(): void {
    this.held++;
  }
  noteOff(): void {
    this.held = Math.max(0, this.held - 1);
  }
  override allNotesOff(): void {
    this.held = 0;
  }
  render(out: Float32Array[], from: number, to: number, params: ParamBlock<typeof TONE>): void {
    if (this.held === 0) return;
    const step = (2 * Math.PI * 1000) / this.sampleRate;
    const l = out[0] as Float32Array;
    const r = out[1] as Float32Array;
    for (let i = from; i < to; i++) {
      // Starts at the peak (cosine): the first frame is already loud.
      const v = 0.25 * at(params.level, i) * Math.cos(this.phase);
      this.phase += step;
      if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
      l[i] = (l[i] as number) + v;
      r[i] = (r[i] as number) + v;
    }
  }
}

registerKernel('test.latency-tone', TONE, LatencyTone);
