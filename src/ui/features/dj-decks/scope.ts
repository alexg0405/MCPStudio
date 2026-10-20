/**
 * The waveform views of one deck, drawn imperatively on the frame loop (no React commits while a song plays): the
 * scrolling waveform around the playhead (with the beat grid, cue, hot cues and the loop), the whole-song overview
 * (with the playhead and the same markers), the platter turning with the song and the time readouts. It redraws
 * only when something changed (the position, the deck's state, the theme or the size), so a paused deck costs
 * nothing.
 */
import type { DeckId, DecksApi, DeckState } from '@app/dj/decks-api';
import { reducePeaks, type DeckWaveform } from '@core/dj/deck-peaks';
import { formatDeckTime, MIN_TRACKED_BEATS, REV_SEC } from '@core/dj/decks-math';
import { alpha, fitCanvas, mix, readTheme, themeVersion, type TimelineTheme, fontPx } from '../../timeline/canvas';
import { StallLatch } from './stall';

/** Seconds of song across the scrolling waveform. */
export const SCOPE_SPAN_SEC = 6;
const PALETTE = 16;

/** The elements a deck's scope draws on or updates. */
export interface ScopeParts {
  zoom: HTMLCanvasElement;
  overview: HTMLCanvasElement;
  platter: HTMLElement | null;
  time: HTMLElement | null;
  remaining: HTMLElement | null;
  /** The "Loading…" note over the waveform, shown while the deck is stalled (hidden by default). */
  stall: HTMLElement | null;
}

/** The colors of the eight hot cues, from the theme's palette tokens. */
export const HOT_CUE_VARS = Array.from({ length: 8 }, (_, i) => `var(--ag-palette-${i + 1})`);

/** Draws a deck's waveforms, platter, clock and "Loading…" note once per frame, without React. */
export class DeckScope {
  /** What the picture was last drawn for (see frame). */
  private lastPosMs = NaN;
  private lastZoomW = NaN;
  private lastZoomH = NaN;
  private lastOverviewW = NaN;
  private lastTheme = NaN;
  private lastDpr = NaN;
  private lastTime = '';
  private lastRemaining = '';
  private lastRotation = NaN;
  private palette: { v: number; colors: string[] } | null = null;
  private reduced: { wave: DeckWaveform; cols: number; min: Float32Array; max: Float32Array; low: Float32Array } | null = null;
  private peakOf = new WeakMap<DeckWaveform, number>();
  private readonly stallLatch = new StallLatch();
  private stallShown = false;

  constructor(
    private readonly api: DecksApi,
    private readonly id: DeckId,
    private readonly parts: ScopeParts,
  ) {}

  /** Called every animation frame (`now`: the frame's time in ms, as requestAnimationFrame gives it). */
  frame(now: number = performance.now()): void {
    const d = this.api.store.getState().decks[this.id];
    const pos = d.song ? this.api.positionNow(this.id) : 0;
    const zoomBox = this.parts.zoom.getBoundingClientRect();
    const ovBox = this.parts.overview.getBoundingClientRect();
    // What the picture depends on, compared field by field (a key string built every frame was garbage).
    // The position in milliseconds (the precision it was keyed by as a string before: `toFixed(3)`).
    const posMs = Math.round(pos * 1000);
    const zoomW = zoomBox.width | 0;
    const zoomH = zoomBox.height | 0;
    const overviewW = ovBox.width | 0;
    const themeV = themeVersion();
    const dpr = window.devicePixelRatio;
    this.text(d, pos);
    this.rotate(d, pos);
    this.stalled(now);
    // The deck's own state is a new object whenever anything in it changes.
    const same =
      posMs === this.lastPosMs &&
      zoomW === this.lastZoomW &&
      zoomH === this.lastZoomH &&
      overviewW === this.lastOverviewW &&
      themeV === this.lastTheme &&
      dpr === this.lastDpr;
    if (same && this.lastState === d && this.lastWave === this.api.waveformOf?.(this.id)) return;
    this.lastPosMs = posMs;
    this.lastZoomW = zoomW;
    this.lastZoomH = zoomH;
    this.lastOverviewW = overviewW;
    this.lastTheme = themeV;
    this.lastDpr = dpr;
    this.lastState = d;
    this.lastWave = this.api.waveformOf?.(this.id) ?? null;
    const theme = readTheme();
    this.drawZoom(d, pos, theme, zoomBox.width, zoomBox.height);
    this.drawOverview(d, pos, theme, ovBox.width, ovBox.height);
  }

  private lastState: DeckState | null = null;
  private lastWave: DeckWaveform | null = null;

  private text(d: DeckState, pos: number): void {
    const dur = d.song?.durationSec ?? 0;
    const t = d.song ? formatDeckTime(pos) : '–:––.-';
    const r = d.song ? formatDeckTime(-(dur - pos)) : '';
    if (this.parts.time && t !== this.lastTime) {
      this.lastTime = t;
      this.parts.time.textContent = t;
    }
    if (this.parts.remaining && r !== this.lastRemaining) {
      this.lastRemaining = r;
      this.parts.remaining.textContent = r;
    }
  }

  private rotate(d: DeckState, pos: number): void {
    const el = this.parts.platter;
    if (!el) return;
    const deg = d.song ? Math.round(((pos / REV_SEC) * 360 * 10) % 3600) / 10 : 0;
    if (deg !== this.lastRotation) {
      this.lastRotation = deg;
      el.style.transform = `rotate(${deg}deg)`;
    }
  }

  /** The "Loading…" note: shown after a short stall (see StallLatch); only the DOM's `hidden` is written, on a change. */
  private stalled(now: number): void {
    const show = this.stallLatch.update(this.api.isStalled?.(this.id) ?? false, now);
    if (show === this.stallShown) return;
    this.stallShown = show;
    if (this.parts.stall) this.parts.stall.hidden = !show;
  }

  private colors(theme: TimelineTheme): string[] {
    if (!this.palette || this.palette.v !== themeVersion()) {
      // From the bass colour (accent) to the treble colour (a light stone), in 16 steps.
      const colors = Array.from({ length: PALETTE }, (_, i) => mix(theme.accentLight, theme.text, i / (PALETTE - 1)));
      this.palette = { v: themeVersion(), colors };
    }
    return this.palette.colors;
  }

  private scale(w: DeckWaveform): number {
    let p = this.peakOf.get(w);
    if (p === undefined) {
      p = 1e-4;
      for (let i = 0; i < w.buckets; i++) p = Math.max(p, Math.abs(w.min[i] as number), Math.abs(w.max[i] as number));
      this.peakOf.set(w, p);
    }
    return 0.92 / p;
  }

  private drawZoom(d: DeckState, pos: number, theme: TimelineTheme, W: number, H: number): void {
    if (W < 4 || H < 4) return;
    const g = fitCanvas(this.parts.zoom, W, H);
    g.clearRect(0, 0, W, H);
    g.fillStyle = theme.surfaceInset;
    g.fillRect(0, 0, W, H);
    const wave = this.api.waveformOf?.(this.id) ?? null;
    if (!d.song) return;
    const span = SCOPE_SPAN_SEC;
    const t0 = pos - span / 2;
    const perPx = span / W;
    const mid = H / 2;
    if (wave) {
      const k = this.scale(wave);
      const colors = this.colors(theme);
      const bps = wave.sampleRate / wave.bucket;
      for (let x = 0; x < W; x++) {
        const t = t0 + x * perPx;
        if (t < 0 || t > d.song.durationSec) continue;
        const b0 = Math.floor(t * bps);
        const b1 = Math.max(b0 + 1, Math.floor((t + perPx) * bps));
        let lo = 0;
        let hi = 0;
        let low = 0;
        for (let b = Math.max(0, b0); b < Math.min(wave.buckets, b1); b++) {
          const mn = wave.min[b] as number;
          const mx = wave.max[b] as number;
          if (mn < lo) lo = mn;
          if (mx > hi) hi = mx;
          const l = wave.low[b] as number;
          if (l > low) low = l;
        }
        const amp = Math.max(hi, -lo, 1e-5);
        const treble = Math.min(1, Math.max(0, 1 - low / amp));
        g.globalAlpha = x < W / 2 ? 0.55 : 1;
        g.fillStyle = colors[Math.round(treble * (PALETTE - 1))] as string;
        const y0 = mid - hi * k * mid;
        g.fillRect(x, y0, 1, Math.max(1, (hi - lo) * k * mid));
      }
      g.globalAlpha = 1;
    }
    const x = (t: number) => ((t - t0) / span) * W;
    // The loop.
    if (d.loop && d.loop.endSec > d.loop.startSec) {
      g.fillStyle = d.loop.active ? theme.accentSoft : alpha(theme.textFaint, 0.12);
      g.fillRect(x(d.loop.startSec), 0, x(d.loop.endSec) - x(d.loop.startSec), H);
      g.fillStyle = d.loop.active ? theme.accent : theme.textFaint;
      g.fillRect(x(d.loop.startSec), 0, 1.5, H);
      g.fillRect(x(d.loop.endSec) - 1.5, 0, 1.5, H);
    }
    // The beat grid.
    const grid = this.api.analysisOf?.(this.id)?.grid;
    if (grid && grid.beats.length >= MIN_TRACKED_BEATS) {
      // A song with tracked beats (its tempo drifts): the lines sit where the beats are, not on an even grid.
      const beats = grid.beats;
      const lower = (v: number) => {
        let lo = 0;
        let hi = beats.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if ((beats[mid] as number) < v) lo = mid + 1;
          else hi = mid;
        }
        return lo;
      };
      const zero = Math.min(beats.length - 1, lower(grid.firstDownbeat - 1e-9));
      const near = Math.abs((beats[Math.max(0, zero - 1)] as number) - grid.firstDownbeat) < Math.abs((beats[zero] as number) - grid.firstDownbeat) ? Math.max(0, zero - 1) : zero;
      for (let i = lower(t0); i < beats.length && (beats[i] as number) <= t0 + span; i++) {
        const bar = (((i - near) % grid.beatsPerBar) + grid.beatsPerBar) % grid.beatsPerBar === 0;
        g.fillStyle = bar ? alpha(theme.text, 0.35) : alpha(theme.text, 0.14);
        g.fillRect(Math.round(x(beats[i] as number)), bar ? 0 : H * 0.62, 1, bar ? H : H * 0.38);
      }
    } else if (grid) {
      const period = 60 / grid.bpm;
      const first = Math.ceil((t0 - grid.firstDownbeat) / period);
      const last = Math.floor((t0 + span - grid.firstDownbeat) / period);
      for (let n = first; n <= last; n++) {
        const bar = ((n % grid.beatsPerBar) + grid.beatsPerBar) % grid.beatsPerBar === 0;
        g.fillStyle = bar ? alpha(theme.text, 0.35) : alpha(theme.text, 0.14);
        g.fillRect(Math.round(x(grid.firstDownbeat + n * period)), bar ? 0 : H * 0.62, 1, bar ? H : H * 0.38);
      }
    }
    // Cue points: the main cue is a flag in the accent, hot cues carry their number.
    const flag = (t: number, color: string, text: string) => {
      const px = Math.round(x(t));
      if (px < -20 || px > W + 20) return;
      g.fillStyle = color;
      g.fillRect(px, 0, 1.5, H);
      g.fillRect(px, 0, 14, 12);
      g.fillStyle = theme.onLight;
      g.font = `600 ${fontPx(9)}px ${theme.font}`;
      g.textBaseline = 'middle';
      g.fillText(text, px + 4, 6.5);
    };
    flag(d.cuePoint, theme.accent, 'C');
    d.hotCues.forEach((t, i) => {
      if (t !== null) flag(t, hotCueColor(i, theme), String(i + 1));
    });
    // The playhead.
    g.fillStyle = theme.playhead;
    g.fillRect(W / 2 - 0.75, 0, 1.5, H);
  }

  private drawOverview(d: DeckState, pos: number, theme: TimelineTheme, W: number, H: number): void {
    if (W < 4 || H < 4) return;
    const g = fitCanvas(this.parts.overview, W, H);
    g.clearRect(0, 0, W, H);
    g.fillStyle = theme.surfaceInset;
    g.fillRect(0, 0, W, H);
    if (!d.song) return;
    const dur = Math.max(0.001, d.song.durationSec);
    const wave = this.api.waveformOf?.(this.id) ?? null;
    const cols = Math.floor(W);
    const mid = H / 2;
    const playedX = (pos / dur) * W;
    if (wave) {
      if (!this.reduced || this.reduced.wave !== wave || this.reduced.cols !== cols) {
        const out = { min: new Float32Array(cols), max: new Float32Array(cols), low: new Float32Array(cols) };
        reducePeaks(wave, cols, out);
        this.reduced = { wave, cols, ...out };
      }
      const r = this.reduced;
      const k = this.scale(wave);
      for (let c = 0; c < cols; c++) {
        const hi = (r.max[c] as number) * k;
        const lo = (r.min[c] as number) * k;
        g.fillStyle = c < playedX ? theme.textFaint : theme.accentDim;
        g.fillRect(c, mid - hi * mid, 1, Math.max(1, (hi - lo) * mid));
      }
    }
    const x = (t: number) => (t / dur) * W;
    if (d.loop && d.loop.endSec > d.loop.startSec) {
      g.fillStyle = d.loop.active ? theme.accentSoft : alpha(theme.textFaint, 0.14);
      g.fillRect(x(d.loop.startSec), 0, Math.max(2, x(d.loop.endSec) - x(d.loop.startSec)), H);
    }
    g.fillStyle = theme.accent;
    g.fillRect(x(d.cuePoint), H - 5, 2, 5);
    d.hotCues.forEach((t, i) => {
      if (t === null) return;
      g.fillStyle = hotCueColor(i, theme);
      g.fillRect(x(t), 0, 2, 6);
    });
    g.fillStyle = theme.playhead;
    g.fillRect(playedX - 0.75, 0, 1.5, H);
  }
}

let hotColors: { v: number; colors: string[] } | null = null;

/** A hot cue's color from the theme's palette (resolved for canvas use, read again when the theme changes). */
function hotCueColor(i: number, theme: TimelineTheme): string {
  if (!hotColors || hotColors.v !== themeVersion()) {
    const cs = getComputedStyle(document.documentElement);
    hotColors = { v: themeVersion(), colors: Array.from({ length: 8 }, (_, n) => cs.getPropertyValue(`--ag-palette-${n + 1}`).trim() || theme.marker) };
  }
  return hotColors.colors[i % 8] as string;
}
