import { FrameRenderer, demoAudio, type VideoTheme } from '@app/export/video/frames';
import { beatGrid } from '@core/video/beats';
import type { VideoStyle } from '@core/video/formats';
import { SpectrumAnalyzer } from '@core/video/spectrum';
import { constantTempo } from '@core/time/ppq';
import type { TimelineTheme } from '../../timeline/canvas';

/** The video's colours from the app's theme (the export's Worker cannot read CSS, so it is handed plain colours). */
export function videoThemeOf(t: TimelineTheme): VideoTheme {
  return {
    bg: t.bg,
    bgAlt: t.bgAlt,
    accent: t.accent,
    accentLight: t.accentLight,
    accentDim: t.accentDim,
    text: t.text,
    textDim: t.textDim,
    textFaint: t.textFaint,
    select: t.select,
  };
}

const RATE = 48000;
let demo: Float32Array[] | null = null;

/** Seconds into the example music the preview shows: a moment shortly after a beat, so the pulse is visible. */
const PREVIEW_AT = 2.07;
const PREVIEW_BPM = 120;

export interface PreviewOptions {
  style: VideoStyle;
  width: number;
  height: number;
  title: string;
  artist: string;
  theme: VideoTheme;
  image: ImageBitmap | null;
}

/**
 * Draws one frame of the video into `canvas` with the same drawing code the export uses, over a few
 * seconds of example music (the song itself would have to be rendered first).
 */
export function drawPreview(canvas: HTMLCanvasElement, o: PreviewOptions): void {
  canvas.width = o.width;
  canvas.height = o.height;
  const g = canvas.getContext('2d');
  if (!g) return;
  demo ??= demoAudio(RATE, 4, PREVIEW_BPM);
  const [l, r] = demo as [Float32Array, Float32Array];
  const seconds = 3 * 60 + 7;
  const grid = beatGrid(constantTempo(PREVIEW_BPM), { num: 4, den: 4 }, 0, 960 * Math.ceil(seconds * 2 + 2));
  const renderer = new FrameRenderer(g, {
    style: o.style,
    width: o.width,
    height: o.height,
    title: o.title || 'Untitled',
    artist: o.artist,
    theme: o.theme,
    image: o.image,
    beats: grid,
    seconds,
  });
  const analyzer = new SpectrumAnalyzer(RATE, renderer.bands, { fftSize: 4096 });
  const window = new Float32Array(4096);
  const read = (centre: number) => {
    for (let i = 0; i < 4096; i++) {
      const k = centre - 2048 + i;
      window[i] = k >= 0 && k < l.length ? ((l[k] as number) + (r[k] as number)) * 0.5 : 0;
    }
  };
  // A few frames up to the moment, so the bars carry the smoothing a real frame has.
  const fps = 30;
  const frames = 8;
  for (let k = frames; k >= 0; k--) {
    read(Math.round((PREVIEW_AT - k / fps) * RATE) - 1024);
    analyzer.process(window, 1 / fps);
  }
  // The clock and the bar read as if the song were a third of the way through, a moment after a beat.
  const shown = Math.floor(seconds * 0.34) + (PREVIEW_AT % 0.5);
  read(Math.round(PREVIEW_AT * RATE) - 1024);
  renderer.draw({
    t: shown,
    bands: analyzer.bars,
    wave: window.subarray(1024, 3072),
    level: analyzer.level,
  });
}
