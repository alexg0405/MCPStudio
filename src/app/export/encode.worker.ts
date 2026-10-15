import { createPieceEncoder, encodeAudioAsync, type EncodeSpec, type PieceEncoder } from './encode';

// Encodes WAV, FLAC or MP3 off the main thread. Either a whole file (one message: the channels are
// transferred in and the file back), or a stream: 'open', then 'push' per piece of audio, then
// 'finish' (each answered in order), so a long export never holds the whole mix in one place.
type Request =
  | { t?: undefined; channels: Float32Array[]; sampleRate: number; spec: EncodeSpec }
  | { t: 'open'; spec: EncodeSpec; sampleRate: number; channels: number }
  | { t: 'push'; channels: Float32Array[] }
  | { t: 'finish' };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

let stream: Promise<PieceEncoder> | null = null;
// Messages are handled one after another, even though opening (MP3) is async.
let chain: Promise<void> = Promise.resolve();

const reply = (msg: Record<string, unknown>, ...bytes: (Uint8Array | null)[]) =>
  scope.postMessage(
    msg,
    bytes.filter((b): b is Uint8Array => !!b && b.byteLength > 0).map((b) => b.buffer as ArrayBuffer),
  );

scope.onmessage = (e) => {
  const req = e.data;
  chain = chain.then(async () => {
    try {
      if (req.t === undefined) {
        const bytes = await encodeAudioAsync(req.channels, req.sampleRate, req.spec);
        reply({ ok: true, bytes }, bytes);
      } else if (req.t === 'open') {
        stream = createPieceEncoder(req.spec, req.sampleRate, req.channels);
        const header = (await stream).header();
        reply({ t: 'header', bytes: header }, header);
      } else if (req.t === 'push') {
        const bytes = (await stream!).push(req.channels);
        reply({ t: 'bytes', bytes }, bytes);
      } else {
        const enc = await stream!;
        const tail = enc.finish();
        const header = enc.finalHeader();
        reply({ t: 'done', tail, header }, tail, header);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (req.t === undefined) scope.postMessage({ ok: false, error });
      else scope.postMessage({ t: 'error', error });
    }
  });
};
