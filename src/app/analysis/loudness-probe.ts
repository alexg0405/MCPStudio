import { LoudnessMeter, TruePeak } from '@agstudio/sdk';

/**
 * The loudness report's measurer: everything the Meters window shows live, over a whole recording, with where the
 * loudest moments are. It runs the same BS.1770 meter and 4× true-peak detector as the audio thread, so a report and
 * the live meters agree. `push` takes the audio in pieces so a caller can yield between them.
 */
export interface ProbeResult {
  /** Integrated loudness (LUFS, gated) and loudness range (LU). */
  integrated: number;
  range: number;
  /** Highest true peak over both channels (dBTP) and the second it happened at (−Infinity and null when silent). */
  truePeakDb: number;
  truePeakSec: number | null;
  samplePeakDb: number;
  maxMomentary: number;
  maxMomentarySec: number | null;
  maxShortTerm: number;
  maxShortTermSec: number | null;
  /** Correlation of the whole recording, −1…1, and the dB it loses summed to mono (0 for mono, −3 unrelated). */
  correlation: number;
  monoLossDb: number;
  seconds: number;
}

const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

export class LoudnessProbe {
  private readonly meter: LoudnessMeter;
  private readonly tpL = new TruePeak();
  private readonly tpR = new TruePeak();
  private frame = 0;
  private maxTp = 0;
  private maxTpFrame = -1;
  private maxSample = 0;
  private maxMomentary = -Infinity;
  private maxMomentaryFrame = -1;
  private maxShort = -Infinity;
  private maxShortFrame = -1;
  private ll = 0;
  private rr = 0;
  private lr = 0;

  constructor(private readonly sampleRate: number) {
    this.meter = new LoudnessMeter(sampleRate, 2);
  }

  push(left: Float32Array, right: Float32Array, from = 0, to = left.length): void {
    const meter = this.meter;
    for (let i = from; i < to; i++) {
      const l = left[i] as number;
      const r = right[i] as number;
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > this.maxSample) this.maxSample = al;
      if (ar > this.maxSample) this.maxSample = ar;
      const t = Math.max(this.tpL.process(l), this.tpR.process(r));
      if (t > this.maxTp) {
        this.maxTp = t;
        this.maxTpFrame = this.frame - TruePeak.LATENCY;
      }
      this.ll += l * l;
      this.rr += r * r;
      this.lr += l * r;
      meter.process(l, r);
      if (meter.momentary > this.maxMomentary) {
        this.maxMomentary = meter.momentary;
        this.maxMomentaryFrame = this.frame;
      }
      if (meter.shortTerm > this.maxShort) {
        this.maxShort = meter.shortTerm;
        this.maxShortFrame = this.frame;
      }
      this.frame++;
    }
  }

  result(): ProbeResult {
    const sec = (f: number) => (f >= 0 ? f / this.sampleRate : null);
    const energy = Math.sqrt(this.ll * this.rr);
    const total = this.ll + this.rr;
    const kept = total > 1e-12 ? (total + 2 * this.lr) / (2 * total) : 1;
    return {
      integrated: this.meter.integrated,
      range: this.meter.range,
      truePeakDb: db(Math.max(this.maxTp, this.maxSample)),
      truePeakSec: this.maxTp > 0 ? sec(Math.max(0, this.maxTpFrame)) : null,
      samplePeakDb: db(this.maxSample),
      maxMomentary: this.maxMomentary,
      maxMomentarySec: sec(this.maxMomentaryFrame),
      maxShortTerm: this.maxShort,
      maxShortTermSec: sec(this.maxShortFrame),
      correlation: energy > 1e-12 ? Math.max(-1, Math.min(1, this.lr / energy)) : 1,
      monoLossDb: kept > 1e-6 ? 10 * Math.log10(Math.min(1, kept)) : -60,
      seconds: this.frame / this.sampleRate,
    };
  }
}

/** Measures a whole recording at once. */
export function probeLoudness(left: Float32Array, right: Float32Array, sampleRate: number): ProbeResult {
  const p = new LoudnessProbe(sampleRate);
  p.push(left, right);
  return p.result();
}
