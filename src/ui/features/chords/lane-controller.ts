/**
 * The chord lane above the playlist: an imperative canvas controller (same architecture as the playlist and piano roll).
 * It draws the chord track lined up with the playlist's view, redraws only when something changed, and turns pointer work
 * into chord edits: click an empty spot to type a chord, drag across to draw one, drag a chord to move it, drag its
 * edges to resize it, double-click to retype it, right-click for the menu. Drags preview on the canvas and commit as one undo step.
 */
import { addChordAt, deleteChord, renameChord } from '@app/harmony/chord-track';
import type { Services } from '@app/services';
import { formatChord, parseChord, qualityOf } from '@core/harmony/chord';
import { harmonyKey } from '@core/harmony/key';
import { romanOf } from '@core/harmony/scale';
import type { ChordEvent, ChordId, Project, Tick } from '@core/model/types';
import { resizeChord, symbolOf } from '@core/ops/chords';
import { chordsSorted, projectUsesFlats } from '@core/query/chords';
import { ticksPerBar } from '@core/time/ppq';
import { gridTicks } from '@core/time/snap';
import { emitHint } from '@agstudio/sdk/ui';
import { rolesOf } from '@app/arrange/env';
import { onFrame } from '../../frame-loop';
import { alpha, fitCanvas, onThemeChange, readTheme, roundRectPath, type TimelineTheme } from '../../timeline/canvas';
import {
  createdSpan,
  endDraggedSpan,
  hitChord,
  MIN_LABEL_PX,
  movedSpan,
  startDraggedSpan,
  type ChordBox,
  type ChordSpanTicks,
  type ChordZone,
} from './lane-geometry';

/** Height of the lane (CSS px). */
export const CHORD_LANE_HEIGHT = 26;

/** The playlist's view as the lane needs it. */
export interface LaneView {
  scrollTick: number;
  pxPerTick: number;
}

type Drag =
  | { kind: 'chord'; id: ChordId; zone: ChordZone; x0: number; original: ChordSpanTicks; preview: ChordSpanTicks; moved: boolean }
  | { kind: 'create'; x0: number; startTick: Tick; endTick: Tick; moved: boolean };

/** Fewer than this many px of pointer travel is a click, not a drag. */
const CLICK_SLOP_PX = 4;
/** Confidence below this draws the chord as a guess (faded, dashed). */
const GUESS_BELOW = 0.5;

/** The elements the chord lane draws on and listens to, given by its React component. */
export interface ChordLaneElements {
  canvas: HTMLCanvasElement;
  /** The text box chords are typed in (placed by the controller). */
  input: HTMLInputElement;
}

/** The chord lane above the playlist: draws the chord bars lined up with the playlist's scroll and zoom, and edits them with the pointer and the keyboard. */
export class ChordLaneController {
  private dirty = true;
  private boxes: ChordBox[] = [];
  private selected: ChordId | null = null;
  private hot: ChordId | null = null;
  private drag: Drag | null = null;
  private unsubs: Array<() => void> = [];
  private lastScroll = NaN;
  private lastZoom = NaN;
  private lastWidth = 0;
  /** The chord being typed: a new one at a span, or an existing one to rename. */
  private typing: { span: ChordSpanTicks; id: ChordId | null } | null = null;
  private lastHint: string | null = null;

  /** Opens the lane's right-click menu (set by the component, which owns menus). */
  onMenu?: (chordId: ChordId | null, tick: Tick, at: { clientX: number; clientY: number }) => void;

  constructor(
    private readonly s: Services,
    private readonly els: ChordLaneElements,
    private readonly view: () => LaneView | null,
  ) {}

  mount(): void {
    const { s, els } = this;
    const redraw = () => (this.dirty = true);
    this.unsubs.push(
      s.doc.subscribe((next, prev) => {
        if (next.project.chords !== prev.project.chords || next.project.transport !== prev.project.transport) redraw();
      }),
      onThemeChange(redraw),
      onFrame(() => this.frame()),
    );
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      el.addEventListener(type, fn as EventListener);
      this.unsubs.push(() => el.removeEventListener(type, fn as EventListener));
    };
    on(els.canvas, 'pointerdown', (e) => this.onDown(e));
    on(els.canvas, 'pointermove', (e) => this.onMove(e));
    on(els.canvas, 'pointerup', (e) => this.onUp(e));
    on(els.canvas, 'pointercancel', () => this.cancelDrag());
    on(els.canvas, 'pointerleave', () => this.setHot(null));
    on(els.canvas, 'dblclick', (e) => this.onDouble(e));
    on(els.canvas, 'contextmenu', (e) => this.onContext(e));
    on(els.canvas, 'keydown', (e) => this.onKey(e));
    on(els.input, 'keydown', (e) => this.onInputKey(e));
    on(els.input, 'blur', () => this.closeInput());
  }

  unmount(): void {
    this.cancelDrag();
    for (const fn of this.unsubs.splice(0)) fn();
  }

  // ---------------------------------------------------------------- data

  private project(): Project {
    return this.s.doc.getState().project;
  }

  private grid(altKey: boolean): Tick {
    if (altKey) return 1;
    const p = this.project();
    const view = this.view();
    return gridTicks(this.s.editor.getState().playlist.snap, p.transport.timeSig, view?.pxPerTick ?? 0.025);
  }

  private tickAt(x: number): Tick {
    const view = this.view();
    return view ? view.scrollTick + x / view.pxPerTick : 0;
  }

  private localX(e: PointerEvent | MouseEvent): number {
    return e.clientX - this.els.canvas.getBoundingClientRect().left;
  }

  private eventOf(id: ChordId | null): ChordEvent | undefined {
    return id ? this.project().chords?.[id] : undefined;
  }

  // ---------------------------------------------------------------- drawing

  private frame(): void {
    const view = this.view();
    const canvas = this.els.canvas;
    const width = canvas.clientWidth;
    if (!view || width <= 0) return;
    if (view.scrollTick !== this.lastScroll || view.pxPerTick !== this.lastZoom || width !== this.lastWidth) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    this.lastScroll = view.scrollTick;
    this.lastZoom = view.pxPerTick;
    this.lastWidth = width;
    this.draw(fitCanvas(canvas, width, CHORD_LANE_HEIGHT), view, width, readTheme());
  }

  private draw(ctx: CanvasRenderingContext2D, view: LaneView, width: number, theme: TimelineTheme): void {
    const p = this.project();
    ctx.fillStyle = theme.surface2;
    ctx.fillRect(0, 0, width, CHORD_LANE_HEIGHT);
    this.drawBarLines(ctx, view, width, theme, ticksPerBar(p.transport.timeSig));
    const flats = projectUsesFlats(p);
    const key = harmonyKey(p, rolesOf(p));
    this.boxes = [];
    const chords = chordsSorted(p);
    if (chords.length === 0 && !this.drag) this.drawEmptyHint(ctx, theme);
    for (const event of chords) {
      const span = this.drag?.kind === 'chord' && this.drag.id === event.id ? this.drag.preview : event;
      const left = (span.tick - view.scrollTick) * view.pxPerTick;
      const right = (span.tick + span.length - view.scrollTick) * view.pxPerTick;
      if (right < 0 || left > width) continue;
      this.boxes.push({ id: event.id, left, right });
      this.drawChord(ctx, theme, event, left, right, { flats, key });
    }
    if (this.drag?.kind === 'create' && this.drag.moved) this.drawNewSpan(ctx, theme, view, this.drag);
    ctx.fillStyle = theme.lineFaint;
    ctx.fillRect(0, CHORD_LANE_HEIGHT - 1, width, 1);
  }

  private drawBarLines(ctx: CanvasRenderingContext2D, view: LaneView, width: number, theme: TimelineTheme, bar: Tick): void {
    ctx.fillStyle = alpha(theme.bar, 0.6);
    const first = Math.floor(view.scrollTick / bar);
    for (let b = first; ; b++) {
      const x = Math.round((b * bar - view.scrollTick) * view.pxPerTick);
      if (x > width) break;
      if (x >= 0) ctx.fillRect(x, 0, 1, CHORD_LANE_HEIGHT);
    }
  }

  private drawEmptyHint(ctx: CanvasRenderingContext2D, theme: TimelineTheme): void {
    ctx.fillStyle = theme.textFaint;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('No chords yet: click here and type one (Am7, F/C…), or open Chords to pick a progression or detect them', 10, CHORD_LANE_HEIGHT / 2);
  }

  private drawChord(
    ctx: CanvasRenderingContext2D,
    theme: TimelineTheme,
    event: ChordEvent,
    left: number,
    right: number,
    context: { flats: boolean; key: ReturnType<typeof harmonyKey> },
  ): void {
    const isSelected = event.id === this.selected;
    const isGuess = event.confidence !== undefined && event.confidence < GUESS_BELOW;
    const x = left + 1;
    const w = Math.max(2, right - left - 2);
    ctx.beginPath();
    roundRectPath(ctx, x, 3, w, CHORD_LANE_HEIGHT - 7, 4);
    ctx.fillStyle = alpha(theme.accent, isSelected ? 0.5 : event.id === this.hot ? 0.38 : 0.26);
    ctx.globalAlpha = isGuess ? 0.6 : 1;
    ctx.fill();
    ctx.strokeStyle = isSelected ? theme.accentLight : alpha(theme.accent, 0.7);
    ctx.setLineDash(isGuess ? [3, 3] : []);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    if (w < MIN_LABEL_PX) return;
    const symbol = symbolOf(event);
    const roman = romanOf(context.key, symbol);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, 0, w, CHORD_LANE_HEIGHT);
    ctx.clip();
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = theme.text;
    const name = formatChord(symbol, context.flats);
    ctx.fillText(name, x + 6, CHORD_LANE_HEIGHT / 2);
    const nameWidth = ctx.measureText(name).width;
    if (roman && w > nameWidth + 40) {
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillStyle = theme.textDim;
      ctx.fillText(roman, x + 12 + nameWidth, CHORD_LANE_HEIGHT / 2 + 1);
    }
    ctx.restore();
  }

  private drawNewSpan(ctx: CanvasRenderingContext2D, theme: TimelineTheme, view: LaneView, drag: Extract<Drag, { kind: 'create' }>): void {
    const span = createdSpan(drag.startTick, drag.endTick, this.grid(false), 0, []);
    const left = (span.tick - view.scrollTick) * view.pxPerTick;
    ctx.fillStyle = alpha(theme.accent, 0.2);
    ctx.fillRect(left, 3, span.length * view.pxPerTick, CHORD_LANE_HEIGHT - 7);
  }

  // ---------------------------------------------------------------- pointer

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.els.canvas.focus();
    this.closeInput();
    const x = this.localX(e);
    const hit = hitChord(this.boxes, x);
    this.els.canvas.setPointerCapture(e.pointerId);
    if (hit) {
      const event = this.eventOf(hit.id);
      if (!event) return;
      this.select(hit.id);
      const original = { tick: event.tick, length: event.length };
      this.drag = { kind: 'chord', id: hit.id, zone: hit.zone, x0: x, original, preview: original, moved: false };
    } else {
      this.select(null);
      const tick = this.tickAt(x);
      this.drag = { kind: 'create', x0: x, startTick: tick, endTick: tick, moved: false };
    }
    this.dirty = true;
  }

  private onMove(e: PointerEvent): void {
    const x = this.localX(e);
    const drag = this.drag;
    if (!drag) {
      this.setHot(hitChord(this.boxes, x)?.id ?? null);
      this.updateCursor(x);
      return;
    }
    if (Math.abs(x - drag.x0) >= CLICK_SLOP_PX) drag.moved = true;
    if (!drag.moved) return;
    const grid = this.grid(e.altKey);
    const view = this.view();
    const delta = view ? (x - drag.x0) / view.pxPerTick : 0;
    if (drag.kind === 'create') drag.endTick = this.tickAt(x);
    else if (drag.zone === 'body') drag.preview = movedSpan(drag.original, delta, grid);
    else if (drag.zone === 'start') drag.preview = startDraggedSpan(drag.original, delta, grid);
    else drag.preview = endDraggedSpan(drag.original, delta, grid);
    this.dirty = true;
  }

  private onUp(e: PointerEvent): void {
    const drag = this.drag;
    this.drag = null;
    this.dirty = true;
    if (!drag) return;
    const grid = this.grid(e.altKey);
    if (drag.kind === 'create') {
      const span = createdSpan(drag.startTick, drag.endTick, grid, ticksPerBar(this.project().transport.timeSig), chordsSorted(this.project()));
      this.openInput(span, null);
      return;
    }
    if (!drag.moved) return;
    const { id, preview, original } = drag;
    if (preview.tick === original.tick && preview.length === original.length) return;
    this.s.history.transact(drag.zone === 'body' ? 'Move chord' : 'Resize chord', (draft) => resizeChord(draft, id, preview.tick, preview.length));
  }

  private cancelDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    this.dirty = true;
  }

  private onDouble(e: MouseEvent): void {
    const hit = hitChord(this.boxes, this.localX(e));
    const event = this.eventOf(hit?.id ?? null);
    if (event) this.openInput({ tick: event.tick, length: event.length }, event.id);
  }

  private onContext(e: MouseEvent): void {
    e.preventDefault();
    const hit = hitChord(this.boxes, this.localX(e));
    if (hit) this.select(hit.id);
    this.onMenu?.(hit?.id ?? null, this.tickAt(this.localX(e)), e);
  }

  private onKey(e: KeyboardEvent): void {
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
      e.preventDefault();
      deleteChord(this.s, this.selected);
      this.selected = null;
    } else if (e.key === 'Escape') this.cancelDrag();
    else if (e.key === 'Enter' && this.selected) {
      const event = this.eventOf(this.selected);
      if (event) this.openInput({ tick: event.tick, length: event.length }, event.id);
    }
  }

  // ---------------------------------------------------------------- typing

  /** Shows the text box over a span: typing a chord name and pressing Enter makes (or retypes) the chord. */
  openInput(span: ChordSpanTicks, id: ChordId | null): void {
    const view = this.view();
    if (!view) return;
    const input = this.els.input;
    const event = this.eventOf(id);
    this.typing = { span, id };
    const left = Math.max(0, (span.tick - view.scrollTick) * view.pxPerTick);
    input.style.display = 'block';
    input.style.left = `${Math.min(left, Math.max(0, this.els.canvas.clientWidth - 90))}px`;
    input.style.width = `${Math.max(70, Math.min(160, span.length * view.pxPerTick - 2))}px`;
    input.value = event ? formatChord(symbolOf(event), projectUsesFlats(this.project())) : '';
    input.focus();
    input.select();
    emitHint(this.els.canvas, 'Type a chord (Am7, F/C, Bbmaj7, Gsus4) · Enter adds it · Tab adds it and moves to the next bar · Esc cancels');
  }

  private closeInput(): void {
    if (!this.typing) return;
    this.typing = null;
    this.els.input.style.display = 'none';
  }

  private onInputKey(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === 'Escape') {
      this.closeInput();
      this.els.canvas.focus();
      return;
    }
    if (e.key !== 'Enter' && e.key !== 'Tab') return;
    e.preventDefault();
    const typing = this.typing;
    if (!typing) return;
    const text = this.els.input.value.trim();
    const chord = parseChord(text);
    if (!text) {
      this.closeInput();
      return;
    }
    if (!chord) {
      emitHint(this.els.canvas, `“${text}” is not a chord: try Am7, F/C, Bbmaj7, Gsus4, Dadd9, Bm7b5, G°7`);
      return;
    }
    const next = this.commitTyped(typing, chord, text);
    this.closeInput();
    if (e.key === 'Tab' && next) this.openInput({ tick: next, length: typing.span.length }, null);
    else this.els.canvas.focus();
  }

  /** Makes the chord (or retypes the one being edited); returns the tick after it for Tab to continue from. */
  private commitTyped(typing: { span: ChordSpanTicks; id: ChordId | null }, chord: NonNullable<ReturnType<typeof parseChord>>, text: string): Tick {
    if (typing.id) renameChord(this.s, typing.id, text);
    else {
      const id = addChordAt(this.s, typing.span.tick, typing.span.length, chord);
      this.select(id);
    }
    return typing.span.tick + typing.span.length;
  }

  // ---------------------------------------------------------------- small things

  private select(id: ChordId | null): void {
    if (this.selected === id) return;
    this.selected = id;
    this.dirty = true;
  }

  private setHot(id: ChordId | null): void {
    if (this.hot === id) return;
    this.hot = id;
    this.dirty = true;
    this.hintFor(id);
  }

  private hintFor(id: ChordId | null): void {
    const event = this.eventOf(id);
    const text = event
      ? `${formatChord(symbolOf(event), projectUsesFlats(this.project()))}: ${qualityOf(event.quality).label}${
          event.confidence !== undefined ? `, detected (${Math.round(event.confidence * 100)} % sure)` : ''
        }. Drag to move, drag an edge to resize, double-click to retype, right-click for more`
      : null;
    if (text !== this.lastHint) {
      this.lastHint = text;
      if (text) emitHint(this.els.canvas, text);
    }
  }

  private updateCursor(x: number): void {
    const hit = hitChord(this.boxes, x);
    this.els.canvas.style.cursor = !hit ? 'text' : hit.zone === 'body' ? 'grab' : 'ew-resize';
  }
}
