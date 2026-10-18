/**
 * The Meters window's frame-by-frame work, outside React: it reads the meter's shared memory on the frame loop and
 * writes the readouts' text and the canvases. Nothing here causes a React render, and a silent, idle meter draws
 * nothing. Elements are found by `data-meter` (text) and `data-canvas` (drawing) attributes in the window's markup.
 */
import { TONE_CROSSOVERS } from '@core/reference/bands';
import { referenceCurve, tiltDb } from '@core/metering/octave';
import { againstTarget } from '@core/metering/targets';
import type { Project } from '@core/model/types';
import type { MeterHandle } from '@engine/api';
import { R } from '@engine/meter/layout';
import type { Services } from '@app/services';
import type { ResolvedTarget } from '@app/metering/targets';
import { onFrame } from '../../frame-loop';
import { fitCanvas, readTheme, type TimelineTheme } from '../../timeline/canvas';
import { drawHistory, historyLength } from './history-view';
import {
  correlationText,
  loudnessState,
  lufsText,
  monoWarning,
  peakDbText,
  peakState,
} from './meters-model';
import { SpectrogramView } from './spectrogram-view';
import { SPECTRUM_BOTTOM_DB, SpectrumView } from './spectrum-view';
import { drawGoniometer, drawStereoBars } from './stereo-view';

/** While the song is stopped the window redraws at one frame in this many (a drawing that does not move needs no 60 Hz). */
const IDLE_FRAME_DIVIDER = 4;
/** Readout text is rewritten at most this often (ms): digits that change faster cannot be read. */
const READOUT_EVERY_MS = 100;
/** After this many spectrum updates in silence the spectrum and spectrogram stop redrawing (about 3 s). */
const SILENT_UPDATES_BEFORE_IDLE = 70;
const SILENT_TOTAL_DB = -100;
/** A frame that was very late paints at most this many spectrogram columns (the rest is skipped, not caught up). */
const MAX_COLUMNS_PER_FRAME = 12;

type CanvasName = 'history' | 'gonio' | 'bars' | 'spectrum' | 'spectrogram';

interface CanvasBox {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

/** The text of the window's numbers, rewritten only when it changes. */
class Readouts {
  private readonly elements = new Map<string, HTMLElement>();
  private readonly texts = new Map<string, string>();
  private readonly states = new Map<string, string>();

  constructor(root: HTMLElement) {
    for (const element of root.querySelectorAll<HTMLElement>('[data-meter]')) this.elements.set(element.dataset.meter as string, element);
  }

  set(name: string, text: string, state?: string): void {
    const element = this.elements.get(name);
    if (!element) return;
    if (this.texts.get(name) !== text) {
      this.texts.set(name, text);
      element.textContent = text;
    }
    if (state !== undefined && this.states.get(name) !== state) {
      this.states.set(name, state);
      element.dataset.state = state;
    }
  }

  hide(name: string, hidden: boolean): void {
    const element = this.elements.get(name);
    if (element) element.hidden = hidden;
  }
}

export class MetersController {
  /** Draw the reference song's tonal balance over the spectrum (when the project has one). */
  showReference = true;
  private readonly boxes = new Map<CanvasName, CanvasBox>();
  private readonly observer: ResizeObserver;
  private readonly readouts: Readouts;
  private readonly spectrum = new SpectrumView();
  private readonly spectrogram = new SpectrogramView();
  private readonly stopFrames: () => void;
  private frameCount = 0;
  private lastReadoutMs = 0;
  private lastSignature = new Float64Array(6).fill(Number.NaN);
  private silentUpdates = 0;
  private resizedSince = true;
  private resetSeen = -1;
  private cachedProject: Project | null = null;
  private cachedChoice = '';
  private target: ResolvedTarget = { choice: 'none', label: 'No target', lufs: null };
  private referenceLine: Float64Array | null = null;

  constructor(
    private readonly services: Services,
    private readonly meter: () => MeterHandle,
    private readonly root: HTMLElement,
  ) {
    this.readouts = new Readouts(root);
    this.observer = new ResizeObserver(() => this.measure());
    for (const name of ['history', 'gonio', 'bars', 'spectrum', 'spectrogram'] as const) {
      const canvas = root.querySelector<HTMLCanvasElement>(`[data-canvas="${name}"]`);
      if (!canvas) continue;
      this.boxes.set(name, { canvas, width: 0, height: 0 });
      this.observer.observe(canvas);
    }
    this.measure();
    this.stopFrames = onFrame((now) => this.frame(now));
  }

  dispose(): void {
    this.stopFrames();
    this.observer.disconnect();
  }

  /** The user changed something that needs a fresh picture (the target, the slope, the reference toggle). */
  invalidate(): void {
    this.lastSignature.fill(Number.NaN);
    this.cachedChoice = '';
    this.resizedSince = true;
  }

  private measure(): void {
    for (const box of this.boxes.values()) {
      box.width = box.canvas.clientWidth;
      box.height = box.canvas.clientHeight;
    }
    this.resizedSince = true;
  }

  private frame(now: number): void {
    const meter = this.meter();
    if (!this.services.engine.playing && ++this.frameCount % IDLE_FRAME_DIVIDER !== 0) return;
    const readings = meter.readings;
    this.followReset(meter);
    this.refreshTarget();
    const slope = this.services.meters.store.getState().slopeDb;
    const newSpectra = this.spectrum.update(meter, now, slope);
    const gotSpectrum = newSpectra > 0;
    this.trackSilence(gotSpectrum);
    if (now - this.lastReadoutMs >= READOUT_EVERY_MS) {
      this.lastReadoutMs = now;
      this.writeReadouts(meter);
    }
    const signature = this.lastSignature;
    const unchanged =
      !this.resizedSince &&
      signature[0] === readings[R.histCount] &&
      signature[1] === readings[R.scopePos] &&
      signature[2] === readings[R.correlation] &&
      signature[3] === readings[R.momentary] &&
      signature[4] === readings[R.peakL] &&
      !(gotSpectrum && this.silentUpdates < SILENT_UPDATES_BEFORE_IDLE);
    if (unchanged) return;
    signature[0] = readings[R.histCount] as number;
    signature[1] = readings[R.scopePos] as number;
    signature[2] = readings[R.correlation] as number;
    signature[3] = readings[R.momentary] as number;
    signature[4] = readings[R.peakL] as number;
    this.draw(meter, newSpectra);
    this.resizedSince = false;
  }

  /** A restart of the meter (the play button, Reset) empties the spectrum's memory too. */
  private followReset(meter: MeterHandle): void {
    const count = meter.readings[R.resetSeq] as number;
    if (this.resetSeen === count) return;
    this.resetSeen = count;
    this.spectrum.clear();
  }

  private trackSilence(gotSpectrum: boolean): void {
    if (!gotSpectrum) return;
    this.silentUpdates = this.spectrum.totalDb < SILENT_TOTAL_DB ? this.silentUpdates + 1 : 0;
  }

  /** The target line follows the project and the choice; recomputed only when either changed. */
  private refreshTarget(): void {
    const project = this.services.doc.getState().project;
    const choice = this.services.meters.store.getState().target;
    if (project === this.cachedProject && choice === this.cachedChoice) return;
    this.cachedProject = project;
    this.cachedChoice = choice;
    this.target = this.services.meters.target();
    this.resizedSince = true;
  }

  private writeReadouts(meter: MeterHandle): void {
    const r = meter.readings;
    const out = this.readouts;
    const target = this.target.lufs;
    out.set('momentary', lufsText(r[R.momentary] as number), loudnessState(r[R.momentary] as number, target));
    out.set('shortTerm', lufsText(r[R.shortTerm] as number), loudnessState(r[R.shortTerm] as number, target));
    out.set('integrated', lufsText(r[R.integrated] as number), loudnessState(r[R.integrated] as number, target));
    out.set('range', Number.isFinite(r[R.integrated] as number) ? (r[R.range] as number).toFixed(1) : '–', 'none');
    const truePeak = Math.max(r[R.truePeakL] as number, r[R.truePeakR] as number);
    out.set('truePeak', peakDbText(truePeak), peakState(truePeak));
    out.set('peakL', peakDbText(r[R.truePeakL] as number), peakState(r[R.truePeakL] as number));
    out.set('peakR', peakDbText(r[R.truePeakR] as number), peakState(r[R.truePeakR] as number));
    out.set('maxMomentary', lufsText(r[R.maxMomentary] as number));
    out.set('maxShortTerm', lufsText(r[R.maxShortTerm] as number));
    out.set('correlation', correlationText(r[R.correlation] as number));
    this.writeTargetLine(r[R.integrated] as number);
    const warning = monoWarning({
      correlation: r[R.correlation] as number,
      corrLow: r[R.corrLow] as number,
      monoLossLow: r[R.monoLossLow] as number,
      levelLow: r[R.levelLow] as number,
    });
    out.set('warning', warning ?? '');
    out.hide('warning', warning === null);
    this.readouts.hide('unavailable', meter.active || meter.sampleRate > 0);
    this.readouts.hide('idle', historyLength(meter) > 0 || !meter.active);
  }

  private writeTargetLine(integrated: number): void {
    const lufs = this.target.lufs;
    if (lufs === null) {
      this.readouts.set('target', 'No target line');
      return;
    }
    const against = againstTarget(integrated, lufs);
    this.readouts.set('target', `Target ${lufsText(lufs)} LUFS (${this.target.label})${against ? `: integrated is ${against}` : ''}`);
  }

  private draw(meter: MeterHandle, newSpectra: number): void {
    const theme = readTheme();
    const history = this.boxes.get('history');
    if (history) drawHistory(fitCanvas(history.canvas, history.width, history.height), history.width, history.height, theme, meter, this.target);
    const gonio = this.boxes.get('gonio');
    const hasScope = (meter.readings[R.detail] as number) >= 1 && meter.active;
    if (gonio) drawGoniometer(fitCanvas(gonio.canvas, gonio.width, gonio.height), gonio.width, gonio.height, theme, meter, hasScope);
    const bars = this.boxes.get('bars');
    if (bars) drawStereoBars(fitCanvas(bars.canvas, bars.width, bars.height), bars.width, bars.height, theme, meter);
    this.drawSpectra(newSpectra, theme);
  }

  private drawSpectra(newSpectra: number, theme: TimelineTheme): void {
    const spectrum = this.boxes.get('spectrum');
    const spectrogram = this.boxes.get('spectrogram');
    if (spectrogram && this.spectrogram.fit(spectrogram.canvas, spectrogram.width, spectrogram.height)) this.spectrogram.clear(spectrogram.canvas);
    if (newSpectra > 0 && this.silentUpdates < SILENT_UPDATES_BEFORE_IDLE) {
      // One column per spectrum the audio thread made, so the time scale holds even when a frame is late.
      if (spectrogram) for (let i = 0; i < Math.min(newSpectra, MAX_COLUMNS_PER_FRAME); i++) this.spectrogram.push(spectrogram.canvas, this.spectrum.levels);
      this.referenceLine = this.referenceFor(this.services.doc.getState().project);
    }
    if (spectrum) this.spectrum.draw(fitCanvas(spectrum.canvas, spectrum.width, spectrum.height), spectrum.width, spectrum.height, theme, this.showReference ? this.referenceLine : null);
    this.readouts.hide('referenceNote', !(this.showReference && this.referenceLine));
  }

  /** The reference song's tonal balance as a level per display band (null without a reference or a spectrum). */
  private referenceFor(project: Project): Float64Array | null {
    const reference = project.reference;
    const bands = this.spectrum.bands;
    if (!reference || !bands || !Number.isFinite(this.spectrum.totalDb)) return null;
    const line = referenceCurve(reference.bands, TONE_CROSSOVERS, bands, this.spectrum.totalDb);
    // The tilt moves the live curve, so it moves the reference the same way (bands the reference does not cover stay out).
    const slope = this.services.meters.store.getState().slopeDb;
    if (slope !== 0) for (let band = 0; band < line.length; band++) if ((line[band] as number) > SPECTRUM_BOTTOM_DB) line[band] = (line[band] as number) + tiltDb(bands.centers[band] as number, slope);
    return line;
  }
}
