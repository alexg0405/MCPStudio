/**
 * Draws the pictures of the music video: four styles (spectrum bars, waveform, circular spectrum,
 * minimal with a progress bar) over the app's own colours, with the title and artist, an optional
 * background image or cover art, and a pulse on every beat. It draws into any 2-D canvas context
 * (an OffscreenCanvas in the export's Worker, and the dialog's preview on the main thread) and
 * needs nothing but what the caller hands it each frame: the moment, the spectrum bars, a stretch of
 * waveform and the loudness, all of them computed from the rendered audio. Everything is laid out
 * in units of the picture's short side / 1080, so one design serves every size.
 */
import { pulseAt, type BeatGrid } from '@core/video/beats';
import type { VideoStyle } from '@core/video/formats';
import { clockText } from '@core/video/timing';

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** The colours a video uses, as `rgba()` text (the app theme resolved on the main thread; Workers can't read CSS). */
export interface VideoTheme {
  bg: string;
  bgAlt: string;
  accent: string;
  accentLight: string;
  accentDim: string;
  text: string;
  textDim: string;
  textFaint: string;
  /** A second colour (the app's selection blue): the right channel, a counter-tone. */
  select: string;
}

/** Colours for places that have no theme to read (tests, the Worker's fallback). */
export const DEFAULT_VIDEO_THEME: VideoTheme = {
  bg: 'rgba(20, 24, 28, 1)',
  bgAlt: 'rgba(32, 40, 46, 1)',
  accent: 'rgba(232, 184, 96, 1)',
  accentLight: 'rgba(250, 214, 140, 1)',
  accentDim: 'rgba(160, 120, 56, 1)',
  text: 'rgba(238, 240, 242, 1)',
  textDim: 'rgba(176, 184, 190, 1)',
  textFaint: 'rgba(112, 122, 130, 1)',
  select: 'rgba(110, 168, 240, 1)',
};

/** What a frame is drawn from. */
export interface FrameInput {
  /** Seconds from the start of the video. */
  t: number;
  /** Spectrum bars, 0…1, `bandCount(...)` of them. */
  bands: Float32Array;
  /** A stretch of the mono waveform around `t`, −1…1. */
  wave: Float32Array;
  /** Loudness, 0…1. */
  level: number;
}

export interface FrameOptions {
  style: VideoStyle;
  width: number;
  height: number;
  title: string;
  artist: string;
  theme: VideoTheme;
  /** Background image or cover art (decoded), if the musician picked one. */
  image?: ImageBitmap | null | undefined;
  beats: BeatGrid;
  /** Seconds of music, for the progress bar. */
  seconds: number;
  /** Creates the canvas the static background is drawn on once (an OffscreenCanvas). */
  makeCanvas?: (w: number, h: number) => OffscreenCanvas;
}

/** The typeface: the system's UI font (Workers can't load the page's fonts). */
const FONT = `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

/** How many spectrum bands a style wants for a picture of this shape. */
export function bandCount(style: VideoStyle, width: number, height: number): number {
  if (style === 'bars') return width > height * 1.2 ? 56 : 36;
  if (style === 'circle') return 64;
  return 24;
}

/** `color` (as `rgba(…)` or `#rrggbb`) with its alpha multiplied by `a`. */
export function withAlpha(color: string, a: number): string {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(color.trim());
  if (m)
    return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${Math.max(0, Math.min(1, (m[4] === undefined ? 1 : Number(m[4])) * a))})`;
  const h = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (h) {
    const n = parseInt(h[1] as string, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, a))})`;
  }
  return color;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Layout {
  u: number;
  margin: number;
  viz: Box;
  titleY: number;
  titleSize: number;
  artistY: number;
  artistSize: number;
  progress: Box;
  landscape: boolean;
}

function layoutOf(style: VideoStyle, w: number, h: number): Layout {
  const u = Math.min(w, h) / 1080;
  const landscape = w > h * 1.2;
  const vertical = h > w * 1.2;
  const margin = (vertical ? 90 : 96) * u;
  if (style === 'minimal') {
    return {
      u,
      margin,
      viz: { x: margin, y: h * 0.3, w: w - 2 * margin, h: h * 0.4 },
      titleY: h * 0.46,
      titleSize: (vertical ? 80 : 84) * u,
      artistY: h * 0.46 + 70 * u,
      artistSize: 38 * u,
      progress: { x: w * 0.2, y: h * 0.62, w: w * 0.6, h: 8 * u },
      landscape,
    };
  }
  if (landscape)
    return {
      u,
      margin,
      viz: { x: margin, y: 270 * u, w: w - 2 * margin, h: 690 * u },
      titleY: 130 * u,
      titleSize: 68 * u,
      artistY: 190 * u,
      artistSize: 36 * u,
      progress: { x: margin, y: h - 62 * u, w: w - 2 * margin, h: 6 * u },
      landscape,
    };
  if (vertical)
    return {
      u,
      margin,
      viz: { x: margin, y: 560 * u, w: w - 2 * margin, h: 1000 * u },
      titleY: 270 * u,
      titleSize: 76 * u,
      artistY: 345 * u,
      artistSize: 40 * u,
      progress: { x: margin, y: h - 200 * u, w: w - 2 * margin, h: 7 * u },
      landscape,
    };
  return {
    u,
    margin,
    viz: { x: margin, y: 290 * u, w: w - 2 * margin, h: 620 * u },
    titleY: 140 * u,
    titleSize: 66 * u,
    artistY: 200 * u,
    artistSize: 36 * u,
    progress: { x: margin, y: h - 74 * u, w: w - 2 * margin, h: 6 * u },
    landscape,
  };
}

/** `text` shortened with an ellipsis until it fits `maxWidth` in the context's current font. */
function fit(g: Ctx, text: string, maxWidth: number): string {
  if (g.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.measureText(`${text.slice(0, mid).trimEnd()}…`).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

export class FrameRenderer {
  readonly bands: number;
  private readonly L: Layout;
  private readonly w: number;
  private readonly h: number;
  private readonly bg: OffscreenCanvas;
  private readonly title: string;
  private readonly artist: string;
  private readonly totalText: string;

  constructor(
    private readonly g: Ctx,
    private readonly o: FrameOptions,
  ) {
    this.w = o.width;
    this.h = o.height;
    this.bands = bandCount(o.style, o.width, o.height);
    this.L = layoutOf(o.style, o.width, o.height);
    this.totalText = clockText(o.seconds);
    const make = o.makeCanvas ?? ((w: number, h: number) => new OffscreenCanvas(w, h));
    this.bg = make(o.width, o.height);
    this.paintBackground(this.bg.getContext('2d') as OffscreenCanvasRenderingContext2D);
    const { L, g: ctx } = this;
    const maxW = o.width - 2 * L.margin;
    ctx.font = `700 ${L.titleSize}px ${FONT}`;
    this.title = fit(ctx, o.title, maxW);
    ctx.font = `500 ${L.artistSize}px ${FONT}`;
    this.artist = fit(ctx, o.artist, maxW);
  }

  /** The part of the picture that never changes: the gradient, the image, the vignette. */
  private paintBackground(g: OffscreenCanvasRenderingContext2D): void {
    const { w, h, o } = this;
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, o.theme.bgAlt);
    sky.addColorStop(1, o.theme.bg);
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);
    const img = o.image;
    if (img && img.width > 0 && img.height > 0) {
      // Cover: fill the picture, cropping what overflows.
      const k = Math.max(w / img.width, h / img.height);
      const dw = img.width * k;
      const dh = img.height * k;
      g.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
      // Dim it so the bars and the text stay readable.
      g.fillStyle = withAlpha(o.theme.bg, 0.66);
      g.fillRect(0, 0, w, h);
    }
    const vig = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
    vig.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vig.addColorStop(1, 'rgba(0, 0, 0, 0.38)');
    g.fillStyle = vig;
    g.fillRect(0, 0, w, h);
  }

  /** Draws one frame. */
  draw(f: FrameInput): void {
    const { g, w, h, o, L } = this;
    const pulse = pulseAt(o.beats, f.t);
    const p = pulse.amount;
    g.globalAlpha = 1;
    g.drawImage(this.bg, 0, 0);

    // The beat: a glow behind everything that swells on each beat, with a little loudness in it.
    const cx = L.viz.x + L.viz.w / 2;
    const cy = L.viz.y + L.viz.h / 2;
    const radius = Math.max(w, h) * 0.62;
    const glow = g.createRadialGradient(cx, cy, 0, cx, cy, radius);
    glow.addColorStop(0, withAlpha(o.theme.accent, 0.1 + 0.34 * p + 0.1 * f.level));
    glow.addColorStop(1, withAlpha(o.theme.accent, 0));
    g.fillStyle = glow;
    g.fillRect(0, 0, w, h);

    switch (o.style) {
      case 'bars':
        this.drawBars(f, p);
        break;
      case 'wave':
        this.drawWave(f, p);
        break;
      case 'circle':
        this.drawCircle(f, p);
        break;
      case 'minimal':
        this.drawMinimal(f, p);
        break;
    }

    if (o.style !== 'minimal') {
      g.textBaseline = 'alphabetic';
      g.textAlign = 'left';
      g.font = `700 ${L.titleSize}px ${FONT}`;
      g.fillStyle = o.theme.text;
      g.fillText(this.title, L.margin, L.titleY);
      if (this.artist) {
        g.font = `500 ${L.artistSize}px ${FONT}`;
        g.fillStyle = o.theme.textDim;
        g.fillText(this.artist, L.margin, L.artistY);
      }
      this.drawProgress(f.t, p, false);
    }
    g.globalAlpha = 1;
  }

  private drawProgress(t: number, p: number, big: boolean): void {
    const { g, L, o } = this;
    const { x, y, w, h } = L.progress;
    const done = Math.max(0, Math.min(1, o.seconds > 0 ? t / o.seconds : 0));
    const r = h / 2;
    g.fillStyle = withAlpha(o.theme.textFaint, 0.35);
    g.beginPath();
    g.roundRect(x, y, w, h, r);
    g.fill();
    if (done > 0) {
      const fill = g.createLinearGradient(x, 0, x + w, 0);
      fill.addColorStop(0, o.theme.accentDim);
      fill.addColorStop(1, o.theme.accentLight);
      g.fillStyle = fill;
      g.beginPath();
      g.roundRect(x, y, Math.max(h, w * done), h, r);
      g.fill();
      // The head of the bar: a dot that swells on the beat.
      g.fillStyle = o.theme.accentLight;
      g.beginPath();
      g.arc(x + w * done, y + h / 2, h * (big ? 1.5 : 1.1) * (1 + 0.5 * p), 0, Math.PI * 2);
      g.fill();
    }
  }

  private drawBars(f: FrameInput, p: number): void {
    const { g, L, o, bands } = this;
    const { viz, u } = L;
    const n = bands;
    const slot = viz.w / n;
    const bw = slot * 0.66;
    const base = viz.y + viz.h * 0.74;
    const up = viz.h * 0.72;
    const down = viz.h * 0.22;
    const grad = g.createLinearGradient(0, base - up, 0, base);
    grad.addColorStop(0, o.theme.accentLight);
    grad.addColorStop(0.55, o.theme.accent);
    grad.addColorStop(1, o.theme.accentDim);
    const lift = 1 + 0.07 * p;
    const min = 5 * u;
    g.fillStyle = grad;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const v = Math.min(1, (f.bands[i] as number) * lift);
      const bh = Math.max(min, v * up);
      g.roundRect(viz.x + i * slot + (slot - bw) / 2, base - bh, bw, bh, Math.min(bw / 2, 10 * u));
    }
    g.fill();
    // The reflection: the same bars mirrored below, fading out.
    const refl = g.createLinearGradient(0, base, 0, base + down);
    refl.addColorStop(0, withAlpha(o.theme.accent, 0.3));
    refl.addColorStop(1, withAlpha(o.theme.accent, 0));
    g.fillStyle = refl;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const v = Math.min(1, (f.bands[i] as number) * lift);
      const bh = Math.min(down, Math.max(min, v * up) * 0.3);
      g.roundRect(viz.x + i * slot + (slot - bw) / 2, base + 5 * u, bw, bh, Math.min(bw / 2, 10 * u));
    }
    g.fill();
    // The floor line, brighter on the beat.
    g.fillStyle = withAlpha(o.theme.accentLight, 0.25 + 0.5 * p);
    g.fillRect(viz.x, base, viz.w, Math.max(1, 2 * u));
  }

  private drawWave(f: FrameInput, p: number): void {
    const { g, L, o } = this;
    const { viz, u } = L;
    const wave = f.wave;
    // Start the trace at a rising zero crossing, so a steady note holds still.
    let start = 0;
    const search = Math.min(wave.length - 2, Math.floor(wave.length / 4));
    for (let i = 0; i < search; i++) {
      if ((wave[i] as number) < 0 && (wave[i + 1] as number) >= 0) {
        start = i;
        break;
      }
    }
    const span = Math.max(2, Math.min(wave.length - start, Math.floor(wave.length * 0.5)));
    const points = Math.max(32, Math.min(span, Math.round(viz.w / (3 * u))));
    const mid = viz.y + viz.h / 2;
    const amp = viz.h * 0.4;
    const trace = () => {
      g.beginPath();
      for (let i = 0; i < points; i++) {
        const v = Math.max(
          -1,
          Math.min(1, (wave[start + Math.floor((i * (span - 1)) / (points - 1))] as number) * 1.15),
        );
        const x = viz.x + (i / (points - 1)) * viz.w;
        if (i === 0) g.moveTo(x, mid - v * amp);
        else g.lineTo(x, mid - v * amp);
      }
    };
    g.lineJoin = 'round';
    g.lineCap = 'round';
    // A faint centre line, then the trace with a soft wide stroke under it for the glow.
    g.fillStyle = withAlpha(o.theme.textFaint, 0.3);
    g.fillRect(viz.x, mid, viz.w, Math.max(1, 2 * u));
    trace();
    g.strokeStyle = withAlpha(o.theme.accent, 0.16 + 0.12 * p);
    g.lineWidth = (22 + 12 * p) * u;
    g.stroke();
    trace();
    g.strokeStyle = o.theme.accent;
    g.lineWidth = (6 + 3 * p) * u;
    g.stroke();
    trace();
    g.strokeStyle = withAlpha(o.theme.accentLight, 0.9);
    g.lineWidth = 2.5 * u;
    g.stroke();
  }

  private drawCircle(f: FrameInput, p: number): void {
    const { g, L, o, bands } = this;
    const { viz, u } = L;
    const cx = viz.x + viz.w / 2;
    const cy = viz.y + viz.h / 2;
    const reach = Math.min(viz.w, viz.h) / 2;
    const inner = reach * 0.46 * (1 + 0.07 * p);
    const long = reach * 0.5;
    const spokes = bands * 2;
    const turn = f.t * 0.12;
    g.lineCap = 'round';
    // The spokes: the bands run round one half of the circle and mirror onto the other.
    g.beginPath();
    for (let k = 0; k < spokes; k++) {
      const band = k < bands ? k : spokes - 1 - k;
      const v = Math.min(1, f.bands[band] as number);
      const a = -Math.PI / 2 + (k / spokes) * Math.PI * 2 + turn;
      const r0 = inner + 10 * u;
      const r1 = r0 + 6 * u + v * long;
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    }
    g.strokeStyle = o.theme.accent;
    g.lineWidth = Math.max(3 * u, ((2 * Math.PI * (inner + 10 * u)) / spokes) * 0.7);
    g.stroke();
    // The ring, bright on the beat.
    g.strokeStyle = withAlpha(o.theme.accentLight, 0.35 + 0.55 * p);
    g.lineWidth = (3 + 4 * p) * u;
    g.beginPath();
    g.arc(cx, cy, inner, 0, Math.PI * 2);
    g.stroke();
    // The middle: the cover art as a disc, or a soft pool of the accent colour.
    const img = o.image;
    g.save();
    g.beginPath();
    g.arc(cx, cy, inner - 5 * u, 0, Math.PI * 2);
    g.clip();
    if (img && img.width > 0 && img.height > 0) {
      const d = (inner - 5 * u) * 2;
      const k = Math.max(d / img.width, d / img.height);
      g.drawImage(img, cx - (img.width * k) / 2, cy - (img.height * k) / 2, img.width * k, img.height * k);
    } else {
      const pool = g.createRadialGradient(cx, cy, 0, cx, cy, inner);
      pool.addColorStop(0, withAlpha(o.theme.accent, 0.5 + 0.3 * p));
      pool.addColorStop(1, withAlpha(o.theme.accentDim, 0.35));
      g.fillStyle = pool;
      g.fillRect(cx - inner, cy - inner, inner * 2, inner * 2);
    }
    g.restore();
  }

  private drawMinimal(f: FrameInput, p: number): void {
    const { g, L, o, w, h } = this;
    const { u } = L;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    // A ring that breathes with the beat above the title.
    const ringY = h * 0.46 - L.titleSize - 70 * u;
    g.strokeStyle = withAlpha(o.theme.accentLight, 0.3 + 0.6 * p);
    g.lineWidth = (3 + 3 * p) * u;
    g.beginPath();
    g.arc(w / 2, ringY, (34 + 12 * p + 22 * f.level) * u, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = o.theme.accent;
    g.beginPath();
    g.arc(w / 2, ringY, (9 + 4 * p) * u, 0, Math.PI * 2);
    g.fill();
    g.font = `700 ${L.titleSize}px ${FONT}`;
    g.fillStyle = o.theme.text;
    g.fillText(this.title, w / 2, L.titleY);
    if (this.artist) {
      g.font = `500 ${L.artistSize}px ${FONT}`;
      g.fillStyle = o.theme.textDim;
      g.fillText(this.artist, w / 2, L.artistY);
    }
    this.drawProgress(f.t, p, true);
    // Times at either end of the bar.
    const clock = clockText(f.t);
    g.font = `500 ${30 * u}px ${FONT}`;
    g.fillStyle = o.theme.textDim;
    g.textBaseline = 'top';
    g.textAlign = 'left';
    g.fillText(clock, L.progress.x, L.progress.y + 30 * u);
    g.textAlign = 'right';
    g.fillText(this.totalText, L.progress.x + L.progress.w, L.progress.y + 30 * u);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
  }
}

/**
 * A little music for the dialog's preview and the tests: a bass note, a few harmonics and a kick on every beat of
 * `bpm`, stereo, `seconds` long. Deterministic.
 */
export function demoAudio(sampleRate: number, seconds: number, bpm = 120): Float32Array[] {
  const n = Math.round(sampleRate * seconds);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const beat = 60 / bpm;
  const notes = [110, 138.6, 164.8, 130.8];
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const since = t % beat;
    const kick = Math.exp(-since * 14) * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-since * 40)) * since) * 0.8;
    const f = notes[Math.floor(t / (beat * 2)) % notes.length] as number;
    const tone =
      0.18 * Math.sin(2 * Math.PI * f * t) +
      0.1 * Math.sin(2 * Math.PI * f * 2 * t) +
      0.07 * Math.sin(2 * Math.PI * f * 3 * t) +
      0.05 * Math.sin(2 * Math.PI * f * 5 * t + Math.sin(t * 3)) +
      0.04 * Math.sin(2 * Math.PI * 2093 * t) * (0.5 + 0.5 * Math.sin(t * 7));
    const hat = Math.exp(-((t + beat / 2) % beat) * 60) * Math.sin(i * 12.9898) * 0.08;
    l[i] = kick + tone + hat;
    r[i] = kick + tone * 0.9 - hat;
  }
  return [l, r];
}
