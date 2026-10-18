/**
 * Mixer peak meters, drawn on canvases from the frame loop (never through React). Each frame reads
 * the peaks of the strips that are on screen with one engine call into a reused buffer (a strip
 * scrolled out of view isn't read, so the engine drops its analysers); the decay (ballistics) and peak
 * hold happen here. A canvas is only repainted when what it shows changes, so silence costs nothing.
 */
import type { Services } from '@app/services';
import type { InsertId } from '@core/model/types';
import { onFrame } from '../../frame-loop';
import { onThemeChange, readTheme } from '../../timeline/canvas';
import { dbToPosition, FADER_PAD, FLOOR_DB } from './scale';

/** Displayed level falls this fast once the signal drops (dB per second). */
const FALL_DB_PER_S = 26;
/** The peak marker holds for this long before falling. */
const HOLD_MS = 1500;

interface Meter {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D | null;
  /** Canvas size in device pixels. */
  w: number;
  h: number;
  dpr: number;
  gradient: CanvasGradient | null;
  /** The same scale, faint: the unlit part of the meter. */
  unlit: CanvasGradient | null;
  level: [number, number];
  hold: [number, number];
  holdUntil: [number, number];
  /** On screen: only these are read and drawn. */
  visible: boolean;
  /** What was painted last: the five numbers of `draw`'s signature (`painted` false forces a repaint). */
  painted: boolean;
  dL: number;
  dR: number;
  dHL: number;
  dHR: number;
  dClip: boolean;
}

interface Colors {
  lo: string;
  mid: string;
  hi: string;
  hold: string;
  tick: string;
  /** The unlit scale's opacity. */
  unlit: number;
}

/** The device-pixel row of a level (dB) on a meter of `m`'s height, with the given pad and span. */
function meterY(meter: Meter, db: number, pad: number, span: number): number {
  return Math.round(meter.h - pad - dbToPosition(db) * span);
}

export class MeterBank {
  private readonly meters = new Map<InsertId, Meter>();
  private readonly byCanvas = new WeakMap<Element, Meter>();
  private peaks = new Float32Array(0);
  private observer: ResizeObserver | null = null;
  private visibility: IntersectionObserver | null = null;
  /** This frame's strips: the ids handed to the engine and the meters they belong to (reused). */
  private readonly shownIds: InsertId[] = [];
  private readonly shown: Meter[] = [];
  private colors: Colors | null = null;
  private lastTime = 0;

  /** Registers an insert's canvas (use as a ref callback; returns the cleanup). */
  attach(id: InsertId, canvas: HTMLCanvasElement): () => void {
    const meter: Meter = {
      canvas,
      g: canvas.getContext('2d'),
      w: 0,
      h: 0,
      dpr: 1,
      gradient: null,
      unlit: null,
      level: [FLOOR_DB, FLOOR_DB],
      hold: [FLOOR_DB, FLOOR_DB],
      holdUntil: [0, 0],
      // Visible until the observer says otherwise: the first frame draws before it has reported.
      visible: true,
      painted: false,
      dL: 0,
      dR: 0,
      dHL: 0,
      dHR: 0,
      dClip: false,
    };
    this.meters.set(id, meter);
    this.byCanvas.set(canvas, meter);
    this.observer?.observe(canvas);
    this.visibility?.observe(canvas);
    return () => {
      if (this.meters.get(id) === meter) this.meters.delete(id);
      this.observer?.unobserve(canvas);
      this.visibility?.unobserve(canvas);
    };
  }

  /** Starts painting; returns the stop function. */
  start(services: Services): () => void {
    this.resolveColors();
    this.observer = new ResizeObserver((entries) => {
      for (const entry of entries) this.resize(entry);
    });
    for (const meter of this.meters.values()) this.observer.observe(meter.canvas);
    // Strips scrolled out of the mixer aren't read or drawn.
    if (typeof IntersectionObserver !== 'undefined') {
      this.visibility = new IntersectionObserver((entries) => {
        for (const entry of entries) this.setVisible(entry.target, entry.isIntersecting);
      });
      for (const meter of this.meters.values()) this.visibility.observe(meter.canvas);
    }
    const stop = onFrame((now) => this.frame(services, now));
    // A new theme or accent: new colors, and every meter's gradient and drawing again.
    const offTheme = onThemeChange(() => {
      this.resolveColors();
      for (const meter of this.meters.values()) this.buildGradient(meter);
    });
    return () => {
      stop();
      offTheme();
      this.observer?.disconnect();
      this.observer = null;
      this.visibility?.disconnect();
      this.visibility = null;
      for (const meter of this.meters.values()) meter.visible = true;
      this.lastTime = 0;
    };
  }

  /** A strip came into view or left it (the observer calls this). Coming back it starts from silence, like a meter just made. */
  setVisible(target: Element, visible: boolean): void {
    const meter = this.byCanvas.get(target);
    if (!meter || meter.visible === visible) return;
    meter.visible = visible;
    if (visible) {
      for (let c = 0; c < 2; c++) {
        meter.level[c] = FLOOR_DB;
        meter.hold[c] = FLOOR_DB;
        meter.holdUntil[c] = 0;
      }
      meter.painted = false;
    }
  }

  private frame(services: Services, now: number): void {
    const order = services.doc.getState().project.mixer.order;
    // Only the strips on screen are read: the engine asks every analyser for its last 2048 samples.
    const ids = this.shownIds;
    const shown = this.shown;
    let n = 0;
    for (let i = 0; i < order.length; i++) {
      const id = order[i] as InsertId;
      const meter = this.meters.get(id);
      if (!meter || !meter.visible) continue;
      ids[n] = id;
      shown[n] = meter;
      n++;
    }
    ids.length = n;
    shown.length = n;
    if (this.peaks.length < n * 2) this.peaks = new Float32Array(n * 2);
    // A suspended context keeps returning its last samples; show silence instead.
    if (n === 0) {
      this.lastTime = now;
      return;
    }
    if (services.engine.state === 'running') services.engine.readMeters(ids, this.peaks);
    else this.peaks.fill(0);
    const dt = this.lastTime ? Math.min(0.1, (now - this.lastTime) / 1000) : 0;
    this.lastTime = now;
    const fall = FALL_DB_PER_S * dt;
    for (let i = 0; i < n; i++) {
      const meter = shown[i] as Meter;
      for (let c = 0; c < 2; c++) {
        const peak = this.peaks[i * 2 + c] as number;
        const db = peak > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(peak)) : FLOOR_DB;
        meter.level[c] = Math.max(db, meter.level[c]! - fall);
        if (db >= meter.hold[c]!) {
          meter.hold[c] = db;
          meter.holdUntil[c] = now + HOLD_MS;
        } else if (now > meter.holdUntil[c]!) {
          meter.hold[c] = Math.max(db, meter.hold[c]! - fall);
        }
      }
      this.draw(meter);
    }
  }

  private resize(entry: ResizeObserverEntry): void {
    const meter = this.byCanvas.get(entry.target);
    if (!meter) return;
    const dpr = window.devicePixelRatio || 1;
    const box = entry.devicePixelContentBoxSize?.[0];
    const w = Math.round(box ? box.inlineSize : entry.contentRect.width * dpr);
    const h = Math.round(box ? box.blockSize : entry.contentRect.height * dpr);
    if (w === meter.w && h === meter.h && dpr === meter.dpr) return;
    meter.w = w;
    meter.h = h;
    meter.dpr = dpr;
    meter.canvas.width = w;
    meter.canvas.height = h;
    this.buildGradient(meter);
  }

  /** The meter's fill (green to gold to red up the scale) for its size and the theme's colors. */
  private buildGradient(meter: Meter): void {
    const { dpr, h } = meter;
    meter.painted = false;
    meter.gradient = null;
    meter.unlit = null;
    const c = this.colors;
    if (meter.g && h > 0 && c) {
      const pad = FADER_PAD * dpr;
      const make = () => {
        const grad = (meter.g as CanvasRenderingContext2D).createLinearGradient(0, h - pad, 0, pad);
        grad.addColorStop(0, c.lo);
        grad.addColorStop(dbToPosition(-18), c.lo);
        grad.addColorStop(dbToPosition(-6), c.mid);
        grad.addColorStop(dbToPosition(0), c.hi);
        grad.addColorStop(1, c.hi);
        return grad;
      };
      meter.gradient = make();
      meter.unlit = make();
    }
  }

  private draw(meter: Meter): void {
    const g = meter.g;
    const c = this.colors;
    if (!g || !c || !meter.gradient || meter.w === 0 || meter.h === 0) return;
    const pad = FADER_PAD * meter.dpr;
    const span = meter.h - 2 * pad;
    // Separate consts, not a destructured array literal, and no closure: both were garbage on every frame.
    const l = meterY(meter, meter.level[0], pad, span);
    const r = meterY(meter, meter.level[1], pad, span);
    const hl = meterY(meter, meter.hold[0], pad, span);
    const hr = meterY(meter, meter.hold[1], pad, span);
    const clip = meter.hold[0] > 0 || meter.hold[1] > 0;
    if (meter.painted && l === meter.dL && r === meter.dR && hl === meter.dHL && hr === meter.dHR && clip === meter.dClip) return;
    meter.painted = true;
    meter.dL = l;
    meter.dR = r;
    meter.dHL = hl;
    meter.dHR = hr;
    meter.dClip = clip;
    const bottom = Math.round(meter.h - pad);
    const gap = Math.max(1, Math.round(meter.dpr));
    const bar = Math.floor((meter.w - gap) / 2);
    g.clearRect(0, 0, meter.w, meter.h);
    const top = Math.round(pad);
    // The unlit scale, faint, so the meter reads as a slim colored channel even in silence.
    g.globalAlpha = c.unlit;
    g.fillStyle = meter.unlit as CanvasGradient;
    g.fillRect(0, top, bar, bottom - top);
    g.fillRect(meter.w - bar, top, bar, bottom - top);
    g.globalAlpha = 1;
    g.fillStyle = meter.gradient;
    if (l < bottom) g.fillRect(0, l, bar, bottom - l);
    if (r < bottom) g.fillRect(meter.w - bar, r, bar, bottom - r);
    // 0 dB tick.
    g.fillStyle = c.tick;
    g.fillRect(0, meterY(meter, 0, pad, span), meter.w, gap);
    g.fillStyle = clip ? c.hi : c.hold;
    if (hl < bottom) g.fillRect(0, hl, bar, gap);
    if (hr < bottom) g.fillRect(meter.w - bar, hr, bar, gap);
  }

  private resolveColors(): void {
    const t = readTheme();
    this.colors = {
      lo: t.meterLo,
      mid: t.meterMid,
      hi: t.meterHi,
      hold: t.text,
      tick: t.textFaint,
      unlit: 0.12,
    };
  }
}
