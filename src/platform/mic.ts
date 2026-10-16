/**
 * Microphone and audio interface access for recording. Browser voice processing (echo
 * cancellation, noise suppression, auto gain) is off by default: it changes the sound and flattens
 * transients. Echo cancellation is only worth having when the beat plays through speakers while you
 * perform (with headphones, leave it off).
 */
export interface MicInput {
  stream: MediaStream;
  /** Seconds the input lags (MediaTrackSettings.latency; 0 when the browser doesn't say). */
  latency: number;
  label: string;
  /** The device it opened (for choosing it again). */
  deviceId: string;
  /** Channels the device delivers. */
  channelCount: number;
  close(): void;
}

export interface AudioInputDevice {
  deviceId: string;
  /** Empty until the page has had microphone permission once. */
  label: string;
}

export function isMicSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

export class MicError extends Error {
  constructor(
    message: string,
    readonly kind: 'blocked' | 'missing' | 'busy' | 'unsupported' | 'failed',
  ) {
    super(message);
    this.name = 'MicError';
  }
}

/** The name the browser gives a failed getUserMedia call (a DOMException), or '' for anything else. */
function errorName(e: unknown): string {
  return typeof e === 'object' && e !== null && 'name' in e && typeof e.name === 'string' ? e.name : '';
}

/**
 * A plain-words MicError for a failed getUserMedia call. The browser's own words are kept in
 * parentheses only for errors nobody mapped.
 */
export function micError(e: unknown): MicError {
  const name = errorName(e);
  switch (name) {
    case 'NotAllowedError':
      return new MicError(
        'Microphone access is blocked. Allow it from the icon in the address bar, then try again.',
        'blocked',
      );
    case 'SecurityError':
      return new MicError(
        "This page isn't allowed to use the microphone. Open AGstudio from a secure address (https or localhost) and try again.",
        'blocked',
      );
    case 'NotFoundError':
      return new MicError('No microphone was found. Plug one in and try again.', 'missing');
    case 'OverconstrainedError':
      return new MicError(
        "This audio input isn't available. Pick another one in Options › Audio input.",
        'missing',
      );
    case 'NotReadableError':
      return new MicError('The microphone is in use by another app. Close that app and try again.', 'busy');
    case 'AbortError':
      return new MicError('Starting the microphone was interrupted. Try again.', 'failed');
    default: {
      const raw = e instanceof Error ? e.message : String(e);
      return new MicError(`Couldn't start the microphone (${raw || name || 'unknown error'}).`, 'failed');
    }
  }
}

export interface OpenMicOptions {
  echoCancellation?: boolean;
  /** A device from listAudioInputs (default: the system's default input). */
  deviceId?: string;
  /** 1 (mono) or 2 (stereo); the device may deliver fewer. */
  channels?: number;
}

export async function openMic(opts: OpenMicOptions = {}): Promise<MicInput> {
  if (!isMicSupported()) throw new MicError('This browser has no microphone access.', 'unsupported');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: opts.echoCancellation ?? false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: opts.channels ?? 1,
        ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
      },
    });
  } catch (e) {
    throw micError(e);
  }
  const track = stream.getAudioTracks()[0];
  const settings = (track?.getSettings() ?? {}) as MediaTrackSettings & { latency?: number };
  return {
    stream,
    latency: typeof settings.latency === 'number' && Number.isFinite(settings.latency) ? settings.latency : 0,
    label: track?.label || 'Microphone',
    deviceId: settings.deviceId ?? opts.deviceId ?? '',
    channelCount: typeof settings.channelCount === 'number' ? settings.channelCount : 1,
    close: () => stream.getTracks().forEach((t) => t.stop()),
  };
}

/** The audio inputs the browser knows about (names appear once mic permission was given). */
export async function listAudioInputs(): Promise<AudioInputDevice[]> {
  if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.enumerateDevices !== 'function') return [];
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({ deviceId: d.deviceId, label: d.label }));
  } catch {
    return [];
  }
}

/** Calls `fn` when inputs are plugged in or out. */
export function onAudioInputsChange(fn: () => void): () => void {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!md || typeof md.addEventListener !== 'function') return () => {};
  md.addEventListener('devicechange', fn);
  return () => md.removeEventListener('devicechange', fn);
}
