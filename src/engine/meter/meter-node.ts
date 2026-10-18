import type { MeterHandle } from '../api';
import meterUrl from './meter.worklet.ts?worker&url';
import { allocateMeterMemory, initReadings, METER_ID, R, viewsOf, type MeterMemory, type MeterViews } from './layout';

/** True where shared memory exists (cross-origin isolation): the meters need it to cost nothing per frame. */
export function canMeter(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}

/**
 * One metering worklet node listening to an audio node (the master, an insert), and the main-thread side of its shared
 * memory. Made only while somebody looks (the node, its input connection and its processor all go away on `close()`),
 * so a closed Meters window adds nothing to the audio thread. The node is made once the module has loaded; until
 * then the readings read as "nothing measured".
 */
export class MeterNode implements MeterHandle {
  readonly readings: Float64Array;
  readonly history: Float32Array;
  readonly spectrum: Float32Array;
  readonly scope: Float32Array;
  readonly sampleRate: number;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private closed = false;
  private full: boolean;

  constructor(
    private readonly ctx: BaseAudioContext,
    loadModule: (url: string) => Promise<void>,
    private readonly source: AudioNode,
    opts: { full?: boolean } = {},
    private readonly onClose: (m: MeterNode) => void = () => {},
  ) {
    const memory = allocateMeterMemory();
    const views: MeterViews = viewsOf(memory);
    this.readings = views.readings;
    this.history = views.history;
    this.spectrum = views.spectrum;
    this.scope = views.scope;
    this.sampleRate = ctx.sampleRate;
    this.full = !!opts.full;
    this.readings[R.detail] = this.full ? 1 : 0;
    initReadings(this.readings, ctx.sampleRate);
    void loadModule(meterUrl).then(
      () => this.attachProcessor(memory),
      (err) => console.warn('[agstudio] the meters are unavailable', err),
    );
  }

  /** Makes the worklet node (once the module has loaded) and listens to the source with it, unless closed meanwhile. */
  private attachProcessor(memory: MeterMemory): void {
    if (this.closed) return;
    const node = new AudioWorkletNode(this.ctx, METER_ID, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { memory },
    });
    // A silent path to the destination keeps the processor pulled by the render graph.
    const sink = new GainNode(this.ctx, { gain: 0 });
    this.source.connect(node);
    node.connect(sink).connect(this.ctx.destination);
    this.node = node;
    this.sink = sink;
  }

  /** The processor is running (its node is connected and not closed). */
  get active(): boolean {
    return !!this.node && !this.closed;
  }

  /** Render quanta the processor has handled; stands still once closed. */
  get blocks(): number {
    return this.readings[R.blocks] as number;
  }

  /** Switches the extra detail (bands, spectrum, scope) on or off; it costs more on the audio thread. */
  setDetail(full: boolean): void {
    this.full = full;
    this.readings[R.detail] = full ? 1 : 0;
  }

  /** Restarts the integrated loudness, the loudness range, the maximums and the history graph. */
  reset(seq = (this.readings[R.resetSeq] as number) + 1): void {
    this.readings[R.resetSeq] = seq;
  }

  /** Takes the processor off the audio thread (its node, its input connection and its processor all go away). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readings[R.closed] = 1;
    if (this.node) {
      try {
        this.source.disconnect(this.node);
      } catch {
        /* the source was disconnected already */
      }
      this.node.disconnect();
      this.sink?.disconnect();
    }
    this.node = null;
    this.sink = null;
    this.onClose(this);
  }

  /** Whether the full detail is on. */
  get isFull(): boolean {
    return this.full;
  }
}
