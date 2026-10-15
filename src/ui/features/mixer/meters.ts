/**
 * Mixer peak meters, drawn on canvases from the frame loop (never through React). Each frame reads
 * every insert's peaks with one engine call into a reused buffer; the decay (ballistics) and peak
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
  /** What was painted last ("" forces a repaint). */
  drawn: string;
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

export class MeterBank {
  private readonly meters = new Map<InsertId, Meter>();
  private readonly byCanvas = new WeakMap<Element, Meter>();
  private peaks = new Float32Array(0);
  private observer: ResizeObserver | null = null;
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
      drawn: '',
    };
    this.meters.set(id, meter);
    this.byCanvas.set(canvas, meter);
    this.observer?.observe(canvas);
    return () => {
      if (this.meters.get(id) === meter) this.meters.delete(id);
      this.observer?.unobserve(canvas);
    };
  }

  /** Starts painting; returns the stop function. */
  start(services: Services): () => void {
    this.resolveColors();
    this.observer = new ResizeObserver((entries) => {
      for (const entry of entries) this.resize(entry);
    });
    for (const m of this.meters.values()) this.observer.observe(m.canvas);
    const stop = onFrame((now) => this.frame(services, now));
    // A new theme or accent: new colors, and every meter's gradient and drawing again.
    const offTheme = onThemeChange(() => {
      this.resolveColors();
      for (const m of this.meters.values()) this.buildGradient(m);
    });
    return () => {
      stop();
      offTheme();
      this.observer?.disconnect();
      this.observer = null;
      this.lastTime = 0;
    };
  }

  private frame(services: Services, now: number): void {
    const order = services.doc.getState().project.mixer.order;
    if (this.peaks.length < order.length * 2) this.peaks = new Float32Array(order.length * 2);
    // A suspended context keeps returning its last samples; show silence instead.
    if (services.engine.state === 'running') services.engine.readMeters(order, this.peaks);
    else this.peaks.fill(0);
    const dt = this.lastTime ? Math.min(0.1, (now - this.lastTime) / 1000) : 0;
    this.lastTime = now;
    const fall = FALL_DB_PER_S * dt;
    for (let i = 0; i < order.length; i++) {
      const m = this.meters.get(order[i] as InsertId);
      if (!m) continue;
      for (let c = 0; c < 2; c++) {
        const peak = this.peaks[i * 2 + c] as number;
        const db = peak > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(peak)) : FLOOR_DB;
        m.level[c] = Math.max(db, m.level[c]! - fall);
        if (db >= m.hold[c]!) {
          m.hold[c] = db;
          m.holdUntil[c] = now + HOLD_MS;
        } else if (now > m.holdUntil[c]!) {
          m.hold[c] = Math.max(db, m.hold[c]! - fall);
        }
      }
      this.draw(m);
    }
  }

  private resize(entry: ResizeObserverEntry): void {
    const m = this.byCanvas.get(entry.target);
    if (!m) return;
    const dpr = window.devicePixelRatio || 1;
    const box = entry.devicePixelContentBoxSize?.[0];
    const w = Math.round(box ? box.inlineSize : entry.contentRect.width * dpr);
    const h = Math.round(box ? box.blockSize : entry.contentRect.height * dpr);
    if (w === m.w && h === m.h && dpr === m.dpr) return;
    m.w = w;
    m.h = h;
    m.dpr = dpr;
    m.canvas.width = w;
    m.canvas.height = h;
    this.buildGradient(m);
  }

  /** The meter's fill (green to gold to red up the scale) for its size and the theme's colors. */
  private buildGradient(m: Meter): void {
    const { dpr, h } = m;
    m.drawn = '';
    m.gradient = null;
    m.unlit = null;
    const c = this.colors;
    if (m.g && h > 0 && c) {
      const pad = FADER_PAD * dpr;
      const make = () => {
        const grad = (m.g as CanvasRenderingContext2D).createLinearGradient(0, h - pad, 0, pad);
        grad.addColorStop(0, c.lo);
        grad.addColorStop(dbToPosition(-18), c.lo);
        grad.addColorStop(dbToPosition(-6), c.mid);
        grad.addColorStop(dbToPosition(0), c.hi);
        grad.addColorStop(1, c.hi);
        return grad;
      };
      m.gradient = make();
      m.unlit = make();
    }
  }

  private draw(m: Meter): void {
    const g = m.g;
    const c = this.colors;
    if (!g || !c || !m.gradient || m.w === 0 || m.h === 0) return;
    const pad = FADER_PAD * m.dpr;
    const span = m.h - 2 * pad;
    const y = (db: number) => Math.round(m.h - pad - dbToPosition(db) * span);
    const [l, r, hl, hr] = [y(m.level[0]), y(m.level[1]), y(m.hold[0]), y(m.hold[1])];
    const clip = m.hold[0] > 0 || m.hold[1] > 0;
    const sig = `${l},${r},${hl},${hr},${clip}`;
    if (sig === m.drawn) return;
    m.drawn = sig;
    const bottom = Math.round(m.h - pad);
    const gap = Math.max(1, Math.round(m.dpr));
    const bar = Math.floor((m.w - gap) / 2);
    g.clearRect(0, 0, m.w, m.h);
    const top = Math.round(pad);
    // The unlit scale, faint, so the meter reads as a slim colored channel even in silence.
    g.globalAlpha = c.unlit;
    g.fillStyle = m.unlit as CanvasGradient;
    g.fillRect(0, top, bar, bottom - top);
    g.fillRect(m.w - bar, top, bar, bottom - top);
    g.globalAlpha = 1;
    g.fillStyle = m.gradient;
    if (l < bottom) g.fillRect(0, l, bar, bottom - l);
    if (r < bottom) g.fillRect(m.w - bar, r, bar, bottom - r);
    // 0 dB tick.
    g.fillStyle = c.tick;
    g.fillRect(0, y(0), m.w, gap);
    g.fillStyle = clip ? c.hi : c.hold;
    if (hl < bottom) g.fillRect(0, hl, bar, gap);
    if (hr < bottom) g.fillRect(m.w - bar, hr, bar, gap);
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
