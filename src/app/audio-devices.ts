/**
 * Audio outputs (speakers, headphones, audio interfaces) the engine can play through. Chrome lists
 * every device, with its name, only once the page has had microphone access (privacy); before that
 * there is just the system default.
 */
export interface AudioOutput {
  /** `MediaDeviceInfo.deviceId` ('' = the system default). */
  id: string;
  label: string;
}

/** Whether this browser lets a page choose its output (AudioContext.setSinkId: Chrome and Edge 110+). */
export function canChooseOutput(): boolean {
  return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
}

/** The outputs, system default first, and whether the browser lists them all by name yet. */
export async function listOutputs(): Promise<{ outputs: AudioOutput[]; complete: boolean }> {
  const devices = (await navigator.mediaDevices?.enumerateDevices?.().catch(() => [])) ?? [];
  const outs = devices.filter((d) => d.kind === 'audiooutput');
  // Chrome's "default" entry is named after the device it currently means ("Default - AirPods").
  const current = outs.find((d) => d.deviceId === 'default')?.label.replace(/^default\s*-\s*/i, '') ?? '';
  const real = outs.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  return {
    outputs: [
      { id: '', label: current ? `System default (${current})` : 'System default' },
      ...real.map((d, i) => ({ id: d.deviceId, label: d.label || `Output ${i + 1}` })),
    ],
    complete: real.some((d) => d.label),
  };
}

/** Asks for the microphone once and stops it right away; afterwards the browser lists every device by name. */
export async function revealDevices(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return true;
  } catch {
    return false;
  }
}

/** Calls fn when a device is plugged in or out. */
export function onDevicesChange(fn: () => void): () => void {
  const md = globalThis.navigator?.mediaDevices;
  if (!md) return () => {};
  md.addEventListener('devicechange', fn);
  return () => md.removeEventListener('devicechange', fn);
}

/** The output named like `query` ("airpods", "default"), the best match first; null if none is. */
export function findOutput(outputs: readonly AudioOutput[], query: string): AudioOutput | null {
  const q = query.trim().toLowerCase();
  if (!q || q === 'default' || q === 'system default' || q === 'system') return outputs[0] ?? null;
  const named = outputs.slice(1);
  return (
    named.find((o) => o.label.toLowerCase() === q) ??
    named.find((o) => o.label.toLowerCase().startsWith(q)) ??
    named.find((o) => o.label.toLowerCase().includes(q)) ??
    null
  );
}
