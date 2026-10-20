/**
 * The lyrics lane above the playlist: an imperative canvas controller (same architecture as the chord lane). It draws the
 * words and syllables lined up with the playlist's view, redraws only when something changed, and turns pointer work into
 * edits: click an empty spot to type a word, drag across to draw its length, drag a word to move it, drag its edges to
 * resize it, double-click to retype it, right-click for the menu. Drags preview on the canvas and commit as one undo step.
 */
import { addLyricAt, deleteLyrics, moveLyrics, resizeLyric, retypeLyric } from '@app/lyrics/actions';
import type { Services } from '@app/services';
import { wordLabel } from '@core/lyrics/lines';
import type { LyricId, LyricWord, Project, Tick } from '@core/model/types';
import { lyricsSorted } from '@core/query/lyrics';
import { ticksPerBar, ticksPerBeat } from '@core/time/ppq';
import { gridTicks } from '@core/time/snap';
import { emitHint } from '@agstudio/sdk/ui';
import { onFrame } from '../../frame-loop';
import { alpha, fitCanvas, onThemeChange, readTheme, roundRectPath, type TimelineTheme } from '../../timeline/canvas';
import {
  createdSpan,
  endDraggedSpan,
  hitWord,
  MIN_LABEL_PX,
  movedSpan,
  spansOf,
  startDraggedSpan,
  type SpanTicks,
  type WordBox,
  type WordZone,
} from './lane-geometry';

/** Height of the lane (CSS px). */
export const LYRICS_LANE_HEIGHT = 26;

/** The playlist's view as the lane needs it. */
export interface LaneView {
  scrollTick: number;
  pxPerTick: number;
}

type Drag =
  | { kind: 'word'; id: LyricId; zone: WordZone; x0: number; original: SpanTicks; preview: SpanTicks; moved: boolean }
  | { kind: 'create'; x0: number; startTick: Tick; endTick: Tick; moved: boolean };

/** Fewer than this many px of pointer travel is a click, not a drag. */
const CLICK_SLOP_PX = 4;

/** The elements the lane draws on and listens to, given by its React component. */
export interface LyricsLaneElements {
  canvas: HTMLCanvasElement;
  /** The text box words are typed in (placed by the controller). */
  input: HTMLInputElement;
}

/** The lyrics lane above the playlist: draws the words lined up with the playlist's scroll and zoom, and edits them. */
export class LyricsLaneController {
  private dirty = true;
  private boxes: WordBox[] = [];
  private selected: LyricId | null = null;
  private hot: LyricId | null = null;
  private drag: Drag | null = null;
  private unsubs: Array<() => void> = [];
  private lastScroll = NaN;
  private lastZoom = NaN;
  private lastWidth = 0;
  /** The word being typed: a new one at a span, or an existing one to retype. */
  private typing: { span: SpanTicks; id: LyricId | null } | null = null;
  private lastHint: string | null = null;

  /** Opens the lane's right-click menu (set by the component, which owns menus). */
  onMenu?: (wordId: LyricId | null, tick: Tick, at: { clientX: number; clientY: number }) => void;

  constructor(
    private readonly s: Services,
    private readonly els: LyricsLaneElements,
    private readonly view: () => LaneView | null,
  ) {}

  mount(): void {
    const { s, els } = this;
    const redraw = () => (this.dirty = true);
    this.unsubs.push(
      s.doc.subscribe((next, prev) => {
        if (next.project.lyrics !== prev.project.lyrics || next.project.transport !== prev.project.transport) redraw();
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
    const view = this.view();
    return gridTicks(this.s.editor.getState().playlist.snap, this.project().transport.timeSig, view?.pxPerTick ?? 0.025);
  }

  private tickAt(x: number): Tick {
    const view = this.view();
    return view ? view.scrollTick + x / view.pxPerTick : 0;
  }

  private localX(e: PointerEvent | MouseEvent): number {
    return e.clientX - this.els.canvas.getBoundingClientRect().left;
  }

  private wordOf(id: LyricId | null): LyricWord | undefined {
    return id ? this.project().lyrics?.[id] : undefined;
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
    this.draw(fitCanvas(canvas, width, LYRICS_LANE_HEIGHT), view, width, readTheme());
  }

  private draw(ctx: CanvasRenderingContext2D, view: LaneView, width: number, theme: TimelineTheme): void {
    const p = this.project();
    ctx.fillStyle = theme.surface2;
    ctx.fillRect(0, 0, width, LYRICS_LANE_HEIGHT);
    this.drawBarLines(ctx, view, width, theme, ticksPerBar(p.transport.timeSig));
    this.boxes = [];
    const words = lyricsSorted(p);
    if (words.length === 0 && !this.drag) this.drawEmptyHint(ctx, theme);
    for (const word of words) {
      const span = this.drag?.kind === 'word' && this.drag.id === word.id ? this.drag.preview : word;
      const left = (span.tick - view.scrollTick) * view.pxPerTick;
      const right = (span.tick + span.length - view.scrollTick) * view.pxPerTick;
      if (right < 0 || left > width) continue;
      this.boxes.push({ id: word.id, left, right });
      this.drawWord(ctx, theme, word, left, right);
    }
    if (this.drag?.kind === 'create' && this.drag.moved) this.drawNewSpan(ctx, theme, view, this.drag);
    ctx.fillStyle = theme.lineFaint;
    ctx.fillRect(0, LYRICS_LANE_HEIGHT - 1, width, 1);
  }

  private drawBarLines(ctx: CanvasRenderingContext2D, view: LaneView, width: number, theme: TimelineTheme, bar: Tick): void {
    ctx.fillStyle = alpha(theme.bar, 0.6);
    const first = Math.floor(view.scrollTick / bar);
    for (let b = first; ; b++) {
      const x = Math.round((b * bar - view.scrollTick) * view.pxPerTick);
      if (x > width) break;
      if (x >= 0) ctx.fillRect(x, 0, 1, LYRICS_LANE_HEIGHT);
    }
  }

  private drawEmptyHint(ctx: CanvasRenderingContext2D, theme: TimelineTheme): void {
    ctx.fillStyle = theme.textFaint;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('No lyrics yet: click here and type a word, or open Lyrics to paste a whole song’s words and spread them over the notes', 10, LYRICS_LANE_HEIGHT / 2);
  }

  private drawWord(ctx: CanvasRenderingContext2D, theme: TimelineTheme, word: LyricWord, left: number, right: number): void {
    const isSelected = word.id === this.selected;
    const x = left + 1;
    const w = Math.max(2, right - left - 2);
    ctx.beginPath();
    roundRectPath(ctx, x, 3, w, LYRICS_LANE_HEIGHT - 7, 4);
    ctx.fillStyle = alpha(theme.accent, isSelected ? 0.5 : word.id === this.hot ? 0.34 : 0.18);
    ctx.fill();
    ctx.strokeStyle = isSelected ? theme.accentLight : alpha(theme.accent, 0.55);
    ctx.stroke();
    if (w < MIN_LABEL_PX) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, 0, w, LYRICS_LANE_HEIGHT);
    ctx.clip();
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = theme.text;
    ctx.fillText(wordLabel(word), x + 5, LYRICS_LANE_HEIGHT / 2);
    ctx.restore();
  }

  private drawNewSpan(ctx: CanvasRenderingContext2D, theme: TimelineTheme, view: LaneView, drag: Extract<Drag, { kind: 'create' }>): void {
    const span = createdSpan(drag.startTick, drag.endTick, this.grid(false), this.defaultLength(), []);
    const left = (span.tick - view.scrollTick) * view.pxPerTick;
    ctx.fillStyle = alpha(theme.accent, 0.2);
    ctx.fillRect(left, 3, span.length * view.pxPerTick, LYRICS_LANE_HEIGHT - 7);
  }

  /** A word made by a plain click is a beat long. */
  private defaultLength(): Tick {
    return ticksPerBeat(this.project().transport.timeSig);
  }

  // ---------------------------------------------------------------- pointer

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.els.canvas.focus();
    this.closeInput();
    const x = this.localX(e);
    const hit = hitWord(this.boxes, x);
    this.els.canvas.setPointerCapture(e.pointerId);
    if (hit) {
      const word = this.wordOf(hit.id);
      if (!word) return;
      this.select(hit.id);
      const original = { tick: word.tick, length: word.length };
      this.drag = { kind: 'word', id: hit.id, zone: hit.zone, x0: x, original, preview: original, moved: false };
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
      this.setHot(hitWord(this.boxes, x)?.id ?? null);
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
      const span = createdSpan(drag.startTick, drag.endTick, grid, this.defaultLength(), spansOf(lyricsSorted(this.project())));
      this.openInput(span, null);
      return;
    }
    if (!drag.moved) return;
    const { id, preview, original } = drag;
    if (preview.tick === original.tick && preview.length === original.length) return;
    if (drag.zone === 'body') moveLyrics(this.s, [id], preview.tick - original.tick);
    else resizeLyric(this.s, id, preview.tick, preview.length);
  }

  private cancelDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    this.dirty = true;
  }

  private onDouble(e: MouseEvent): void {
    const word = this.wordOf(hitWord(this.boxes, this.localX(e))?.id ?? null);
    if (word) this.openInput({ tick: word.tick, length: word.length }, word.id);
  }

  private onContext(e: MouseEvent): void {
    e.preventDefault();
    const hit = hitWord(this.boxes, this.localX(e));
    if (hit) this.select(hit.id);
    this.onMenu?.(hit?.id ?? null, this.tickAt(this.localX(e)), e);
  }

  private onKey(e: KeyboardEvent): void {
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
      e.preventDefault();
      deleteLyrics(this.s, [this.selected]);
      this.selected = null;
    } else if (e.key === 'Escape') this.cancelDrag();
    else if (e.key === 'Enter' && this.selected) {
      const word = this.wordOf(this.selected);
      if (word) this.openInput({ tick: word.tick, length: word.length }, word.id);
    }
  }

  // ---------------------------------------------------------------- typing

  /** Shows the text box over a span: typing a word and pressing Enter makes (or retypes) it. */
  openInput(span: SpanTicks, id: LyricId | null): void {
    const view = this.view();
    if (!view) return;
    const input = this.els.input;
    const word = this.wordOf(id);
    this.typing = { span, id };
    const left = Math.max(0, (span.tick - view.scrollTick) * view.pxPerTick);
    input.style.display = 'block';
    input.style.left = `${Math.min(left, Math.max(0, this.els.canvas.clientWidth - 110))}px`;
    input.style.width = `${Math.max(80, Math.min(180, span.length * view.pxPerTick - 2))}px`;
    input.value = word ? wordLabel(word) : '';
    input.focus();
    input.select();
    emitHint(this.els.canvas, 'Type a word or syllable (beau-ti-ful makes three) · Enter adds it · Tab adds it and moves to the next beat · Esc cancels');
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
    if (!text) {
      this.closeInput();
      return;
    }
    const ids = typing.id ? (retypeLyric(this.s, typing.id, text) ? [typing.id] : []) : addLyricAt(this.s, typing.span.tick, typing.span.length, text);
    if (ids.length === 0) {
      emitHint(this.els.canvas, `“${text}” has no words in it: type a word or a syllable, for example beau-ti-ful`);
      return;
    }
    if (!typing.id) this.select(ids[0] ?? null);
    this.closeInput();
    const next = typing.span.tick + typing.span.length;
    if (e.key === 'Tab') this.openInput({ tick: next, length: typing.span.length }, null);
    else this.els.canvas.focus();
  }

  // ---------------------------------------------------------------- small things

  private select(id: LyricId | null): void {
    if (this.selected === id) return;
    this.selected = id;
    this.dirty = true;
  }

  private setHot(id: LyricId | null): void {
    if (this.hot === id) return;
    this.hot = id;
    this.dirty = true;
    this.hintFor(id);
  }

  private hintFor(id: LyricId | null): void {
    const word = this.wordOf(id);
    const text = word ? `“${wordLabel(word)}”: drag to move, drag an edge to resize, double-click to retype, right-click for more` : null;
    if (text !== this.lastHint) {
      this.lastHint = text;
      if (text) emitHint(this.els.canvas, text);
    }
  }

  private updateCursor(x: number): void {
    const hit = hitWord(this.boxes, x);
    this.els.canvas.style.cursor = !hit ? 'text' : hit.zone === 'body' ? 'grab' : 'ew-resize';
  }
}
