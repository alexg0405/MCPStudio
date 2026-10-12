import { InstrumentKernel, registerKernel } from '@agstudio/sdk/worklet';

/** Writes one 0.5 sample at each note-on frame: lets tests check frame-exact event delivery. */
class Impulse extends InstrumentKernel {
  private pending = false;
  noteOn(): void {
    this.pending = true;
  }
  noteOff(): void {}
  render(out: Float32Array[], from: number, to: number): void {
    if (!this.pending || from >= to) return;
    for (const ch of out) ch[from] = (ch[from] as number) + 0.5;
    this.pending = false;
  }
}

registerKernel('test.impulse', {}, Impulse);
