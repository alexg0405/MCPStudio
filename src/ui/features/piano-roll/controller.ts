/**
 * Imperative piano roll: owns the canvases, the viewport and pointer/wheel interaction. React only
 * renders the shell; data changes mark layers dirty and the shared frame loop redraws them.
 *
 * Geometry edits (move/resize/create) preview while dragging and commit one undo step on release.
 * Continuous edits (paint, erase, mute, event lane) are live history gestures.
 *
 * Right-click erases notes (FL) with every tool but Select; with the Select tool, with Ctrl/Cmd
 * held, or on an empty spot without dragging, it opens the context menu instead (`onMenu`).
 */
import type { Services } from '@app/services';
import type { Gesture } from '@core/history/history';
import { newId } from '@core/model/ids';
import type { ChannelId, Note, NoteId, Pattern, PatternId, Project, SongKey, Tick } from '@core/model/types';
import { addNotes, editNotes, removeNotes, sliceNote } from '@core/ops/notes';
import { noteAt, notesInRect } from '@core/query/notes-hit';
import { notesSorted, patternLength } from '@core/query/queries';
import { patternTickAt } from '@core/query/playlist';
import { ticksPerBar } from '@core/time/ppq';
import { gridTicks, snapFloor, snapRound } from '@core/time/snap';
import { noteName, scaleMask } from '@agstudio/sdk/notes';
import { onFrame } from '../../frame-loop';
import { isContextMenuOpen } from '../../controls/ContextMenu';
import { type FollowFrame, PlayheadFollow } from '../../timeline/follow';
import { alpha, roundRectPath, fitCanvas, onThemeChange, readTheme } from '../../timeline/canvas';
import { PannedLayer } from '../../timeline/panned';
import { clamp, Viewport } from '../../timeline/viewport';
import { formatLaneAmount, formatLaneValue, laneEdit, LANES, valueAtY } from './lanes';
import {
  drawGhosts,
  drawGrid,
  drawKeys,
  drawLane,
  drawNotes,
  drawRuler,
  keyForRow,
  rowForKey,
  type ScaleRows,
} from './render';
import { drawKey, movedKeys, stampKeys, stampName } from './stamp';

export interface PianoRollElements {
  area: HTMLElement;
  gridHost: HTMLElement;
  ruler: HTMLCanvasElement;
  keys: HTMLCanvasElement;
  grid: HTMLCanvasElement;
  notes: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  velocity: HTMLCanvasElement;
  velocityHost: HTMLElement;
  /** Shows the value being drawn in the event lane (the controller owns its text). */
  laneValue: HTMLElement;
  playhead: HTMLElement;
  hscroll: HTMLElement;
  hthumb: HTMLElement;
}

/** What a right-click asks the piano roll window to show a menu for. */
export type PianoRollMenuRequest =
  | { kind: 'note'; channelId: ChannelId; patternId: PatternId; noteIds: readonly NoteId[]; tick: Tick; key: number }
  | { kind: 'empty'; channelId: ChannelId; patternId: PatternId; tick: Tick; key: number };

export const KEYS_WIDTH = 64;
export const RULER_HEIGHT = 20;

/** Redraw timings for performance checks (`window.__ag.perf` in dev). */
export const pianoRollPerf = { lastDrawMs: 0, maxDrawMs: 0, draws: 0, notesDrawn: 0 };

type Layer = 'grid' | 'notes' | 'overlay' | 'keys' | 'ruler' | 'lane';
type Hit = { note: Note; zone: 'body' | 'end' };

type Drag =
  | {
      kind: 'move';
      x0: number;
      y0: number;
      anchor: Note;
      originals: Note[];
      duplicate: boolean;
      dTick: number;
      /** New key of each original. */
      keys: number[];
    }
  | { kind: 'resize'; x0: number; anchor: Note; originals: Note[]; dTick: number }
  | { kind: 'create'; notes: Note[]; grabOffset: number }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; base: NoteId[] }
  | { kind: 'paint'; gesture: Gesture; done: Set<string>; lastTick: number; key: number }
  | { kind: 'erase'; gesture: Gesture; done: Set<NoteId>; clientX: number; clientY: number; moved: boolean }
  | { kind: 'mute'; gesture: Gesture; done: Set<NoteId>; muted: boolean }
  | { kind: 'pan'; x: number; y: number }
  | { kind: 'lane'; gesture: Gesture; lastX: number; reset: boolean }
  | { kind: 'keys'; key: number };

interface Ctx {
  project: Project;
  channelId: ChannelId | null;
  patternId: PatternId | null;
  pattern: Pattern | undefined;
  rootKey: number | null;
  notes: readonly Note[];
  songKey: SongKey | null;
}

export class PianoRollController {
  readonly vp = new Viewport(128, 0.004, 2);
  /** Set by the window: shows the context menu for a right-click. */
  onMenu: ((request: PianoRollMenuRequest, at: { clientX: number; clientY: number }) => void) | null = null;
  private dirty = new Set<Layer>(['grid', 'notes', 'overlay', 'keys', 'ruler', 'lane']);
  private drag: Drag | null = null;
  private hover: Hit | null = null;
  private preview: Map<NoteId, Note> | null = null;
  private previewAdds: Note[] = [];
  private pressedKeys = new Map<number, number>();
  private audition: { key: number; noteId: number; channelId: ChannelId } | null = null;
  private unsubs: Array<() => void> = [];
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPlayheadX = NaN;
  /** The scrollbar track's width and the event lane's height, measured when the layout changes. */
  private scrollTrackW = 0;
  private laneH = 1;
  /** The channel and pattern the view was last centered (or restored) for. */
  private centeredFor: { channelId: Ctx['channelId']; patternId: Ctx['patternId'] } | null = null;
  private scaleCache: { key: SongKey | null; rows: ScaleRows | null } = { key: null, rows: null };
  /** Where the chord stamp would draw, shown as an outline under the pointer. */
  private stampHover: { tick: Tick; length: Tick; keys: number[]; name: string } | null = null;
  private lastHint = '';
  /** Follow playhead: scrolls the view along while playing; its scroll is saved once playback stops. */
  private readonly follow = new PlayheadFollow();
  /** The follow inputs of the frame, filled in place each frame (no object per frame). */
  private readonly followFrame: FollowFrame = {
    now: 0,
    enabled: false,
    playing: false,
    playhead: NaN,
    scrollTick: 0,
    visible: 0,
    maxScroll: 0,
    wrapEnd: 0,
    busy: false,
  };
  private followMoved = false;
  /**
   * Grid, notes, ruler and the event lane are drawn once into a picture wider than the view and slid while the view
   * scrolls (timeline/panned.ts), so smooth follow costs a transform per frame instead of a redraw.
   */
  private readonly gridLayer: PannedLayer;
  private readonly notesLayer: PannedLayer;
  private readonly rulerLayer: PannedLayer;
  private readonly laneLayer: PannedLayer;
  /** The scroll the scrollbar thumb was last placed for. */
  private lastBarScroll = NaN;
  /** `maxTick` for the notes array it was computed from (it runs every frame while the view follows). */
  private maxTickMemo: { notes: readonly Note[] | null; end: Tick; bar: Tick; result: Tick } = {
    notes: null,
    end: -1,
    bar: -1,
    result: 0,
  };

  constructor(
    private readonly s: Services,
    private readonly els: PianoRollElements,
  ) {
    const pr = s.editor.getState().pianoRoll;
    this.vp.pxPerTick = pr.pxPerTick;
    this.vp.rowHeight = pr.rowHeight;
    this.vp.scrollTick = pr.scrollTick;
    this.vp.scrollRow = pr.scrollRow ?? rowForKey(72);
    this.gridLayer = new PannedLayer(els.grid);
    this.notesLayer = new PannedLayer(els.notes);
    this.rulerLayer = new PannedLayer(els.ruler, 'blit');
    this.laneLayer = new PannedLayer(els.velocity);
    // Keep a restored scroll position; center on the notes only when it's unknown or the channel changes.
    if (pr.scrollRow !== null) {
      const c = this.ctx();
      this.centeredFor = { channelId: c.channelId, patternId: c.patternId };
    }
  }

  // ---------------------------------------------------------------- lifecycle

  mount(): void {
    const { s, els } = this;
    const all = () => this.invalidate('grid', 'notes', 'overlay', 'keys', 'ruler', 'lane');
    this.unsubs.push(
      s.doc.subscribe((next, prev) => {
        if (next.project.patterns !== prev.project.patterns || next.project.channels !== prev.project.channels) all();
        if (next.project.transport !== prev.project.transport) all();
      }),
      s.editor.subscribe((next, prev) => {
        if (next.noteSelection !== prev.noteSelection) this.invalidate('notes', 'lane');
        if (next.pianoRoll.snap !== prev.pianoRoll.snap || next.pianoRoll.ghosts !== prev.pianoRoll.ghosts) all();
        if (next.pianoRoll.velocityLane !== prev.pianoRoll.velocityLane || next.pianoRoll.lane !== prev.pianoRoll.lane)
          all();
        if (next.pianoRoll.scaleHighlight !== prev.pianoRoll.scaleHighlight) this.invalidate('grid', 'keys');
        if (next.pianoRoll.tool !== prev.pianoRoll.tool || next.pianoRoll.chord !== prev.pianoRoll.chord) {
          this.stampHover = null;
          this.invalidate('overlay');
          this.updateCursor();
        }
      }),
      s.session.subscribe((next, prev) => {
        if (next.selectedChannelId !== prev.selectedChannelId) {
          this.hover = null;
          all();
        }
      }),
      s.view.subscribe((next, prev) => {
        if (next.currentPatternId !== prev.currentPatternId) all();
      }),
      onThemeChange(all),
      onFrame(() => this.frame()),
    );

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(els.gridHost);
    ro.observe(els.velocityHost);
    ro.observe(els.hscroll);
    this.unsubs.push(() => ro.disconnect());

    const host = els.gridHost;
    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.unsubs.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    on(host, 'pointerdown', (e) => this.onPointerDown(e));
    on(host, 'pointermove', (e) => this.onPointerMove(e));
    on(host, 'pointerup', (e) => this.onPointerUp(e));
    on(host, 'pointercancel', () => this.cancelDrag());
    on(host, 'pointerleave', () => {
      if (!this.drag && (this.hover || this.stampHover)) {
        this.hover = null;
        this.stampHover = null;
        this.invalidate('overlay');
      }
    });
    on(host, 'contextmenu', (e) => e.preventDefault());
    // Native, non-passive wheel listeners so preventDefault works (React's onWheel is passive).
    for (const el of [host, els.keys, els.ruler, els.velocityHost])
      on(el, 'wheel', (e) => this.onWheel(e), { passive: false });

    on(els.keys, 'pointerdown', (e) => this.onKeysDown(e));
    on(els.keys, 'pointermove', (e) => this.onKeysMove(e));
    on(els.keys, 'pointerup', (e) => this.onKeysUp(e));
    on(els.keys, 'pointercancel', (e) => this.onKeysUp(e));

    on(els.velocityHost, 'pointerdown', (e) => this.onLaneDown(e));
    on(els.velocityHost, 'pointermove', (e) => this.onLaneMove(e));
    on(els.velocityHost, 'pointerup', (e) => this.onLaneUp(e));
    on(els.velocityHost, 'pointercancel', () => this.cancelDrag());
    on(els.velocityHost, 'contextmenu', (e) => e.preventDefault());

    on(els.hthumb, 'pointerdown', (e) => this.onThumbDown(e));

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.drag) {
        e.preventDefault();
        e.stopPropagation();
        this.cancelDrag();
      }
    };
    window.addEventListener('keydown', onKey, true);
    this.unsubs.push(() => window.removeEventListener('keydown', onKey, true));
    this.resize();
  }

  unmount(): void {
    this.cancelDrag();
    this.stopAudition();
    for (const fn of this.unsubs.splice(0)) fn();
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistViewport();
  }

  // ---------------------------------------------------------------- data

  private ctx(): Ctx {
    const project = this.s.doc.getState().project;
    const channelId = this.s.session.getState().selectedChannelId;
    const patternId = this.s.view.getState().currentPatternId;
    const pattern = patternId ? project.patterns[patternId] : undefined;
    const ch = channelId ? project.channels[channelId] : undefined;
    const instrument = ch?.kind === 'instrument' ? ch : null;
    return {
      project,
      channelId: instrument ? channelId : null,
      patternId: pattern ? patternId : null,
      pattern,
      rootKey: instrument?.rootKey ?? null,
      notes: instrument && pattern ? notesSorted(pattern.notes[instrument.id]) : [],
      songKey: project.transport.key ?? null,
    };
  }

  private grid(c: Ctx): Tick {
    const pr = this.s.editor.getState().pianoRoll;
    return gridTicks(pr.snap, c.project.transport.timeSig, this.vp.pxPerTick);
  }

  private snapFor(e: { altKey: boolean }, c: Ctx): Tick {
    // Alt bypasses snapping, like FL.
    return e.altKey ? 1 : this.grid(c);
  }

  private patternEnd(c: Ctx): Tick {
    return c.pattern ? patternLength(c.pattern, c.project.transport.timeSig) : ticksPerBar(c.project.transport.timeSig);
  }

  private maxTick(c: Ctx): Tick {
    const bar = ticksPerBar(c.project.transport.timeSig);
    const patternEnd = this.patternEnd(c);
    const memo = this.maxTickMemo;
    if (memo.notes === c.notes && memo.end === patternEnd && memo.bar === bar) return memo.result;
    let end = patternEnd;
    // Indexed: a for-of iterator per note is garbage, and this walks every note.
    for (let i = 0; i < c.notes.length; i++) {
      const n = c.notes[i] as Note;
      end = Math.max(end, n.tick + n.length);
    }
    memo.notes = c.notes;
    memo.end = patternEnd;
    memo.bar = bar;
    memo.result = end + bar * 8;
    return memo.result;
  }

  private selection(): ReadonlySet<NoteId> {
    return new Set(this.s.editor.getState().noteSelection);
  }

  /** The song key's rows for drawing (cached per key object); null when highlighting is off. */
  private scaleRows(c: Ctx): ScaleRows | null {
    if (!this.s.editor.getState().pianoRoll.scaleHighlight) return null;
    if (this.scaleCache.key !== c.songKey) {
      const k = c.songKey;
      this.scaleCache = { key: k, rows: k ? { mask: scaleMask(k.root, k.scale), root: k.root } : null };
    }
    return this.scaleCache.rows;
  }

  // ---------------------------------------------------------------- layout & drawing

  invalidate(...layers: Layer[]): void {
    for (const l of layers) this.dirty.add(l);
  }

  private resize(): void {
    const r = this.els.gridHost.getBoundingClientRect();
    this.vp.width = Math.max(1, Math.round(r.width));
    this.vp.height = Math.max(1, Math.round(r.height));
    // Read here, when the size changes, so the frame loop never asks the layout for them.
    this.scrollTrackW = this.els.hscroll.getBoundingClientRect().width;
    this.laneH = Math.max(1, Math.round(this.els.velocityHost.getBoundingClientRect().height));
    const c = this.ctx();
    this.vp.clampScroll(this.maxTick(c));
    this.invalidate('grid', 'notes', 'overlay', 'keys', 'ruler', 'lane');
  }

  private frame(): void {
    const t0 = performance.now();
    const c = this.ctx();
    // Center the view on the channel's notes the first time we show it (compared field by field: no key string per frame).
    const centered = this.centeredFor;
    if ((!centered || centered.channelId !== c.channelId || centered.patternId !== c.patternId) && this.vp.height > 1) {
      this.centeredFor = { channelId: c.channelId, patternId: c.patternId };
      this.centerOnNotes(c);
    }
    this.followPlayhead(c);
    // Drawing and the playhead snap to whole device pixels (viewport.ts).
    this.vp.snapForFrame(window.devicePixelRatio || 1);
    const theme = readTheme();
    const { els, vp, dirty } = this;
    const pr = this.s.editor.getState().pianoRoll;
    const now = t0;
    // The panned layers decide for themselves whether the picture must be drawn again (dirty, zoom, size, scrolled
    // out of the drawn part); a plain scroll only slides it.
    let drew = this.gridLayer.paint(vp, vp.height, dirty.has('grid'), this.drawGridLayer, now);
    if (this.notesLayer.paint(vp, vp.height, dirty.has('notes'), this.drawNotesLayer, now)) drew = true;
    if (this.rulerLayer.paint(vp, RULER_HEIGHT, dirty.has('ruler'), this.drawRulerLayer, now)) drew = true;
    if (pr.velocityLane && this.laneLayer.paint(vp, this.laneH, dirty.has('lane'), this.drawLaneLayer, now)) drew = true;
    if (dirty.has('overlay')) this.drawOverlay();
    if (dirty.has('keys')) {
      drawKeys(
        fitCanvas(els.keys, KEYS_WIDTH, vp.height),
        vp,
        theme,
        KEYS_WIDTH,
        new Set(this.pressedKeys.keys()),
        c.rootKey,
        this.scaleRows(c),
      );
    }
    if (dirty.size > 0 || vp.scrollTick !== this.lastBarScroll) {
      this.lastBarScroll = vp.scrollTick;
      this.updateScrollbar(c);
    }
    if (drew || dirty.size > 0) {
      const ms = performance.now() - t0;
      pianoRollPerf.lastDrawMs = ms;
      pianoRollPerf.maxDrawMs = Math.max(pianoRollPerf.maxDrawMs, ms);
      pianoRollPerf.draws++;
      pianoRollPerf.notesDrawn = c.notes.length;
    }
    dirty.clear();
    this.updatePlayhead(c);
  }

  // The layer drawing functions, bound once: `PannedLayer.paint` takes one every frame (an inline arrow would be
  // a closure per frame). They read the state they draw when they run, which is only when the layer is stale.
  private readonly drawGridLayer = (g: CanvasRenderingContext2D, wide: Viewport): void => {
    const c = this.ctx();
    drawGrid(g, wide, readTheme(), c.project.transport.timeSig, this.patternEnd(c), this.scaleRows(c));
  };

  private readonly drawNotesLayer = (ctx: CanvasRenderingContext2D, wide: Viewport): void => {
    const c = this.ctx();
    const theme = readTheme();
    const pr = this.s.editor.getState().pianoRoll;
    ctx.clearRect(0, 0, wide.width, wide.height);
    if (pr.ghosts && c.pattern) {
      // for-in, not Object.entries: no array of pairs.
      for (const cid in c.pattern.notes) {
        const notes = c.pattern.notes[cid as ChannelId];
        if (cid !== c.channelId && notes) drawGhosts(ctx, wide, theme, notesSorted(notes));
      }
    }
    const selected = this.selection();
    const style = { color: theme.note, selected };
    if (this.preview) {
      const moving = this.drag?.kind === 'move' && !this.drag.duplicate;
      drawNotes(ctx, wide, theme, c.notes, style, {
        skip: moving || this.drag?.kind === 'resize' ? new Set(this.preview.keys()) : new Set(),
      });
      const shown = [...this.preview.values()].sort((a, b) => a.tick - b.tick);
      drawNotes(ctx, wide, theme, shown, { color: theme.note, selected: new Set(shown.map((n) => n.id)) });
    } else {
      drawNotes(ctx, wide, theme, c.notes, style);
    }
    if (this.previewAdds.length > 0) {
      drawNotes(ctx, wide, theme, this.previewAdds, {
        color: theme.note,
        selected: new Set(this.previewAdds.map((n) => n.id)),
      });
    }
  };

  private readonly drawRulerLayer = (ctx: CanvasRenderingContext2D, wide: Viewport): void => {
    const c = this.ctx();
    drawRuler(ctx, wide, readTheme(), c.project.transport.timeSig, RULER_HEIGHT, this.patternEnd(c));
  };

  private readonly drawLaneLayer = (ctx: CanvasRenderingContext2D, wide: Viewport): void => {
    const c = this.ctx();
    const theme = readTheme();
    const pr = this.s.editor.getState().pianoRoll;
    const style = { color: theme.note, selected: this.selection() };
    drawLane(ctx, wide, theme, wide.height, c.notes, style, this.preview, pr.lane);
  };

  private drawOverlay(): void {
    const { vp, els } = this;
    const ctx = fitCanvas(els.overlay, vp.width, vp.height);
    ctx.clearRect(0, 0, vp.width, vp.height);
    const theme = readTheme();
    const d = this.drag;
    if (d?.kind === 'marquee') {
      const x = vp.snap(Math.min(d.x0, d.x1));
      const y = vp.snap(Math.min(d.y0, d.y1));
      const x1 = vp.snap(Math.max(d.x0, d.x1));
      const y1 = vp.snap(Math.max(d.y0, d.y1));
      ctx.fillStyle = theme.selectTint;
      ctx.strokeStyle = theme.select;
      ctx.fillRect(x, y, x1 - x, y1 - y);
      ctx.strokeRect(x + 0.5, y + 0.5, x1 - x, y1 - y);
    } else if (this.hover && !d) {
      const n = this.hover.note;
      const x = vp.tickToPx(n.tick);
      const y = vp.rowToY(rowForKey(n.key));
      // The note under the pointer lifts: a brighter rounded edge.
      ctx.strokeStyle = alpha(theme.text, 0.75);
      ctx.beginPath();
      roundRectPath(ctx, x + 0.5, y + 1.5, Math.max(2, n.length * vp.pxPerTick - 2), vp.rowHeight - 3, 3);
      ctx.stroke();
      if (this.s.editor.getState().pianoRoll.tool === 'slice') {
        ctx.fillStyle = theme.danger;
        ctx.fillRect(vp.snap(this.sliceX), y, 1, vp.rowHeight);
      }
    } else if (this.stampHover && !d) {
      // The chord the draw tool would stamp here: dashed outlines and its name.
      const { tick, length, keys, name } = this.stampHover;
      const x = vp.tickToPx(tick);
      const w = Math.max(6, vp.tickToPx(tick + length) - x - 1);
      ctx.setLineDash([3, 2]);
      ctx.strokeStyle = alpha(theme.accent, 0.85);
      ctx.fillStyle = alpha(theme.accent, 0.12);
      let top = Infinity;
      for (const k of keys) {
        const y = vp.rowToY(rowForKey(k));
        top = Math.min(top, y);
        ctx.beginPath();
        roundRectPath(ctx, x + 0.5, y + 1.5, w, vp.rowHeight - 3, 3);
        ctx.fill();
        ctx.stroke();
      }
      ctx.setLineDash([]);
      if (name && Number.isFinite(top)) {
        ctx.font = `600 11px ${theme.font}`;
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(name).width + 14;
        ctx.fillStyle = theme.glass;
        ctx.beginPath();
        roundRectPath(ctx, x, top - 19, tw, 16, 8);
        ctx.fill();
        ctx.strokeStyle = theme.accentDim;
        ctx.stroke();
        ctx.fillStyle = theme.accent;
        ctx.fillText(name, x + 7, top - 10.5);
      }
    }
  }

  /** The hint bar text, set only when it changes (pointer moves are frequent). */
  private hint(text: string): void {
    if (text === this.lastHint) return;
    this.lastHint = text;
    this.s.session.getState().setHint(text);
  }

  /** Updates the chord-stamp outline under the pointer (draw and paint tools with a chord chosen). */
  private updateStampHover(x: number, y: number, c: Ctx, e: { altKey: boolean }): void {
    const pr = this.s.editor.getState().pianoRoll;
    if (!pr.chord || (pr.tool !== 'draw' && pr.tool !== 'paint') || !c.channelId || this.hover) {
      if (this.stampHover) {
        this.stampHover = null;
        this.invalidate('overlay');
      }
      return;
    }
    const grid = this.snapFor(e, c);
    const tick = Math.max(0, snapFloor(this.vp.xToTick(x), grid));
    const keys = stampKeys(this.drawKeyAtY(y, c), pr.chord, pr.inversion, c.songKey);
    const prev = this.stampHover;
    if (prev && prev.tick === tick && prev.keys.length === keys.length && prev.keys.every((k, i) => k === keys[i]))
      return;
    const name = stampName(keys);
    const length = pr.tool === 'paint' ? Math.max(grid, Math.min(pr.lastLength, grid * 4)) : pr.lastLength;
    this.stampHover = { tick, length, keys, name };
    this.hint(`Click to draw ${name || 'the chord'}: ${keys.map(noteName).join(' ')}`);
    this.invalidate('overlay');
  }

  private sliceX = 0;

  /** The playhead in this pattern's ticks; NaN when stopped or (song mode) no clip of it is playing. */
  private playheadTick(c: Ctx): number {
    const { engine, view } = this.s;
    if (!engine.playing || !c.pattern || !c.patternId) return NaN;
    if (view.getState().mode === 'pattern') return engine.playhead() % this.patternEnd(c);
    // Song mode: follow the clip of this pattern that's playing, if any.
    return patternTickAt(c.project, engine.playhead(), c.patternId) ?? NaN;
  }

  /**
   * Follow playhead (FL's auto-scroll), for the current pattern in pattern mode and for its clip that
   * plays in song mode: near the right edge the view glides a page on. It holds still while the user
   * drags, selects or has a menu open, and after a hand scroll until the playhead is back in view.
   */
  private followPlayhead(c: Ctx): void {
    const playing = this.s.engine.playing;
    const enabled = this.s.prefs.getState().followPlayhead;
    const playhead = playing && enabled ? this.playheadTick(c) : NaN;
    const visible = this.vp.width / this.vp.pxPerTick;
    // The frame's inputs go into the one object this controller keeps (see followFrame).
    const f = this.followFrame;
    f.now = performance.now();
    f.enabled = enabled;
    f.playing = playing;
    f.playhead = playhead;
    f.scrollTick = this.vp.scrollTick;
    f.visible = visible;
    f.maxScroll = Number.isFinite(playhead) ? Math.max(0, this.maxTick(c) - visible) : 0;
    // The pattern loops at its end (in song mode its clip repeats it).
    f.wrapEnd = this.patternEnd(c);
    f.style = this.s.prefs.getState().followStyle;
    f.busy = this.drag !== null || isContextMenuOpen();
    const next = this.follow.step(f);
    if (next === null) {
      if (!playing && this.followMoved) {
        this.followMoved = false;
        this.persistViewport();
      }
      return;
    }
    this.vp.scrollTick = next;
    this.followMoved = true;
    // The grid, notes, ruler and lane slide (see frame); only what is drawn at the pointer follows by redrawing.
    if (this.hover || this.stampHover || this.drag) this.invalidate('overlay');
  }

  private updatePlayhead(c: Ctx): void {
    const t = this.playheadTick(c);
    const x = Number.isFinite(t) ? this.vp.tickToX(t) : NaN;
    // The line sits on a whole device pixel, like the grid it is drawn over.
    const at = Number.isFinite(x) ? this.vp.snap(x) : NaN;
    if (at === this.lastPlayheadX) return;
    this.lastPlayheadX = at;
    const el = this.els.playhead;
    if (!Number.isFinite(at) || at < 0 || at > this.vp.width) el.style.display = 'none';
    else {
      el.style.display = 'block';
      el.style.transform = `translateX(${KEYS_WIDTH + at}px)`;
    }
  }

  private updateScrollbar(c: Ctx): void {
    const total = this.maxTick(c);
    const visible = this.vp.width / this.vp.pxPerTick;
    const track = this.scrollTrackW;
    const w = Math.max(24, Math.min(track, (visible / total) * track));
    const x = total > visible ? (this.vp.scrollTick / (total - visible)) * (track - w) : 0;
    this.els.hthumb.style.width = `${w}px`;
    this.els.hthumb.style.transform = `translateX(${x}px)`;
  }

  private centerOnNotes(c: Ctx): void {
    const visibleRows = this.vp.height / this.vp.rowHeight;
    let center = 72;
    if (c.notes.length > 0) {
      let lo = 127;
      let hi = 0;
      for (const n of c.notes) {
        lo = Math.min(lo, n.key);
        hi = Math.max(hi, n.key);
      }
      center = (lo + hi) / 2;
    } else if (c.rootKey !== null) center = c.rootKey + 6;
    this.vp.scrollRow = clamp(rowForKey(center) - visibleRows / 2, 0, Math.max(0, 128 - visibleRows));
    // Bring the first note into view if it's off-screen (or start at bar 1).
    const first = c.notes[0];
    const [t0, t1] = this.vp.visibleTicks();
    if (!first || first.tick < t0 || first.tick > t1) {
      const bar = ticksPerBar(c.project.transport.timeSig);
      this.vp.scrollTick = first ? Math.max(0, Math.floor(first.tick / bar) * bar) : 0;
    }
    this.invalidate('grid', 'notes', 'overlay', 'keys', 'lane');
  }

  private persistViewport(): void {
    const { vp } = this;
    this.s.editor.getState().setPianoRoll({
      pxPerTick: vp.pxPerTick,
      rowHeight: vp.rowHeight,
      scrollTick: vp.scrollTick,
      scrollRow: vp.scrollRow,
    });
  }

  private viewportChanged(): void {
    // Grid, notes, ruler and lane notice a scroll or zoom themselves (PannedLayer); the keys follow vertical scroll.
    this.invalidate('overlay', 'keys');
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistViewport(), 300);
  }

  // ---------------------------------------------------------------- hit testing

  private local(e: { clientX: number; clientY: number }, el: HTMLElement = this.els.gridHost) {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private keyAtY(y: number): number {
    return clamp(keyForRow(Math.floor(this.vp.yToRow(y))), 0, 127);
  }

  /** The key a new note drawn at `y` gets (snapped to the scale when that's on). */
  private drawKeyAtY(y: number, c: Ctx): number {
    return drawKey(this.keyAtY(y), this.s.editor.getState().pianoRoll.scaleSnap, c.songKey);
  }

  /** The notes drawing a note at (tick, key) creates: the note, or a chord when a chord stamp is chosen. */
  private stamp(tick: Tick, key: number, length: Tick, c: Ctx): Note[] {
    const pr = this.s.editor.getState().pianoRoll;
    return stampKeys(key, pr.chord, pr.inversion, c.songKey).map((k) => ({
      id: newId.note(),
      tick,
      length,
      key: k,
      velocity: 100 / 128,
    }));
  }

  private hitTest(x: number, y: number, c: Ctx): Hit | null {
    const key = this.keyAtY(y);
    const tick = this.vp.xToTick(x);
    const n = noteAt(c.notes, tick, key);
    if (!n) return null;
    const left = this.vp.tickToX(n.tick);
    const right = this.vp.tickToX(n.tick + n.length);
    const edge = Math.min(8, Math.max(3, (right - left) / 3));
    return { note: n, zone: right - x <= edge ? 'end' : 'body' };
  }

  private updateCursor(): void {
    const tool = this.s.editor.getState().pianoRoll.tool;
    const h = this.hover;
    let cursor = 'default';
    if (this.drag?.kind === 'pan') cursor = 'grabbing';
    else if (tool === 'delete') cursor = 'not-allowed';
    else if (tool === 'mute') cursor = h ? 'pointer' : 'default';
    else if (tool === 'slice') cursor = h ? 'col-resize' : 'default';
    else if (h?.zone === 'end') cursor = 'ew-resize';
    else if (h) cursor = tool === 'paint' ? 'copy' : 'move';
    else if (tool === 'draw' || tool === 'paint') cursor = 'crosshair';
    this.els.gridHost.style.cursor = cursor;
  }

  // ---------------------------------------------------------------- audition

  private auditionKey(key: number, velocity = 0.8): void {
    const c = this.ctx();
    if (!c.channelId) return;
    if (this.audition?.key === key) return;
    this.stopAudition();
    const noteId = this.s.engine.previewNoteOn(c.channelId, key, velocity);
    this.audition = { key, noteId, channelId: c.channelId };
  }

  private stopAudition(): void {
    if (!this.audition) return;
    this.s.engine.previewNoteOff(this.audition.channelId, this.audition.noteId);
    this.audition = null;
  }

  // ---------------------------------------------------------------- context menu

  private openMenu(e: { clientX: number; clientY: number }, c: Ctx, hit: Hit | null): void {
    const { channelId, patternId } = c;
    if (!this.onMenu || !channelId || !patternId) return;
    const { x, y } = this.local(e);
    const tick = Math.max(0, Math.floor(this.vp.xToTick(x)));
    const key = this.keyAtY(y);
    if (hit) {
      const editor = this.s.editor.getState();
      if (!editor.noteSelection.includes(hit.note.id)) editor.selectNotes([hit.note.id]);
      const noteIds = this.s.editor.getState().noteSelection;
      this.onMenu({ kind: 'note', channelId, patternId, noteIds, tick, key }, e);
    } else this.onMenu({ kind: 'empty', channelId, patternId, tick, key }, e);
  }

  // ---------------------------------------------------------------- grid pointer

  private onPointerDown(e: PointerEvent): void {
    const c = this.ctx();
    const host = this.els.gridHost;
    const { x, y } = this.local(e);
    if (e.button === 1) {
      e.preventDefault();
      host.setPointerCapture(e.pointerId);
      this.drag = { kind: 'pan', x: e.clientX, y: e.clientY };
      this.updateCursor();
      return;
    }
    if (!c.channelId || !c.patternId) return;
    e.preventDefault();
    this.s.view.getState().focusWindow('piano-roll');
    this.stampHover = null;
    const editor = this.s.editor.getState();
    const tool = editor.pianoRoll.tool;
    const hit = this.hitTest(x, y, c);
    const mod = e.metaKey || e.ctrlKey;

    if (e.button === 2 && (tool === 'select' || mod)) {
      this.openMenu(e, c, hit);
      return;
    }
    host.setPointerCapture(e.pointerId);
    if (e.button === 2 || tool === 'delete') {
      const gesture = this.s.history.gesture('Delete notes');
      this.drag = { kind: 'erase', gesture, done: new Set(), clientX: e.clientX, clientY: e.clientY, moved: false };
      this.eraseAt(x, y, c);
      return;
    }
    if (e.button !== 0) return;

    if (tool === 'slice') {
      if (hit) {
        const at = snapRound(this.vp.xToTick(x), this.snapFor(e, c));
        const { patternId, channelId } = c;
        this.s.history.transact('Slice note', (d) => sliceNote(d, patternId, channelId, hit.note.id, at));
      }
      return;
    }

    if (tool === 'mute') {
      const gesture = this.s.history.gesture(hit?.note.muted ? 'Unmute notes' : 'Mute notes');
      this.drag = { kind: 'mute', gesture, done: new Set(), muted: !hit?.note.muted };
      this.muteAt(x, y, c);
      return;
    }

    if (hit && tool !== 'paint') {
      const selected = editor.noteSelection;
      let sel = selected.includes(hit.note.id) ? selected : [hit.note.id];
      if (mod) {
        // Ctrl/Cmd-click toggles a note in the selection.
        sel = selected.includes(hit.note.id) ? selected.filter((id) => id !== hit.note.id) : [...selected, hit.note.id];
        editor.selectNotes(sel);
        return;
      }
      editor.selectNotes(sel);
      const byId = new Map(c.notes.map((n) => [n.id, n]));
      const originals = sel.map((id) => byId.get(id)).filter((n): n is Note => !!n);
      if (hit.zone === 'end') {
        this.drag = { kind: 'resize', x0: x, anchor: hit.note, originals, dTick: 0 };
      } else {
        this.drag = {
          kind: 'move',
          x0: x,
          y0: y,
          anchor: hit.note,
          originals,
          duplicate: e.shiftKey,
          dTick: 0,
          keys: originals.map((n) => n.key),
        };
        this.auditionKey(hit.note.key, hit.note.velocity);
      }
      this.preview = new Map(originals.map((n) => [n.id, n]));
      if (this.drag.kind === 'move' && this.drag.duplicate) {
        this.preview = new Map();
        this.previewAdds = originals.map((n) => ({ ...n }));
      }
      this.invalidate('notes', 'lane', 'overlay');
      return;
    }

    if (tool === 'select' || (tool === 'draw' && mod)) {
      this.drag = { kind: 'marquee', x0: x, y0: y, x1: x, y1: y, base: mod ? [...editor.noteSelection] : [] };
      if (!mod) editor.selectNotes([]);
      this.invalidate('overlay');
      return;
    }

    const grid = this.snapFor(e, c);
    const key = this.drawKeyAtY(y, c);
    if (tool === 'paint') {
      const gesture = this.s.history.gesture('Paint notes');
      this.drag = { kind: 'paint', gesture, done: new Set(), lastTick: snapFloor(this.vp.xToTick(x), grid), key };
      this.paintAt(x, y, c, e);
      this.auditionKey(key);
      return;
    }

    // Draw tool on empty space: create a note (or a chord) and keep dragging it into place.
    editor.selectNotes([]);
    const tick = Math.max(0, snapFloor(this.vp.xToTick(x), grid));
    const notes = this.stamp(tick, key, editor.pianoRoll.lastLength, c);
    this.drag = { kind: 'create', notes, grabOffset: this.vp.xToTick(x) - tick };
    this.previewAdds = notes;
    this.auditionKey(key);
    this.invalidate('notes', 'lane');
  }

  private onPointerMove(e: PointerEvent): void {
    // The button was let go where no pointerup reached us (outside the window, another window took
    // focus): this move is the drop, so the drag does not carry on without a button.
    if (this.drag && e.buttons === 0) {
      this.onPointerUp(e);
      return;
    }
    const c = this.ctx();
    const { x, y } = this.local(e);
    const d = this.drag;
    if (!d) {
      const hit = this.hitTest(x, y, c);
      if (
        hit?.note.id !== this.hover?.note.id ||
        hit?.zone !== this.hover?.zone ||
        this.s.editor.getState().pianoRoll.tool === 'slice'
      ) {
        this.hover = hit;
        this.sliceX = this.vp.tickToX(snapRound(this.vp.xToTick(x), this.snapFor(e, c)));
        this.invalidate('overlay');
        this.updateCursor();
      }
      this.updateStampHover(x, y, c, e);
      return;
    }
    this.autoScroll(x, y, c);
    switch (d.kind) {
      case 'pan': {
        this.vp.scrollBy(d.x - e.clientX, d.y - e.clientY, this.maxTick(c));
        d.x = e.clientX;
        d.y = e.clientY;
        this.follow.userScrolled();
        this.viewportChanged();
        return;
      }
      case 'move': {
        const grid = this.snapFor(e, c);
        const rawTick = d.anchor.tick + (x - d.x0) / this.vp.pxPerTick;
        let dTick = snapRound(rawTick, grid) - d.anchor.tick;
        const minTick = Math.min(...d.originals.map((n) => n.tick));
        if (minTick + dTick < 0) dTick = -minTick;
        const toKey = d.anchor.key + this.keyAtY(y) - this.keyAtY(d.y0);
        const scaleSnap = this.s.editor.getState().pianoRoll.scaleSnap;
        const keys = movedKeys(
          d.originals.map((n) => n.key),
          d.anchor.key,
          toKey,
          scaleSnap,
          c.songKey,
        );
        if (dTick === d.dTick && keys.every((k, i) => k === d.keys[i])) return;
        d.dTick = dTick;
        d.keys = keys;
        const moved = d.originals.map((n, i) => ({ ...n, tick: n.tick + dTick, key: keys[i] as number }));
        if (d.duplicate) this.previewAdds = moved;
        else this.preview = new Map(moved.map((n) => [n.id, n]));
        const anchorIndex = d.originals.findIndex((n) => n.id === d.anchor.id);
        this.auditionKey(keys[anchorIndex] ?? d.anchor.key, d.anchor.velocity);
        this.invalidate('notes', 'lane');
        return;
      }
      case 'resize': {
        const grid = this.snapFor(e, c);
        const end = d.anchor.tick + d.anchor.length + (x - d.x0) / this.vp.pxPerTick;
        let dTick = snapRound(end, grid) - (d.anchor.tick + d.anchor.length);
        const minLen = Math.min(...d.originals.map((n) => n.length));
        if (minLen + dTick < Math.max(1, grid)) dTick = Math.max(1, grid) - minLen;
        if (dTick === d.dTick) return;
        d.dTick = dTick;
        this.preview = new Map(d.originals.map((n) => [n.id, { ...n, length: n.length + dTick }]));
        this.invalidate('notes', 'lane');
        return;
      }
      case 'create': {
        const grid = this.snapFor(e, c);
        const tick = Math.max(0, snapFloor(this.vp.xToTick(x) - d.grabOffset + grid / 2, grid));
        const key = this.drawKeyAtY(y, c);
        const first = d.notes[0] as Note;
        if (tick === first.tick && key === first.key) return;
        d.notes = this.stamp(tick, key, first.length, c);
        this.previewAdds = d.notes;
        this.auditionKey(key);
        this.invalidate('notes', 'lane');
        return;
      }
      case 'marquee': {
        d.x1 = x;
        d.y1 = y;
        const t0 = this.vp.xToTick(Math.min(d.x0, d.x1));
        const t1 = this.vp.xToTick(Math.max(d.x0, d.x1));
        const ids = notesInRect(c.notes, t0, t1, this.keyAtY(d.y0), this.keyAtY(d.y1));
        this.s.editor.getState().selectNotes([...new Set([...d.base, ...ids])]);
        this.invalidate('overlay');
        return;
      }
      case 'paint':
        this.paintAt(x, y, c, e);
        return;
      case 'erase':
        if (Math.abs(e.clientX - d.clientX) > 3 || Math.abs(e.clientY - d.clientY) > 3) d.moved = true;
        this.eraseAt(x, y, c);
        return;
      case 'mute':
        this.muteAt(x, y, c);
        return;
      default:
        return;
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    this.els.gridHost.releasePointerCapture(e.pointerId);
    const c = this.ctx();
    this.drag = null;
    this.stopAudition();
    const { patternId, channelId } = c;
    if (patternId && channelId) {
      // A Shift-click that never moved copies nothing (a copy exactly on top of the original is no use).
      if (d.kind === 'move' && (d.dTick !== 0 || d.keys.some((k, i) => k !== d.originals[i]?.key))) {
        if (d.duplicate) {
          const copies = d.originals.map((n, i) => ({
            ...n,
            id: newId.note(),
            tick: n.tick + d.dTick,
            key: d.keys[i] as number,
          }));
          this.s.history.transact('Duplicate notes', (draft) => addNotes(draft, patternId, channelId, copies));
          this.s.editor.getState().selectNotes(copies.map((n) => n.id));
        } else {
          const edits = d.originals.map((n, i) => ({ id: n.id, tick: n.tick + d.dTick, key: d.keys[i] as number }));
          this.s.history.transact(d.originals.length > 1 ? 'Move notes' : 'Move note', (draft) =>
            editNotes(draft, patternId, channelId, edits),
          );
        }
      } else if (d.kind === 'resize' && d.dTick !== 0) {
        const edits = d.originals.map((n) => ({ id: n.id, length: n.length + d.dTick }));
        this.s.history.transact('Resize notes', (draft) => editNotes(draft, patternId, channelId, edits));
        this.s.editor.getState().setPianoRoll({ lastLength: d.anchor.length + d.dTick });
      } else if (d.kind === 'create') {
        const notes = d.notes;
        this.s.history.transact(notes.length > 1 ? 'Add chord' : 'Add note', (draft) =>
          addNotes(draft, patternId, channelId, notes),
        );
        this.s.editor.getState().selectNotes(notes.map((n) => n.id));
      } else if (d.kind === 'paint' || d.kind === 'mute') {
        d.gesture.commit();
      } else if (d.kind === 'erase') {
        d.gesture.commit();
        // A right-click on an empty spot that erased nothing opens the menu.
        if (e.button === 2 && !d.moved && d.done.size === 0) this.openMenu(e, c, null);
      }
    }
    this.preview = null;
    this.previewAdds = [];
    this.updateCursor();
    this.invalidate('notes', 'lane', 'overlay');
  }

  private cancelDrag(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.kind === 'paint' || d.kind === 'erase' || d.kind === 'mute' || d.kind === 'lane') d.gesture.cancel();
    if (d.kind === 'lane') this.els.laneValue.textContent = '';
    this.preview = null;
    this.previewAdds = [];
    this.stopAudition();
    this.invalidate('notes', 'lane', 'overlay');
  }

  private paintAt(x: number, y: number, c: Ctx, e: { altKey: boolean }): void {
    const d = this.drag;
    if (d?.kind !== 'paint' || !c.patternId || !c.channelId) return;
    const grid = this.snapFor(e, c);
    const editor = this.s.editor.getState();
    const length = Math.max(grid, Math.min(editor.pianoRoll.lastLength, grid * 4));
    const tick = Math.max(0, snapFloor(this.vp.xToTick(x), grid));
    const key = this.drawKeyAtY(y, c);
    // Fill every cell between the last and current position (fast drags skip cells).
    const from = Math.min(d.lastTick, tick);
    const to = Math.max(d.lastTick, tick);
    d.lastTick = tick;
    const add: Note[] = [];
    for (let t = from; t <= to; t += length) {
      const cell = `${t}:${key}`;
      if (d.done.has(cell)) continue;
      d.done.add(cell);
      for (const n of this.stamp(t, key, length, c))
        if (!c.notes.some((m) => m.key === n.key && m.tick === t)) add.push(n);
    }
    if (add.length === 0) return;
    const { patternId, channelId } = c;
    d.gesture.update((draft) => addNotes(draft, patternId, channelId, add));
    if (key !== this.audition?.key) this.auditionKey(key);
  }

  private eraseAt(x: number, y: number, c: Ctx): void {
    const d = this.drag;
    if (d?.kind !== 'erase' || !c.patternId || !c.channelId) return;
    const hit = this.hitTest(x, y, c);
    if (!hit || d.done.has(hit.note.id)) return;
    d.done.add(hit.note.id);
    const { patternId, channelId } = c;
    const id = hit.note.id;
    d.gesture.update((draft) => removeNotes(draft, patternId, channelId, [id]));
    this.hover = null;
  }

  private muteAt(x: number, y: number, c: Ctx): void {
    const d = this.drag;
    if (d?.kind !== 'mute' || !c.patternId || !c.channelId) return;
    const hit = this.hitTest(x, y, c);
    if (!hit || d.done.has(hit.note.id)) return;
    d.done.add(hit.note.id);
    const { patternId, channelId } = c;
    const edit = { id: hit.note.id, muted: d.muted };
    d.gesture.update((draft) => editNotes(draft, patternId, channelId, [edit]));
  }

  private autoScroll(x: number, y: number, c: Ctx): void {
    const d = this.drag;
    if (!d || d.kind === 'pan') return;
    const edge = 24;
    let dx = 0;
    let dy = 0;
    if (x > this.vp.width - edge) dx = (x - (this.vp.width - edge)) * 0.6;
    else if (x < edge && this.vp.scrollTick > 0) dx = (x - edge) * 0.6;
    if (y > this.vp.height - edge) dy = (y - (this.vp.height - edge)) * 0.4;
    else if (y < edge) dy = (y - edge) * 0.4;
    if (dx || dy) {
      this.vp.scrollBy(dx, dy, this.maxTick(c));
      this.viewportChanged();
    }
  }

  // ---------------------------------------------------------------- wheel & scrollbar

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const c = this.ctx();
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.vp.height : 1;
    const dx = e.deltaX * scale;
    const dy = e.deltaY * scale;
    const { x, y } = this.local(e);
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinch arrives as ctrl+wheel: zoom time around the pointer.
      this.vp.zoomX(Math.exp(-dy * 0.01), Math.max(0, x));
    } else if (e.altKey) {
      this.vp.zoomY(Math.exp(-dy * 0.005), Math.max(0, y));
    } else if (e.shiftKey) {
      this.vp.scrollBy(dy || dx, 0, this.maxTick(c));
    } else {
      this.vp.scrollBy(dx, dy, this.maxTick(c));
    }
    this.vp.clampScroll(this.maxTick(c));
    // Zooming keeps following (it glides back to the playhead); scrolling by hand waits a moment (follow.ts).
    if (e.ctrlKey || e.metaKey) this.follow.zoomed();
    else if (Math.abs(dx) >= 1 || e.shiftKey) this.follow.userScrolled();
    this.viewportChanged();
  }

  private onThumbDown(e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const thumb = this.els.hthumb;
    thumb.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startTick = this.vp.scrollTick;
    const c = this.ctx();
    const total = this.maxTick(c);
    const visible = this.vp.width / this.vp.pxPerTick;
    const track = this.els.hscroll.getBoundingClientRect().width;
    const w = thumb.getBoundingClientRect().width;
    const move = (ev: PointerEvent) => {
      const frac = (ev.clientX - startX) / Math.max(1, track - w);
      this.vp.scrollTick = clamp(startTick + frac * (total - visible), 0, Math.max(0, total - visible));
      this.follow.userScrolled();
      this.viewportChanged();
    };
    const up = () => {
      thumb.removeEventListener('pointermove', move);
      thumb.removeEventListener('pointerup', up);
    };
    thumb.addEventListener('pointermove', move);
    thumb.addEventListener('pointerup', up);
  }

  /** Zoom buttons. */
  zoomBy(factor: number): void {
    this.vp.zoomX(factor, this.vp.width / 2);
    this.vp.clampScroll(this.maxTick(this.ctx()));
    this.follow.zoomed();
    this.viewportChanged();
  }

  // ---------------------------------------------------------------- keyboard (left)

  private onKeysDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    this.els.keys.setPointerCapture(e.pointerId);
    const key = this.keyAtY(this.local(e, this.els.keys).y);
    this.drag = { kind: 'keys', key };
    this.pressKey(key, e);
  }

  private onKeysMove(e: PointerEvent): void {
    if (this.drag?.kind !== 'keys') return;
    const key = this.keyAtY(this.local(e, this.els.keys).y);
    if (key === this.drag.key) return;
    this.releaseKey(this.drag.key);
    this.drag.key = key;
    this.pressKey(key, e);
  }

  private onKeysUp(e: PointerEvent): void {
    if (this.drag?.kind !== 'keys') return;
    this.els.keys.releasePointerCapture(e.pointerId);
    this.releaseKey(this.drag.key);
    this.drag = null;
  }

  private pressKey(key: number, e: PointerEvent): void {
    const c = this.ctx();
    if (!c.channelId) return;
    // Clicking further right on a key plays it louder (FL-style).
    const vel = clamp(0.35 + (this.local(e, this.els.keys).x / KEYS_WIDTH) * 0.65, 0.1, 1);
    this.pressedKeys.set(key, this.s.engine.previewNoteOn(c.channelId, key, vel));
    this.invalidate('keys');
  }

  private releaseKey(key: number): void {
    const id = this.pressedKeys.get(key);
    const c = this.ctx();
    if (id !== undefined && c.channelId) this.s.engine.previewNoteOff(c.channelId, id);
    this.pressedKeys.delete(key);
    this.invalidate('keys');
  }

  // ---------------------------------------------------------------- event lane (velocity, pan, release, fine)

  private onLaneDown(e: PointerEvent): void {
    const c = this.ctx();
    if ((e.button !== 0 && e.button !== 2) || !c.channelId || !c.patternId) return;
    e.preventDefault();
    this.els.velocityHost.setPointerCapture(e.pointerId);
    const { x } = this.local(e, this.els.velocityHost);
    const lane = this.s.editor.getState().pianoRoll.lane;
    // Right-drag resets values to their default.
    this.drag = { kind: 'lane', gesture: this.s.history.gesture(LANES[lane].label), lastX: x, reset: e.button === 2 };
    this.laneAt(e, c);
  }

  private onLaneMove(e: PointerEvent): void {
    if (this.drag?.kind !== 'lane') return;
    if (e.buttons === 0) {
      this.onLaneUp(e);
      return;
    }
    this.laneAt(e, this.ctx());
  }

  private onLaneUp(e: PointerEvent): void {
    if (this.drag?.kind !== 'lane') return;
    this.laneAt(e, this.ctx());
    this.els.velocityHost.releasePointerCapture(e.pointerId);
    this.drag.gesture.commit();
    this.drag = null;
    this.els.laneValue.textContent = '';
  }

  private laneAt(e: PointerEvent, c: Ctx): void {
    const d = this.drag;
    if (d?.kind !== 'lane' || !c.patternId || !c.channelId) return;
    const host = this.els.velocityHost;
    const { x, y } = this.local(e, host);
    const h = host.getBoundingClientRect().height;
    const lane = this.s.editor.getState().pianoRoll.lane;
    const value = d.reset ? LANES[lane].reset : valueAtY(y, h, lane);
    this.hint(formatLaneValue(lane, value));
    this.els.laneValue.textContent = formatLaneAmount(lane, value);
    const x0 = Math.min(d.lastX, x) - 3;
    const x1 = Math.max(d.lastX, x) + 3;
    d.lastX = x;
    const t0 = this.vp.xToTick(x0);
    const t1 = this.vp.xToTick(x1);
    const selected = this.s.editor.getState().noteSelection;
    const only = selected.length > 0 ? new Set(selected) : null;
    const edits = c.notes
      .filter((n) => n.tick >= t0 && n.tick <= t1 && (!only || only.has(n.id)))
      .map((n) => laneEdit(n.id, lane, value));
    if (edits.length === 0) return;
    const { patternId, channelId } = c;
    d.gesture.update((draft) => editNotes(draft, patternId, channelId, edits));
  }
}
