// The Drum Pads' built-in sounds, synthesized from the SDK drum models (no samples to ship).
import { Clap, HiHat, Kick, Perc, renderDrum, Snare, Tom, type DrumModel } from '@agstudio/sdk/worklet';
import type { SoundId } from './params';

const cache = new Map<string, Float32Array>();

function make(id: SoundId, sr: number): DrumModel | null {
  switch (id) {
    case 'kick':
      return Object.assign(new Kick(sr, 11), {
        pitch: 52,
        sweep: 26,
        sweepTime: 0.04,
        decay: 0.5,
        click: 0.35,
        drive: 0.3,
      });
    case 'kick808':
      return Object.assign(new Kick(sr, 12), {
        pitch: 45,
        sweep: 14,
        sweepTime: 0.06,
        decay: 1.7,
        click: 0.1,
        drive: 0.25,
      });
    case 'kickHard':
      return Object.assign(new Kick(sr, 13), {
        pitch: 58,
        sweep: 36,
        sweepTime: 0.022,
        decay: 0.34,
        click: 0.8,
        drive: 0.8,
      });
    case 'snare':
      return Object.assign(new Snare(sr, 21), { tone: 185, snappy: 0.6, decay: 0.22, brightness: 2500 });
    case 'snare2':
      return Object.assign(new Snare(sr, 22), { tone: 235, snappy: 0.8, decay: 0.13, brightness: 4000 });
    case 'rim':
      return Object.assign(new Perc(sr, 31), { pitch: 1700, ring: 1, decay: 0.035, noiseMix: 0.6 });
    case 'clap':
      return Object.assign(new Clap(sr, 41), { tone: 1200, decay: 0.26, spread: 0.011 });
    case 'snap':
      return Object.assign(new Clap(sr, 42), { tone: 2600, decay: 0.08, spread: 0.004 });
    case 'hatClosed':
      return Object.assign(new HiHat(sr, 51), { decay: 0.05, tone: 0.65 });
    case 'hatPedal':
      return Object.assign(new HiHat(sr, 52), { decay: 0.035, tone: 0.45 });
    case 'hatOpen':
      return Object.assign(new HiHat(sr, 53), { decay: 0.5, tone: 0.65, noiseMix: 0.32 });
    case 'crash':
      return Object.assign(new HiHat(sr, 54), { pitch: 260, decay: 1.9, tone: 0.45, noiseMix: 0.55 });
    case 'ride':
      return Object.assign(new HiHat(sr, 55), { pitch: 330, decay: 1.5, tone: 0.75, noiseMix: 0.15 });
    case 'tomLow':
      return Object.assign(new Tom(sr, 61), { pitch: 90, sweep: 7, decay: 0.5 });
    case 'tomMid':
      return Object.assign(new Tom(sr, 62), { pitch: 125, sweep: 7, decay: 0.42 });
    case 'tomHigh':
      return Object.assign(new Tom(sr, 63), { pitch: 170, sweep: 7, decay: 0.36 });
    case 'cowbell':
      return Object.assign(new Perc(sr, 71), { pitch: 560, ring: 1.48, decay: 0.25, noiseMix: 0.1 });
    case 'clave':
      return Object.assign(new Perc(sr, 72), { pitch: 2500, ring: 1, decay: 0.05, noiseMix: 0.05 });
    case 'shaker':
      return Object.assign(new HiHat(sr, 73), { decay: 0.09, tone: 0.85, noiseMix: 1 });
    case 'conga':
      return Object.assign(new Tom(sr, 74), { pitch: 210, sweep: 2, decay: 0.28 });
    case 'none':
      return null;
  }
}

/** Peak level of each sound, balanced like a mixed kit (kicks loudest, cymbals and shakers quieter). */
const PEAK: Record<SoundId, number> = {
  kick: 0.9,
  kick808: 0.9,
  kickHard: 0.9,
  snare: 0.75,
  snare2: 0.7,
  rim: 0.5,
  clap: 0.7,
  snap: 0.5,
  hatClosed: 0.45,
  hatPedal: 0.4,
  hatOpen: 0.42,
  crash: 0.4,
  ride: 0.35,
  tomLow: 0.7,
  tomMid: 0.7,
  tomHigh: 0.7,
  cowbell: 0.5,
  clave: 0.5,
  shaker: 0.35,
  conga: 0.6,
  none: 0,
};

/**
 * One hit of a built-in sound at `sampleRate` (mono), rendered once and cached (all of them take
 * a few tens of milliseconds, on the main thread).
 */
export function builtinSound(id: SoundId, sampleRate: number): Float32Array | null {
  const key = `${id}@${sampleRate}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const model = make(id, sampleRate);
  if (!model) return null;
  const data = renderDrum(model, 1, 3);
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] as number));
  if (peak > 0) {
    const gain = PEAK[id] / peak;
    for (let i = 0; i < data.length; i++) data[i] = (data[i] as number) * gain;
  }
  cache.set(key, data);
  return data;
}
