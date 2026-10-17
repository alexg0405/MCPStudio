import { DECK_ID, type DeckMessage } from './deck-id';
import { DeckKernel } from './deck.kernel';

/**
 * A DJ deck's player on the audio thread: the kernel (deck.kernel.ts) behind a message port. The song's audio
 * arrives once as SharedArrayBuffers (a pool of planar float32 blocks and the table that finds them, filled ahead of the play
 * position by the main thread: `deck-stream.ts`), the deck's position and speed go out through a shared state
 * block (see `DS` in deck-id.ts), so nothing here allocates or posts per render quantum.
 */
interface DeckOptions {
  state: SharedArrayBuffer;
}

class DeckProcessor extends AudioWorkletProcessor {
  private readonly kernel: DeckKernel;
  private disposed = false;

  constructor(options: { processorOptions?: unknown }) {
    super();
    const o = options.processorOptions as DeckOptions;
    this.kernel = new DeckKernel(sampleRate);
    this.kernel.attachState(new Float64Array(o.state), new Int32Array(o.state, 0, 1));
    this.kernel.onEnded = () => this.port.postMessage({ t: 'ended' });
    this.port.onmessage = (e: MessageEvent<DeckMessage>) => this.handle(e.data);
  }

  private handle(m: DeckMessage): void {
    const k = this.kernel;
    switch (m.t) {
      case 'song':
        k.setSong(
          m.channels.map((b) => new Float32Array(b)),
          m.frames,
        );
        break;
      case 'stream': {
        const l = new Float32Array(m.poolL);
        k.setStream(l, m.poolR === m.poolL ? l : new Float32Array(m.poolR), new Int32Array(m.table), m.frames);
        break;
      }
      case 'eject':
        k.setSong(null);
        break;
      case 'play':
        k.play(m.on);
        break;
      case 'seek':
        k.seek(m.pos);
        break;
      case 'tempo':
        k.setTempo(m.rate, m.keyLock);
        break;
      case 'nudge':
        k.nudge(m.bend);
        break;
      case 'scratch':
        k.setScratching(m.on);
        break;
      case 'scratchRate':
        k.setScratchRate(m.rate);
        break;
      case 'loop':
        k.setLoop(m.start, m.length);
        break;
      case 'noloop':
        k.clearLoop();
        break;
      case 'sync':
        k.setSync(m.sync);
        break;
      case 'align':
        k.align();
        break;
      case 'ping':
        this.port.postMessage({ t: 'pong', id: m.id });
        break;
      case 'dispose':
        this.disposed = true;
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const left = out?.[0];
    if (!out || !left) return !this.disposed;
    this.kernel.process(left, out[1] ?? left, left.length, currentFrame);
    return !this.disposed;
  }
}

registerProcessor(DECK_ID, DeckProcessor);
