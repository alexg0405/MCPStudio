/**
 * Microphone access for recording performances. Browser voice processing is off by default: noise
 * suppression and auto gain flatten beatbox transients. Echo cancellation is only worth having
 * when the beat plays through speakers while you perform (with headphones, leave it off).
 */
export interface MicInput {
  stream: MediaStream;
  /** Seconds the input lags (MediaTrackSettings.latency; 0 when the browser doesn't say). */
  latency: number;
  label: string;
  close(): void;
}

export function isMicSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

export class MicError extends Error {
  constructor(
    message: string,
    readonly kind: 'blocked' | 'missing' | 'busy' | 'unsupported',
  ) {
    super(message);
    this.name = 'MicError';
  }
}

export async function openMic(opts: { echoCancellation?: boolean } = {}): Promise<MicInput> {
  if (!isMicSupported()) throw new MicError('This browser has no microphone access.', 'unsupported');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: opts.echoCancellation ?? false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
  } catch (e) {
    const name = e instanceof DOMException ? e.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError')
      throw new MicError(
        'Microphone access is blocked. Allow it from the icon in the address bar, then try again.',
        'blocked',
      );
    if (name === 'NotFoundError' || name === 'OverconstrainedError')
      throw new MicError('No microphone was found.', 'missing');
    if (name === 'NotReadableError') throw new MicError('The microphone is in use by another app.', 'busy');
    throw e;
  }
  const track = stream.getAudioTracks()[0];
  const settings = (track?.getSettings() ?? {}) as MediaTrackSettings & { latency?: number };
  return {
    stream,
    latency: typeof settings.latency === 'number' && Number.isFinite(settings.latency) ? settings.latency : 0,
    label: track?.label ?? 'Microphone',
    close: () => stream.getTracks().forEach((t) => t.stop()),
  };
}
