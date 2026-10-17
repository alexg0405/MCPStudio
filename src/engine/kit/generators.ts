/**
 * Procedural drum kits. Pure functions (sampleRate, seed) → channel data, so nothing is downloaded and
 * every render is deterministic. Never change the output of a published KIT_VERSION: bump the version
 * and keep the old generator so existing projects keep sounding the same. The stock kit is written out
 * here; the genre kits (`kit/<style>/<piece>`) are the SDK drum models with Drum Synth settings.
 */
import { KIT_STYLES, type KitStyle } from '@core/model/kit';
import { Biquad } from '@agstudio/sdk/dsp/biquad';
import { Clap, HiHat, Kick, renderDrum, Snare, type DrumModel } from '@agstudio/sdk/dsp/drums';
import { Rng } from '@agstudio/sdk/dsp/random';

export type Generator = (sampleRate: number, seed: number) => Float32Array[];

const TAU = Math.PI * 2;

function normalize(chs: Float32Array[], peak = 0.9): Float32Array[] {
  let max = 0;
  for (const ch of chs) for (let i = 0; i < ch.length; i++) max = Math.max(max, Math.abs(ch[i] as number));
  const g = max > 0 ? peak / max : 0;
  for (const ch of chs) {
    const fade = Math.min(ch.length, 256);
    for (let i = 0; i < ch.length; i++) {
      let v = (ch[i] as number) * g;
      const fromEnd = ch.length - 1 - i;
      if (fromEnd < fade) v *= fromEnd / fade;
      ch[i] = v;
    }
  }
  return chs;
}

const len = (sr: number, seconds: number) => Math.max(1, Math.round(sr * seconds));

/** Pitch-swept sine body (kicks and toms). */
function body(
  sr: number,
  seconds: number,
  base: number,
  sweep: number,
  sweepTau: number,
  ampTau: number,
  drive: number,
): Float32Array {
  const out = new Float32Array(len(sr, seconds));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const f = base + sweep * Math.exp(-t / sweepTau);
    phase += (TAU * f) / sr;
    const attack = Math.min(1, t / 0.0015);
    out[i] = Math.tanh(drive * Math.sin(phase)) * Math.exp(-t / ampTau) * attack;
  }
  return out;
}

const kick: Generator = (sr, seed) => {
  const out = body(sr, 0.6, 46, 140, 0.032, 0.24, 1.7);
  // Short high-passed noise click for attack.
  const rng = new Rng(seed);
  const hp = new Biquad().set('highpass', 2500, 0.7, sr);
  const click = len(sr, 0.004);
  for (let i = 0; i < click; i++) out[i] = (out[i] as number) + hp.process(rng.bipolar()) * 0.35 * (1 - i / click);
  return normalize([out]);
};

function tom(base: number): Generator {
  return (sr) => normalize([body(sr, 0.7, base, base * 0.6, 0.05, 0.18, 1.2)]);
}

const snare: Generator = (sr, seed) => {
  const out = new Float32Array(len(sr, 0.42));
  const rng = new Rng(seed);
  const hp = new Biquad().set('highpass', 1500, 0.7, sr);
  const peak = new Biquad().set('peaking', 5000, 1, sr, 4);
  let p1 = 0;
  let p2 = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    p1 += (TAU * (185 + 40 * Math.exp(-t / 0.01))) / sr;
    p2 += (TAU * 330) / sr;
    const tone = (Math.sin(p1) * 0.7 + Math.sin(p2) * 0.4) * Math.exp(-t / 0.055);
    const noise = peak.process(hp.process(rng.bipolar())) * Math.exp(-t / 0.13);
    out[i] = (tone * 0.9 + noise * 0.8) * Math.min(1, t / 0.0008);
  }
  return normalize([out]);
};

const clap: Generator = (sr, seed) => {
  const out = new Float32Array(len(sr, 0.5));
  const rng = new Rng(seed);
  const bp = new Biquad().set('bandpass', 1200, 1.4, sr);
  const hp = new Biquad().set('highpass', 600, 0.7, sr);
  const bursts = [0, 0.011, 0.022];
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    let env = 0;
    for (const b of bursts) if (t >= b) env = Math.max(env, Math.exp(-(t - b) / 0.0075));
    if (t >= 0.03) env = Math.max(env, 0.55 * Math.exp(-(t - 0.03) / 0.11));
    out[i] = hp.process(bp.process(rng.bipolar())) * env;
  }
  return normalize([out]);
};

/** 808-style metallic source: six detuned square waves. */
function metal(sr: number, n: number, ratioScale = 1): Float32Array {
  const freqs = [205.3, 304.4, 369.6, 522.7, 540, 800].map((f) => f * ratioScale);
  const out = new Float32Array(n);
  const phases = new Float64Array(freqs.length);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < freqs.length; k++) {
      phases[k] = ((phases[k] as number) + (freqs[k] as number) / sr) % 1;
      s += (phases[k] as number) < 0.5 ? 1 : -1;
    }
    out[i] = s / freqs.length;
  }
  return out;
}

function hat(seconds: number, tau: number): Generator {
  return (sr, seed) => {
    const n = len(sr, seconds);
    const src = metal(sr, n);
    const rng = new Rng(seed);
    const bp = new Biquad().set('bandpass', 10000, 0.9, sr);
    const hp = new Biquad().set('highpass', 7000, 0.7, sr);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const x = (src[i] as number) * 0.8 + rng.bipolar() * 0.35;
      out[i] = hp.process(bp.process(x)) * Math.exp(-t / tau) * Math.min(1, t / 0.0005);
    }
    return normalize([out], 0.8);
  };
}

const rim: Generator = (sr, seed) => {
  const out = new Float32Array(len(sr, 0.09));
  const rng = new Rng(seed);
  const hp = new Biquad().set('highpass', 3000, 0.7, sr);
  let p1 = 0;
  let p2 = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    p1 += (TAU * 1700) / sr;
    p2 += (TAU * 480) / sr;
    out[i] = (Math.sin(p1) * 0.6 + Math.sin(p2) * 0.5 + hp.process(rng.bipolar()) * 0.5) * Math.exp(-t / 0.009);
  }
  return normalize([out]);
};

const cowbell: Generator = (sr) => {
  const out = new Float32Array(len(sr, 0.5));
  const bp = new Biquad().set('bandpass', 2600, 1.2, sr);
  let a = 0;
  let b = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    a = (a + 540 / sr) % 1;
    b = (b + 800 / sr) % 1;
    const sq = (a < 0.5 ? 1 : -1) + (b < 0.5 ? 1 : -1);
    const env = 0.7 * Math.exp(-t / 0.03) + 0.3 * Math.exp(-t / 0.22);
    out[i] = bp.process(sq) * env;
  }
  return normalize([out], 0.8);
};

const crash: Generator = (sr, seed) => {
  const n = len(sr, 2.6);
  const src = metal(sr, n, 1.47);
  const out: Float32Array[] = [new Float32Array(n), new Float32Array(n)];
  for (let c = 0; c < 2; c++) {
    const rng = new Rng(seed + c * 7919);
    const hp = new Biquad().set('highpass', 4800, 0.7, sr);
    const shelf = new Biquad().set('highshelf', 9000, 0.7, sr, 3);
    const ch = out[c] as Float32Array;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const x = rng.bipolar() * 0.8 + (src[i] as number) * 0.3;
      ch[i] = shelf.process(hp.process(x)) * Math.exp(-t / 0.9) * Math.min(1, t / 0.002);
    }
  }
  return normalize(out, 0.75);
};

// ---------------------------------------------------------------- genre kits

/** A genre kit as Drum Synth settings (model units: seconds, Hz, 0–1). */
interface GenreKit {
  kick: Pick<Kick, 'pitch' | 'sweep' | 'sweepTime' | 'decay' | 'click' | 'drive'>;
  snare: Pick<Snare, 'tone' | 'snappy' | 'decay' | 'brightness'>;
  clap: Pick<Clap, 'tone' | 'decay' | 'spread'>;
  hat: Pick<HiHat, 'tone' | 'decay'>;
  openHat: Pick<HiHat, 'tone' | 'decay'>;
}

/**
 * The Drum Synth presets behind each genre kit. Trap: "Trap 808 kit (long boom)" except the kick,
 * which is punchier and shorter (in a trap beat the boom is the 808's). House: "Punchy 909-style
 * kit". Lo-fi: "Lo-fi dusty kit". Boom bap has no Drum Synth preset: a thick, punchy, slightly
 * dusty kit between the 909 and the lo-fi ones.
 */
const GENRE_SETTINGS: Readonly<Record<KitStyle, GenreKit>> = {
  trap: {
    kick: { pitch: 50, sweep: 24, sweepTime: 0.035, decay: 0.45, click: 0.4, drive: 0.45 },
    snare: { tone: 230, snappy: 0.55, decay: 0.16, brightness: 3000 },
    clap: { tone: 1550, decay: 0.32, spread: 0.014 },
    hat: { tone: 0.9, decay: 0.028 },
    openHat: { tone: 0.8, decay: 0.6 },
  },
  house: {
    kick: { pitch: 56, sweep: 30, sweepTime: 0.028, decay: 0.38, click: 0.65, drive: 0.45 },
    snare: { tone: 215, snappy: 0.75, decay: 0.22, brightness: 3600 },
    clap: { tone: 1450, decay: 0.22, spread: 0.009 },
    hat: { tone: 0.85, decay: 0.04 },
    openHat: { tone: 0.85, decay: 0.35 },
  },
  lofi: {
    kick: { pitch: 52, sweep: 16, sweepTime: 0.04, decay: 0.42, click: 0, drive: 0.65 },
    snare: { tone: 170, snappy: 0.45, decay: 0.26, brightness: 1400 },
    clap: { tone: 900, decay: 0.3, spread: 0.011 },
    hat: { tone: 0.18, decay: 0.06 },
    openHat: { tone: 0.2, decay: 0.4 },
  },
  boombap: {
    kick: { pitch: 54, sweep: 20, sweepTime: 0.035, decay: 0.5, click: 0.45, drive: 0.6 },
    snare: { tone: 195, snappy: 0.62, decay: 0.24, brightness: 2200 },
    clap: { tone: 1100, decay: 0.26, spread: 0.012 },
    hat: { tone: 0.45, decay: 0.045 },
    openHat: { tone: 0.5, decay: 0.38 },
  },
  // Festival (big room, trance): a tight, clicky kick with a short tail, a bright snappy snare and clap.
  edm: {
    kick: { pitch: 54, sweep: 34, sweepTime: 0.026, decay: 0.34, click: 0.7, drive: 0.55 },
    snare: { tone: 220, snappy: 0.8, decay: 0.2, brightness: 4000 },
    clap: { tone: 1500, decay: 0.24, spread: 0.008 },
    hat: { tone: 0.9, decay: 0.035 },
    openHat: { tone: 0.9, decay: 0.3 },
  },
  // Bass music (future bass, dubstep, melodic dubstep): a short sub-heavy kick and a big, dark half-time snare.
  bass: {
    kick: { pitch: 48, sweep: 28, sweepTime: 0.03, decay: 0.3, click: 0.5, drive: 0.55 },
    snare: { tone: 200, snappy: 0.6, decay: 0.2, brightness: 3000 },
    clap: { tone: 1300, decay: 0.3, spread: 0.012 },
    hat: { tone: 0.8, decay: 0.03 },
    openHat: { tone: 0.8, decay: 0.45 },
  },
  // Drum & bass: a tight kick and a high, cracking snare.
  dnb: {
    kick: { pitch: 58, sweep: 30, sweepTime: 0.022, decay: 0.22, click: 0.6, drive: 0.5 },
    snare: { tone: 250, snappy: 0.8, decay: 0.16, brightness: 4200 },
    clap: { tone: 1600, decay: 0.18, spread: 0.008 },
    hat: { tone: 0.9, decay: 0.025 },
    openHat: { tone: 0.9, decay: 0.25 },
  },
};

/** Cuts what is left once a hit has died away (−80 dB under its peak); a kick without click runs on silent. */
function trimSilence(x: Float32Array, sampleRate: number): Float32Array {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i] as number));
  const floor = peak * 1e-4;
  let end = x.length;
  while (end > 1 && Math.abs(x[end - 1] as number) < floor) end--;
  return x.slice(0, Math.min(x.length, end + Math.round(0.005 * sampleRate)));
}

/** Peak over RMS of a hit's first 100 ms, in dB. */
function crestDb(x: Float32Array, sampleRate: number): number {
  const n = Math.min(x.length, Math.round(0.1 * sampleRate));
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i] as number;
    peak = Math.max(peak, Math.abs(v));
    sum += v * v;
  }
  return sum > 0 ? 20 * Math.log10(peak / Math.sqrt(sum / n)) : 0;
}

/**
 * Soft-clips a hit (tanh) just enough to bring its crest factor down to `maxCrestDb`. The model
 * snares are much peakier than the stock one: at the same peak they would sound ~5 dB quieter.
 */
function tame(x: Float32Array, sampleRate: number, maxCrestDb: number): Float32Array {
  if (crestDb(x, sampleRate) <= maxCrestDb) return x;
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i] as number));
  const shaped = (g: number) => x.map((v) => Math.tanh((g * v) / peak));
  let lo = 0.01;
  let hi = 8;
  for (let k = 0; k < 24; k++) {
    const mid = (lo + hi) / 2;
    if (crestDb(shaped(mid), sampleRate) > maxCrestDb) lo = mid;
    else hi = mid;
  }
  return shaped(hi);
}

/** One hit of a drum model, normalized to the stock kit's peak for that piece. */
function drumHit(voice: DrumModel, peak: number, maxCrestDb = Infinity): Float32Array[] {
  const sr = voice.sampleRate;
  return normalize([tame(trimSilence(renderDrum(voice, 1, 3), sr), sr, maxCrestDb)], peak);
}

/** The stock snare's crest factor is ~12 dB; a genre snare may be up to this peaky. */
const SNARE_CREST_DB = 13.5;

function genreKit(kit: KitStyle): Record<string, Generator> {
  const k = GENRE_SETTINGS[kit];
  return {
    [`kit/${kit}/kick`]: (sr, seed) => drumHit(Object.assign(new Kick(sr, seed), k.kick), 0.9),
    [`kit/${kit}/snare`]: (sr, seed) => drumHit(Object.assign(new Snare(sr, seed), k.snare), 0.9, SNARE_CREST_DB),
    [`kit/${kit}/clap`]: (sr, seed) => drumHit(Object.assign(new Clap(sr, seed), k.clap), 0.9),
    // The Drum Synth's noise mix for closed and open hats.
    [`kit/${kit}/hat`]: (sr, seed) => drumHit(Object.assign(new HiHat(sr, seed), k.hat, { noiseMix: 0.25 }), 0.8),
    [`kit/${kit}/open-hat`]: (sr, seed) =>
      drumHit(Object.assign(new HiHat(sr, seed), k.openHat, { noiseMix: 0.32 }), 0.8),
  };
}

export const GENERATORS: Readonly<Record<string, Generator>> = {
  'kit/kick': kick,
  'kit/snare': snare,
  'kit/clap': clap,
  'kit/hat-closed': hat(0.14, 0.022),
  'kit/hat-open': hat(0.7, 0.2),
  'kit/tom-low': tom(92),
  'kit/tom-mid': tom(128),
  'kit/tom-high': tom(176),
  'kit/rim': rim,
  'kit/cowbell': cowbell,
  'kit/crash': crash,
  ...Object.assign({}, ...KIT_STYLES.map(genreKit)),
};

/** Seed derived from the generator name so each sound has stable, distinct noise. */
export function seedFor(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function generate(name: string, sampleRate: number): Float32Array[] | null {
  const gen = GENERATORS[name];
  return gen ? gen(sampleRate, seedFor(name)) : null;
}
