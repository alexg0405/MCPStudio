import { LinkwitzRiley, LoudnessMeter, TruePeak } from '@agstudio/sdk';

/**
 * What a stereo recording measures like, for mixing advice: loudness (LUFS, BS.1770), peaks,
 * crest factor, how its energy splits over six bands, stereo width and correlation. Pure and
 * allocation-light; `Measurer` takes the audio in pieces so a caller can yield between them.
 */
export const BANDS = [
  { id: 'sub', label: 'sub (below 60 Hz)' },
  { id: 'low', label: 'lows (60–250 Hz)' },
  { id: 'lowMid', label: 'low mids (250 Hz–1 kHz)' },
  { id: 'mid', label: 'mids (1–4 kHz)' },
  { id: 'presence', label: 'presence (4–10 kHz)' },
  { id: 'air', label: 'air (above 10 kHz)' },
] as const;
const CROSSOVERS = [60, 250, 1000, 4000, 10000];

export interface Measurement {
  /** Integrated loudness (LUFS), and the loudest 3 s. −Infinity for silence. */
  lufs: number;
  shortTermMax: number;
  peakDb: number;
  /** Between samples too (4× oversampled); only when asked for (it costs more). */
  truePeakDb: number | null;
  rmsDb: number;
  /** Peak over RMS in dB: high = punchy and dynamic, low = squashed or sustained. */
  crestDb: number;
  /** Share of the energy in each of BANDS, in percent (adds up to 100). */
  bands: number[];
  /** Side energy over mid energy: 0 = mono, about 1 = very wide, above 1 = more out of phase than in. */
  width: number;
  /** −1…1: 1 = mono, 0 = unrelated channels, below 0 = cancels in mono. */
  correlation: number;
  silent: boolean;
}

const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

export class Measurer {
  private readonly meter: LoudnessMeter;
  private readonly splits = CROSSOVERS.map(() => new LinkwitzRiley());
  private readonly band = new Float64Array(BANDS.length);
  private readonly tpL: TruePeak | null;
  private readonly tpR: TruePeak | null;
  private peak = 0;
  private truePeak = 0;
  private sumSq = 0;
  private mid = 0;
  private side = 0;
  private lr = 0;
  private ll = 0;
  private rr = 0;
  private frames = 0;
  private shortMax = -Infinity;

  constructor(
    private readonly sampleRate: number,
    truePeak = false,
  ) {
    this.meter = new LoudnessMeter(sampleRate, 2);
    CROSSOVERS.forEach((f, i) => (this.splits[i] as LinkwitzRiley).set(f, sampleRate));
    this.tpL = truePeak ? new TruePeak() : null;
    this.tpR = truePeak ? new TruePeak() : null;
  }

  push(left: Float32Array, right: Float32Array, from = 0, to = left.length): void {
    const splits = this.splits;
    const band = this.band;
    for (let i = from; i < to; i++) {
      const l = left[i] as number;
      const r = right[i] as number;
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > this.peak) this.peak = al;
      if (ar > this.peak) this.peak = ar;
      if (this.tpL && this.tpR) {
        const t = Math.max(this.tpL.process(l), this.tpR.process(r));
        if (t > this.truePeak) this.truePeak = t;
      }
      this.sumSq += l * l + r * r;
      const m = (l + r) * 0.5;
      const sd = (l - r) * 0.5;
      this.mid += m * m;
      this.side += sd * sd;
      this.lr += l * r;
      this.ll += l * l;
      this.rr += r * r;
      // Bands of the mid signal: split off the lowest band, then split what is above again.
      let rest = m;
      for (let b = 0; b < splits.length; b++) {
        const x = splits[b] as LinkwitzRiley;
        x.split(rest);
        band[b] = (band[b] as number) + x.low * x.low;
        rest = x.high;
      }
      band[splits.length] = (band[splits.length] as number) + rest * rest;
      this.meter.process(l, r);
      if (this.meter.shortTerm > this.shortMax) this.shortMax = this.meter.shortTerm;
    }
    this.frames += to - from;
  }

  result(): Measurement {
    const n = Math.max(1, this.frames);
    const rms = Math.sqrt(this.sumSq / (2 * n));
    const total = this.band.reduce((a, b) => a + b, 0);
    const silent = this.peak < 1e-5;
    return {
      lufs: this.meter.integrated,
      shortTermMax: this.shortMax,
      peakDb: db(this.peak),
      truePeakDb: this.tpL ? db(Math.max(this.truePeak, this.peak)) : null,
      rmsDb: db(rms),
      crestDb: silent ? 0 : db(this.peak) - db(rms),
      bands: [...this.band].map((e) => (total > 0 ? (100 * e) / total : 0)),
      width: this.mid > 0 ? this.side / this.mid : this.side > 0 ? Infinity : 0,
      correlation: this.ll > 0 && this.rr > 0 ? this.lr / Math.sqrt(this.ll * this.rr) : 1,
      silent,
    };
  }
}

/** Measures a whole recording at once. */
export function measure(left: Float32Array, right: Float32Array, sampleRate: number, truePeak = false): Measurement {
  const m = new Measurer(sampleRate, truePeak);
  m.push(left, right);
  return m.result();
}
