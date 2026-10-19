/**
 * Paints the Visualizer window on the frame loop (no React renders): the spectrum over its grid, the left and right
 * waveforms and their peak readouts. While nothing plays it looks only every fourth frame, and a silent picture is
 * drawn once and then left alone.
 */
import type { Services } from '@app/services';
import { onFrame } from '../../frame-loop';
import { fitCanvas, readTheme } from '../../timeline/canvas';
import { DB_FLOOR, drawScope, drawSpectrum, drawSpectrumGrid, peakOf, peakText } from './draw';

/** The elements the controller draws into and writes to. */
export interface VisualizerElements {
  spectrum: HTMLCanvasElement;
  scope: HTMLCanvasElement;
  peakLeft: HTMLElement | null;
  peakRight: HTMLElement | null;
  /** The "Press play" text, hidden while there is sound. */
  idle: HTMLElement | null;
}

/** Samples of each channel's waveform shown. */
const WAVE_SAMPLES = 2048;
/** Below this peak (linear) on both channels the picture counts as silent. */
const SILENCE_PEAK = 1e-4;
/** While nothing plays the picture is looked at only every this many frames. */
const IDLE_FRAME_STRIDE = 4;
/** Smoothing of the spectrum drawing (0 to 1). */
const SPECTRUM_SMOOTHING = 0.3;

export class VisualizerController {
  private readonly tap;
  private readonly left = new Float32Array(WAVE_SAMPLES);
  private readonly right = new Float32Array(WAVE_SAMPLES);
  private bins = new Float32Array(0);
  /** The canvases' sizes in CSS px. */
  private spectrumW = 0;
  private spectrumH = 0;
  private scopeW = 0;
  private scopeH = 0;
  private frameCount = 0;
  /** null: draw the next frame even if it is silent (first frame, or the canvas was resized). */
  private wasSilent: boolean | null = null;
  /** The peak last written to each readout (NaN: none yet). */
  private readonly shownPeak = [Number.NaN, Number.NaN];
  private stopFrames: (() => void) | null = null;
  private observer: ResizeObserver | null = null;

  constructor(
    private readonly services: Services,
    private readonly els: VisualizerElements,
  ) {
    this.tap = services.engine.outputTap();
  }

  /** Starts painting; returns what stops it. */
  start(): () => void {
    this.measure();
    this.observer = new ResizeObserver(() => this.measure());
    this.observer.observe(this.els.spectrum);
    this.observer.observe(this.els.scope);
    this.stopFrames = onFrame(() => this.frame());
    return () => this.stop();
  }

  private stop(): void {
    this.stopFrames?.();
    this.observer?.disconnect();
  }

  private measure(): void {
    this.spectrumW = this.els.spectrum.clientWidth;
    this.spectrumH = this.els.spectrum.clientHeight;
    this.scopeW = this.els.scope.clientWidth;
    this.scopeH = this.els.scope.clientHeight;
    this.wasSilent = null;
  }

  private frame(): void {
    if (!this.services.engine.playing && ++this.frameCount % IDLE_FRAME_STRIDE !== 0) return;
    const theme = readTheme();
    const { tap, left, right } = this;
    const isActive = tap.active;
    if (isActive && this.bins.length !== tap.fftSize / 2) this.bins = new Float32Array(tap.fftSize / 2);
    const gotSpectrum = isActive && tap.spectrum(this.bins);
    const gotWave = isActive && tap.waveform(left, 0) && tap.waveform(right, 1);
    const peakLeft = gotWave ? peakOf(left) : 0;
    const peakRight = gotWave ? peakOf(right) : 0;
    const isSilent = peakLeft < SILENCE_PEAK && peakRight < SILENCE_PEAK;
    if (isSilent !== this.wasSilent && this.els.idle) this.els.idle.style.display = isSilent ? '' : 'none';
    if (isSilent && this.wasSilent === true) return;
    this.wasSilent = isSilent;

    this.drawSpectrumPanel(gotSpectrum && !isSilent, theme);
    this.drawScopePanel(gotWave && !isSilent, theme);
    this.showPeaks(peakLeft, peakRight);
  }

  /** The grid, and the spectrum over it when there is a signal above the floor. */
  private drawSpectrumPanel(hasSpectrum: boolean, theme: ReturnType<typeof readTheme>): void {
    const { spectrumW: w, spectrumH: h, bins, tap } = this;
    const g = fitCanvas(this.els.spectrum, w, h);
    g.clearRect(0, 0, w, h);
    drawSpectrumGrid(g, w, h, theme);
    if (!hasSpectrum) return;
    let loudest = -Infinity;
    for (let i = 0; i < bins.length; i++) if ((bins[i] as number) > loudest) loudest = bins[i] as number;
    if (loudest > DB_FLOOR) drawSpectrum(g, w, h, bins, tap.sampleRate, tap.fftSize, theme.accent, SPECTRUM_SMOOTHING);
  }

  /** The centre line, and the left (accent) and right (select colour) waveforms when there is a signal. */
  private drawScopePanel(hasWave: boolean, theme: ReturnType<typeof readTheme>): void {
    const { scopeW: w, scopeH: h } = this;
    const g = fitCanvas(this.els.scope, w, h);
    g.clearRect(0, 0, w, h);
    g.fillStyle = theme.lineFaint;
    g.fillRect(0, Math.floor(h / 2), w, 1);
    if (!hasWave) return;
    g.globalAlpha = 0.9;
    drawScope(g, w, h, this.left, theme.accent, 1.25);
    g.globalAlpha = 0.6;
    drawScope(g, w, h, this.right, theme.select, 1.25);
    g.globalAlpha = 1;
  }

  /** The readouts are only rewritten when their peak changes (a steady level builds no text). */
  private showPeaks(peakLeft: number, peakRight: number): void {
    const { peakLeft: leftEl, peakRight: rightEl } = this.els;
    if (leftEl && peakLeft !== this.shownPeak[0]) {
      this.shownPeak[0] = peakLeft;
      leftEl.textContent = peakText(peakLeft);
    }
    if (rightEl && peakRight !== this.shownPeak[1]) {
      this.shownPeak[1] = peakRight;
      rightEl.textContent = peakText(peakRight);
    }
  }
}
