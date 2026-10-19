// Hooks of the EQ Pro graph: its size, the curve it draws, the live spectrum behind it and the scroll-for-Q gesture.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ParamValue } from '@agstudio/sdk';
import { themeColors, useFrame } from '@agstudio/sdk/ui';
import { bandResponseDb, hasGain, sectionBuffer } from './design.kernel';
import type { BandView, EqProProps } from './eq-bands';
import { clamp, FINE_Q_STEP, frequencyAtPosition, Q_STEP, SPECTRUM_FLOOR_DB, yOfDb } from './eq-graph';
import { bandIds } from './params';

export interface GraphSize {
  width: number;
  height: number;
}

/** The graph's size in pixels, kept current as its element is resized. */
export function useGraphSize(graph: RefObject<HTMLDivElement | null>): GraphSize {
  const [size, setSize] = useState<GraphSize>({ width: 480, height: 230 });
  useLayoutEffect(() => {
    const element = graph.current;
    if (!element) return;
    const measure = () => {
      const width = Math.max(100, Math.round(element.clientWidth));
      const height = Math.max(80, Math.round(element.clientHeight));
      setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [graph]);
  return size;
}

export interface CurvePaths {
  /** The summed response of every active band plus the output gain, as an SVG path. */
  curve: string;
  /** The same, closed to the 0 dB line so it can be filled. */
  area: string;
  /** The selected band's own response, closed to the 0 dB line ('' when that band is off). */
  fill: string;
}

/** The summed curve and the selected band's own response, redrawn only when what they depend on changes. */
export function useCurvePaths(
  bands: BandView[],
  selected: number,
  size: GraphSize,
  sampleRate: number,
  outputDb: number,
): CurvePaths {
  const scratch = useMemo(() => sectionBuffer(), []);
  return useMemo(() => {
    const steps = Math.max(2, Math.round(size.width / 2));
    const active = bands.filter((band) => band.isOn && !(hasGain(band.type) && band.gainDb === 0));
    const selectedBand = bands[selected - 1];
    let curve = '';
    let fill = '';
    for (let i = 0; i <= steps; i++) {
      const x = (i / steps) * size.width;
      const frequencyHz = frequencyAtPosition(i / steps);
      let db = outputDb;
      for (const band of active) {
        db += bandResponseDb(band.type, band.frequencyHz, band.gainDb, band.q, frequencyHz, sampleRate, scratch);
      }
      curve += `${i ? 'L' : 'M'}${x.toFixed(1)},${clamp(yOfDb(db, size.height), -4, size.height + 4).toFixed(1)}`;
      if (selectedBand?.isOn) {
        const ownDb = bandResponseDb(
          selectedBand.type,
          selectedBand.frequencyHz,
          selectedBand.gainDb,
          selectedBand.q,
          frequencyHz,
          sampleRate,
          scratch,
        );
        fill += `${i ? 'L' : 'M'}${x.toFixed(1)},${clamp(yOfDb(ownDb, size.height), -4, size.height + 4).toFixed(1)}`;
      }
    }
    const zero = yOfDb(0, size.height).toFixed(1);
    return {
      curve,
      area: `${curve}L${size.width},${zero}L0,${zero}Z`,
      fill: fill ? `${fill}L${size.width},${zero}L0,${zero}Z` : '',
    };
  }, [bands, selected, size, sampleRate, outputDb, scratch]);
}

interface SpectrumColumns {
  bins: Float32Array<ArrayBuffer>;
  /** For each pixel column, the first and last+1 FFT bin it covers (log frequency axis). */
  firstBin: Int32Array;
  endBin: Int32Array;
  /** What these were computed for (FFT size, sample rate, column count), to notice a change. */
  key: string;
}

/** The live spectrum of the output, drawn on the frame loop (no React renders): put the returned ref on a canvas. */
export function useSpectrumCanvas(tap: EqProProps['tap'], size: GraphSize): RefObject<HTMLCanvasElement | null> {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef(size);
  const columns = useRef<SpectrumColumns | null>(null);
  useEffect(() => {
    sizeRef.current = size;
    const element = canvas.current;
    if (!element) return;
    const pixelRatio = window.devicePixelRatio || 1;
    element.width = Math.round(size.width * pixelRatio);
    element.height = Math.round(size.height * pixelRatio);
  }, [size]);

  useFrame(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const { width, height } = sizeRef.current;
    const pixelRatio = element.width / width;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    if (!tap?.active || tap.fftSize === 0) return;
    const columnCount = Math.max(2, Math.round(width / 2));
    const key = `${tap.fftSize}:${tap.sampleRate}:${columnCount}`;
    let spectrum = columns.current;
    if (!spectrum || spectrum.key !== key) spectrum = columns.current = spectrumColumns(tap, columnCount, key);
    if (!tap.spectrum(spectrum.bins)) return;
    drawSpectrum(context, spectrum, columnCount, width, height);
  });
  return canvas;
}

/** Which FFT bins each column of pixels covers. */
function spectrumColumns(tap: NonNullable<EqProProps['tap']>, columnCount: number, key: string): SpectrumColumns {
  const firstBin = new Int32Array(columnCount + 1);
  const endBin = new Int32Array(columnCount + 1);
  const binHz = tap.sampleRate / tap.fftSize;
  for (let i = 0; i <= columnCount; i++) {
    const lowBin = frequencyAtPosition((i - 0.5) / columnCount) / binHz;
    const highBin = frequencyAtPosition((i + 0.5) / columnCount) / binHz;
    firstBin[i] = clamp(Math.floor(lowBin), 1, tap.fftSize / 2 - 1);
    endBin[i] = clamp(Math.max(Math.floor(lowBin) + 1, Math.ceil(highBin)), 2, tap.fftSize / 2);
  }
  return { bins: new Float32Array(tap.fftSize / 2), firstBin, endBin, key };
}

/** Draws the loudest bin of every column as a filled outline, quieter than the curve on top of it. */
function drawSpectrum(
  context: CanvasRenderingContext2D,
  spectrum: SpectrumColumns,
  columnCount: number,
  width: number,
  height: number,
): void {
  context.beginPath();
  context.moveTo(0, height);
  for (let i = 0; i <= columnCount; i++) {
    let peakDb = -Infinity;
    for (let bin = spectrum.firstBin[i] as number; bin < (spectrum.endBin[i] as number); bin++) {
      if ((spectrum.bins[bin] as number) > peakDb) peakDb = spectrum.bins[bin] as number;
    }
    const y = (clamp(peakDb, SPECTRUM_FLOOR_DB, 0) / SPECTRUM_FLOOR_DB) * height;
    context.lineTo((i / columnCount) * width, y);
  }
  context.lineTo(width, height);
  context.closePath();
  // The theme's selection colour (soft steel), quieter than the gold curve on top of it.
  const theme = themeColors();
  context.fillStyle = theme.select;
  context.globalAlpha = 0.16;
  context.fill();
  context.globalAlpha = 0.45;
  context.strokeStyle = theme.select;
  context.lineWidth = 1;
  context.stroke();
  context.globalAlpha = 1;
}

/** Scroll on a handle changes its Q (a native listener: React's wheel events can't stop scrolling). */
export function useScrollForQ(
  svg: RefObject<SVGSVGElement | null>,
  bands: BandView[],
  setParam: (param: string, value: ParamValue) => void,
  selectBand: (band: number) => void,
): void {
  const latest = useRef({ bands, setParam });
  useEffect(() => {
    latest.current = { bands, setParam };
  });
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const handle = (event.target as Element | null)?.closest('[data-band]');
      if (!handle) return;
      event.preventDefault();
      const band = latest.current.bands[Number(handle.getAttribute('data-band')) - 1];
      if (!band) return;
      const step = event.shiftKey ? FINE_Q_STEP : Q_STEP;
      const q = clamp(event.deltaY < 0 ? band.q * step : band.q / step, 0.1, 18);
      latest.current.setParam(bandIds(band.number).q, Math.round(q * 1000) / 1000);
      selectBand(band.number);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [svg, selectBand]);
}
