import type { TimelineTheme } from '../../timeline/canvas';

/** Frequencies the spectrum shows (log axis) and its dB range. */
export const SPECTRUM_LO = 30;
export const SPECTRUM_HI = 18000;
export const DB_FLOOR = -90;

/** x (0–w) of a frequency on the log axis. */
export function freqX(hz: number, w: number): number {
  return (Math.log(hz / SPECTRUM_LO) / Math.log(SPECTRUM_HI / SPECTRUM_LO)) * w;
}

/** y (0–h) of a level in dB (0 dB at the top, DB_FLOOR at the bottom). */
export function dbY(db: number, h: number): number {
  return (Math.min(0, Math.max(DB_FLOOR, db)) / DB_FLOOR) * h;
}

/** A waveform (−1…1) across the whole width, centred. */
export function drawScope(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  samples: Float32Array,
  color: string,
  lineWidth = 1,
): void {
  const n = samples.length;
  if (n < 2) return;
  g.strokeStyle = color;
  g.lineWidth = lineWidth;
  g.beginPath();
  for (let x = 0; x < w; x++) {
    const v = samples[Math.min(n - 1, Math.floor((x / w) * n))] as number;
    const y = h / 2 - Math.max(-1, Math.min(1, v)) * (h / 2 - 1);
    if (x === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
}

/**
 * A magnitude spectrum (dBFS per bin; bin k at k · sampleRate / fftSize Hz) on the log axis, as a
 * filled shape. Each pixel column shows the loudest bin under it.
 */
export function drawSpectrum(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  bins: Float32Array,
  sampleRate: number,
  fftSize: number,
  color: string,
  fillAlpha = 0.3,
): void {
  const hzPerBin = sampleRate / fftSize;
  g.beginPath();
  g.moveTo(0, h);
  let prev = Math.max(1, Math.floor(SPECTRUM_LO / hzPerBin));
  for (let x = 0; x <= w; x++) {
    const hz = SPECTRUM_LO * Math.pow(SPECTRUM_HI / SPECTRUM_LO, x / w);
    const bin = Math.min(bins.length - 1, Math.max(prev, Math.round(hz / hzPerBin)));
    let db = -Infinity;
    for (let k = prev; k <= bin; k++) db = Math.max(db, bins[k] as number);
    prev = bin + 1 <= bins.length - 1 ? bin + 1 : bin;
    g.lineTo(x, dbY(Number.isFinite(db) ? db : DB_FLOOR, h));
  }
  g.lineTo(w, h);
  g.closePath();
  g.fillStyle = color;
  g.globalAlpha = fillAlpha;
  g.fill();
  g.globalAlpha = 1;
  g.strokeStyle = color;
  g.lineWidth = 1;
  g.stroke();
}

/** Grid lines and labels for the spectrum: 100 Hz, 1 kHz, 10 kHz and every 12 dB. */
export function drawSpectrumGrid(g: CanvasRenderingContext2D, w: number, h: number, theme: TimelineTheme): void {
  g.font = `10px ${theme.font}`;
  g.fillStyle = theme.textDim;
  g.strokeStyle = theme.beat;
  g.lineWidth = 1;
  for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = Math.round(freqX(hz, w)) + 0.5;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
    g.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), x + 3, h - 4);
  }
  for (let db = -12; db > DB_FLOOR; db -= 12) {
    const y = Math.round(dbY(db, h)) + 0.5;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
    g.fillText(`${db} dB`, 3, y - 3);
  }
}

/** Largest absolute sample. */
export function peakOf(samples: Float32Array): number {
  let m = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i] as number);
    if (v > m) m = v;
  }
  return m;
}

/** A peak as text in dBFS ("−6.0 dB", "−∞" for silence). */
export function peakText(peak: number): string {
  if (peak < 1e-5) return '−∞ dB';
  const db = 20 * Math.log10(peak);
  return `${db < 0 ? '−' : '+'}${Math.abs(db).toFixed(1)} dB`;
}
