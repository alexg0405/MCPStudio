/**
 * The Meters window's spectrum: the audio thread's FFT power folded into 1/6-octave bands, smoothed over time, with a
 * peak hold, an optional tilt and an optional reference tone curve. Imperative (no React): it keeps its arrays between
 * frames and draws on a canvas from the frame loop.
 */
import { BandMap, octaveEdges, powerToDb, tiltDb } from '@core/metering/octave';
import type { MeterHandle } from '@engine/api';
import { R, SPECTRUM_SIZE } from '@engine/meter/layout';
import { alpha, type TimelineTheme } from '../../timeline/canvas';

export const SPECTRUM_LOW_HZ = 20;
export const SPECTRUM_HIGH_HZ = 20000;
const BANDS_PER_OCTAVE = 6;
/** The levels drawn, in dB (a full-scale sine is 0 dB). */
export const SPECTRUM_TOP_DB = 0;
export const SPECTRUM_BOTTOM_DB = -90;
/** Per spectrum update (about 23 a second): how much of a new level is taken when it rises and when it falls. */
const RISE_SMOOTHING = 0.6;
const FALL_SMOOTHING = 0.18;
/** The peak line stays this long, then falls this fast (ms, dB per second). */
const PEAK_HOLD_MS = 1500;
const PEAK_FALL_DB_PER_SECOND = 12;
const GRID_HZ = [50, 100, 200, 500, 1000, 2000, 5000, 10000];

export class SpectrumView {
  private map: BandMap | null = null;
  private sampleRate = 0;
  private seenSequence = -1;
  private bandPower = new Float64Array(0);
  /** Smoothed level per band (dB, tilt applied). */
  levels = new Float64Array(0);
  private peaks = new Float64Array(0);
  private peakUntil = new Float64Array(0);
  private lastUpdateMs = 0;
  /** Total power of the smoothed spectrum in dB (before the tilt): where the reference curve is placed. */
  totalDb = -Infinity;

  /** Number of bands (0 until the first update has a sample rate). */
  get bandCount(): number {
    return this.map?.count ?? 0;
  }

  /** The bands, for the reference curve and the spectrogram. */
  get bands(): BandMap | null {
    return this.map;
  }

  /**
   * Takes a new spectrum from the meter when there is one. Returns how many spectra the audio thread made since the
   * last call (0: nothing new), so a slow frame rate can still keep the spectrogram's time scale.
   */
  update(meter: MeterHandle, nowMs: number, slopeDb: number): number {
    const sequence = meter.readings[R.spectrumSeq] as number;
    if (!meter.active || meter.sampleRate === 0 || sequence === this.seenSequence) return 0;
    const made = this.seenSequence < 0 ? 1 : Math.max(1, sequence - this.seenSequence);
    this.seenSequence = sequence;
    const map = this.mapFor(meter.sampleRate);
    map.fold(meter.spectrum, this.bandPower);
    let total = 0;
    const fallDb = (PEAK_FALL_DB_PER_SECOND * Math.max(0, nowMs - this.lastUpdateMs)) / 1000;
    this.lastUpdateMs = nowMs;
    for (let band = 0; band < map.count; band++) {
      const power = this.bandPower[band] as number;
      total += power;
      const target = powerToDb(power) + tiltDb(map.centers[band] as number, slopeDb);
      const old = this.levels[band] as number;
      this.levels[band] = old + (target - old) * (target > old ? RISE_SMOOTHING : FALL_SMOOTHING);
      if (this.levels[band]! >= (this.peaks[band] as number)) {
        this.peaks[band] = this.levels[band] as number;
        this.peakUntil[band] = nowMs + PEAK_HOLD_MS;
      } else if (nowMs > (this.peakUntil[band] as number)) {
        this.peaks[band] = Math.max(this.levels[band] as number, (this.peaks[band] as number) - fallDb);
      }
    }
    this.totalDb = powerToDb(total);
    return made;
  }

  /** Forgets the levels (the meter was restarted or its source changed). */
  clear(): void {
    this.levels.fill(SPECTRUM_BOTTOM_DB);
    this.peaks.fill(SPECTRUM_BOTTOM_DB);
    this.seenSequence = -1;
    this.totalDb = -Infinity;
  }

  /** The curve, the peak hold, the grid and, if given, a reference curve (dB per band, same bands) as a dashed line. */
  draw(g: CanvasRenderingContext2D, width: number, height: number, theme: TimelineTheme, reference: Float64Array | null): void {
    g.clearRect(0, 0, width, height);
    this.drawGrid(g, width, height, theme);
    const count = this.bandCount;
    if (count === 0) return;
    this.fillCurve(g, width, height, theme);
    this.lineOf(g, width, height, this.peaks, alpha(theme.text, 0.55), 1, []);
    if (reference) this.lineOf(g, width, height, reference, theme.select, 1.5, [5, 4]);
  }

  private mapFor(sampleRate: number): BandMap {
    if (this.map && sampleRate === this.sampleRate) return this.map;
    this.sampleRate = sampleRate;
    this.map = new BandMap(octaveEdges(BANDS_PER_OCTAVE, SPECTRUM_LOW_HZ, SPECTRUM_HIGH_HZ), sampleRate, SPECTRUM_SIZE);
    const count = this.map.count;
    this.bandPower = new Float64Array(count);
    this.levels = new Float64Array(count).fill(SPECTRUM_BOTTOM_DB);
    this.peaks = new Float64Array(count).fill(SPECTRUM_BOTTOM_DB);
    this.peakUntil = new Float64Array(count);
    return this.map;
  }

  private bandX(band: number, width: number): number {
    const map = this.map as BandMap;
    return (Math.log(map.centers[band] as number / SPECTRUM_LOW_HZ) / Math.log(SPECTRUM_HIGH_HZ / SPECTRUM_LOW_HZ)) * width;
  }

  private levelY(db: number, height: number): number {
    const clamped = Math.min(SPECTRUM_TOP_DB, Math.max(SPECTRUM_BOTTOM_DB, db));
    return ((SPECTRUM_TOP_DB - clamped) / (SPECTRUM_TOP_DB - SPECTRUM_BOTTOM_DB)) * height;
  }

  private tracePath(g: CanvasRenderingContext2D, width: number, height: number, values: Float64Array): void {
    for (let band = 0; band < values.length; band++) {
      const x = this.bandX(band, width);
      const y = this.levelY(values[band] as number, height);
      if (band === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
  }

  private fillCurve(g: CanvasRenderingContext2D, width: number, height: number, theme: TimelineTheme): void {
    g.beginPath();
    g.moveTo(0, height);
    this.tracePath(g, width, height, this.levels);
    g.lineTo(width, this.levelY(this.levels[this.levels.length - 1] as number, height));
    g.lineTo(width, height);
    g.closePath();
    const fill = g.createLinearGradient(0, 0, 0, height);
    fill.addColorStop(0, alpha(theme.accent, 0.5));
    fill.addColorStop(1, alpha(theme.accent, 0.03));
    g.fillStyle = fill;
    g.fill();
    g.strokeStyle = theme.accent;
    g.lineWidth = 1.5;
    g.lineJoin = 'round';
    g.beginPath();
    this.tracePath(g, width, height, this.levels);
    g.stroke();
  }

  private lineOf(g: CanvasRenderingContext2D, width: number, height: number, values: Float64Array, color: string, lineWidth: number, dash: number[]): void {
    g.save();
    g.strokeStyle = color;
    g.lineWidth = lineWidth;
    g.setLineDash(dash);
    g.lineJoin = 'round';
    g.beginPath();
    let drawing = false;
    for (let band = 0; band < values.length; band++) {
      const db = values[band] as number;
      if (db <= SPECTRUM_BOTTOM_DB) {
        drawing = false;
        continue;
      }
      const x = this.bandX(band, width);
      const y = this.levelY(db, height);
      if (drawing) g.lineTo(x, y);
      else g.moveTo(x, y);
      drawing = true;
    }
    g.stroke();
    g.restore();
  }

  private drawGrid(g: CanvasRenderingContext2D, width: number, height: number, theme: TimelineTheme): void {
    g.font = `500 10px ${theme.font}`;
    g.fillStyle = theme.textFaint;
    g.strokeStyle = theme.lineFaint;
    g.lineWidth = 1;
    const logSpan = Math.log(SPECTRUM_HIGH_HZ / SPECTRUM_LOW_HZ);
    for (const hz of GRID_HZ) {
      const x = Math.round((Math.log(hz / SPECTRUM_LOW_HZ) / logSpan) * width) + 0.5;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, height);
      g.stroke();
      g.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), x + 3, height - 4);
    }
    for (let db = -12; db > SPECTRUM_BOTTOM_DB; db -= 12) {
      const y = Math.round(this.levelY(db, height)) + 0.5;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(width, y);
      g.stroke();
      g.fillText(`${db} dB`, 3, y - 3);
    }
  }
}
