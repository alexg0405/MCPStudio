/** Length of one click (seconds). */
const CLICK_LENGTH_SEC = 0.004;
/** A click is a short burst of this pitch (Hz)... */
const CLICK_PITCH_HZ = 2000;
/** ...at this level (0 to 1: loud, but not clipping)... */
const CLICK_LEVEL = 0.8;
/** ...dying away with this time constant (seconds). */
const CLICK_DECAY_SEC = 0.001;
/** The first click plays this long after the call (seconds), so every click is scheduled ahead. */
const FIRST_CLICK_DELAY_SEC = 0.3;

/** A sharp tick that is easy to find in a recording: a decaying 2 kHz burst. */
function makeClick(ctx: BaseAudioContext): AudioBuffer {
  const length = Math.round(CLICK_LENGTH_SEC * ctx.sampleRate);
  const click = new AudioBuffer({ length, numberOfChannels: 1, sampleRate: ctx.sampleRate });
  const samples = click.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const burst = Math.sin((2 * Math.PI * CLICK_PITCH_HZ * i) / ctx.sampleRate);
    const decay = Math.exp(-i / (CLICK_DECAY_SEC * ctx.sampleRate));
    samples[i] = CLICK_LEVEL * burst * decay;
  }
  return click;
}

/** Short clicks on a bus that is never exported, for measuring the round trip of a live input (latency calibration). */
export class TestClicks {
  private click: AudioBuffer | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly bus: AudioNode,
  ) {}

  /** Schedules `count` clicks `intervalSec` apart; returns the context time each one plays at. */
  play(count: number, intervalSec: number): number[] {
    this.click ??= makeClick(this.ctx);
    const firstAt = this.ctx.currentTime + FIRST_CLICK_DELAY_SEC;
    const times: number[] = [];
    for (let i = 0; i < count; i++) {
      const at = firstAt + i * intervalSec;
      const source = new AudioBufferSourceNode(this.ctx, { buffer: this.click });
      source.connect(this.bus);
      source.onended = () => source.disconnect();
      source.start(at);
      times.push(at);
    }
    return times;
  }
}
