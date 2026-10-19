// What the Analyzer editor paints on its two canvases: the spectrum and the oscilloscope.
import type { AudioTap } from '@agstudio/sdk';
import { themeColors } from '@agstudio/sdk/ui';

/** The spectrum's frequency axis runs from here to here, in Hz, on a log scale. */
const MIN_FREQ_HZ = 20;
const MAX_FREQ_HZ = 20000;
/** The spectrum's bottom, in dBFS (0 dBFS is the top). */
const FLOOR_DB = -96;
/** Frames of the scope's trace read from the tap (twice what is shown, so a rising zero crossing can be found). */
export const SCOPE_FRAMES = 2048;

/** Limits `value` to [low, high]. */
export const clamp = (value: number, low: number, high: number) => (value < low ? low : value > high ? high : value);
/** The frequency at a position along the spectrum's axis (0 = lowest, 1 = highest). */
const frequencyAt = (position: number) => MIN_FREQ_HZ * Math.pow(MAX_FREQ_HZ / MIN_FREQ_HZ, position);

/** Sizes a canvas's backing store to its CSS box and clears it; returns its context, in CSS pixels. */
function prepareCanvas(
  canvas: HTMLCanvasElement | null,
): { context: CanvasRenderingContext2D; width: number; height: number } | null {
  const context = canvas?.getContext('2d');
  if (!canvas || !context) return null;
  const pixelRatio = window.devicePixelRatio || 1;
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  if (canvas.width !== Math.round(width * pixelRatio) || canvas.height !== Math.round(height * pixelRatio)) {
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
  }
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);
  return { context, width, height };
}

/** Paints the grid, and the tap's spectrum on it when there is one (`bins` is scratch space for the tap to fill). */
export function drawSpectrum(
  canvas: HTMLCanvasElement | null,
  tap: AudioTap | undefined,
  bins: Float32Array<ArrayBuffer> | undefined,
) {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const { context, width, height } = prepared;
  const theme = themeColors();
  // Grid: octaves and 12 dB steps.
  context.strokeStyle = theme.line;
  context.lineWidth = 1;
  context.beginPath();
  for (const frequencyHz of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = Math.round((Math.log(frequencyHz / MIN_FREQ_HZ) / Math.log(MAX_FREQ_HZ / MIN_FREQ_HZ)) * width) + 0.5;
    context.moveTo(x, 0);
    context.lineTo(x, height);
  }
  for (let db = -12; db > FLOOR_DB; db -= 12) {
    const y = Math.round((db / FLOOR_DB) * height) + 0.5;
    context.moveTo(0, y);
    context.lineTo(width, y);
  }
  context.stroke();
  if (!tap || !bins || !tap.spectrum(bins)) return;
  const binHz = tap.sampleRate / tap.fftSize;
  const columns = Math.max(2, Math.round(width / 2));
  context.beginPath();
  context.moveTo(0, height);
  for (let i = 0; i <= columns; i++) {
    // The loudest bin under this column of pixels.
    const firstBin = clamp(Math.floor(frequencyAt((i - 0.5) / columns) / binHz), 1, bins.length - 1);
    const endBin = clamp(Math.ceil(frequencyAt((i + 0.5) / columns) / binHz), firstBin + 1, bins.length);
    let peakDb = -Infinity;
    for (let bin = firstBin; bin < endBin; bin++) if ((bins[bin] as number) > peakDb) peakDb = bins[bin] as number;
    context.lineTo((i / columns) * width, (clamp(peakDb, FLOOR_DB, 0) / FLOOR_DB) * height);
  }
  context.lineTo(width, height);
  context.closePath();
  // The accent as a wash that fades towards the floor, under a bright edge.
  const wash = context.createLinearGradient(0, 0, 0, height);
  wash.addColorStop(0, theme.accent);
  wash.addColorStop(1, 'transparent');
  context.fillStyle = wash;
  context.globalAlpha = 0.5;
  context.fill();
  context.globalAlpha = 0.9;
  context.strokeStyle = theme.accent;
  context.stroke();
  context.globalAlpha = 1;
}

/** Paints the zero line, and the last stretch of both channels' waveform on it when there is a tap. */
export function drawScope(
  canvas: HTMLCanvasElement | null,
  tap: AudioTap | undefined,
  left: Float32Array<ArrayBuffer> | undefined,
  right: Float32Array<ArrayBuffer> | undefined,
) {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const { context, width, height } = prepared;
  const theme = themeColors();
  context.strokeStyle = theme.lineStrong;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, height / 2 + 0.5);
  context.lineTo(width, height / 2 + 0.5);
  context.stroke();
  if (!tap || !left || !right || !tap.waveform(left, 0) || !tap.waveform(right, 1)) return;
  // Start at a rising zero crossing of the left channel so the picture stands still.
  const shownFrames = Math.floor(left.length / 2);
  let startFrame = 0;
  for (let i = 1; i < left.length - shownFrames; i++) {
    if ((left[i - 1] as number) < 0 && (left[i] as number) >= 0) {
      startFrame = i;
      break;
    }
  }
  const trace = (samples: Float32Array, color: string) => {
    context.strokeStyle = color;
    context.beginPath();
    for (let x = 0; x <= width; x++) {
      const sample = samples[startFrame + Math.floor((x / width) * (shownFrames - 1))] as number;
      const y = height / 2 - clamp(sample, -1, 1) * (height / 2 - 2);
      if (x === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
  };
  context.globalAlpha = 0.8;
  trace(right, theme.select);
  context.globalAlpha = 0.95;
  trace(left, theme.accent);
  context.globalAlpha = 1;
}
