/**
 * Imperative piano roll: owns the canvases, the viewport and pointer/wheel interaction. React only
 * renders the shell; data changes mark layers dirty and the shared frame loop redraws them.
 *
 * Geometry edits (move/resize/create) preview while dragging and commit one undo step on release.
 * Continuous edits (paint, erase, velocity) are live history gestures.
 */
import type { Services } from '@app/services';
import type { Gesture } from '@core/history/history';
import { newId } from '@core/model/ids';
import type { ChannelId, Note, NoteId, Pattern, PatternId, Project, Tick } from '@core/model/types';
import { addNote, addNotes, editNotes, removeNotes, sliceNote } from '@core/ops/notes';
import { noteAt, notesInRect } from '@core/query/notes-hit';
import { notesSorted, patternLength } from '@core/query/queries';
import { patternTickAt } from '@core/query/playlist';
import { ticksPerBar } from '@core/time/ppq';
import { gridTicks, snapFloor, snapRound } from '@core/time/snap';
import { onFrame } from '../../frame-loop';
import { fitCanvas, readTheme } from '../../timeline/canvas';
import { clamp, Viewport } from '../../timeline/viewport';
import { drawGhosts, drawGrid, drawKeys, drawNotes, drawRuler, drawVelocity, keyForRow, rowForKey } from './render';

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
  playhead: HTMLElement;
  hscroll: HTMLElement;
  hthumb: HTMLElement;
}

export const KEYS_WIDTH = 64;
export const RULER_HEIGHT = 20;

/** Redraw timings for performance checks (`window.__ag.perf` in dev). */
export const pianoRollPerf = { lastDrawMs: 0, maxDrawMs: 0, draws: 0, notesDrawn: 0 };

type Layer = 'grid' | 'notes' | 'overlay' | 'keys' | 'ruler' | 'velocity';
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
      dKey: number;
    }
  | { kind: 'resize'; x0: number; anchor: Note; originals: Note[]; dTick: number }
  | { kind: 'create'; note: Note; grabOffset: number }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; base: NoteId[] }
  | { kind: 'paint'; gesture: Gesture; done: Set<string>; lastTick: number; key: number }
  | { kind: 'erase'; gesture: Gesture; done: Set<NoteId> }
  | { kind: 'pan'; x: number; y: number }
  | { kind: 'velocity'; gesture: Gesture; lastX: number }
  | { kind: 'keys'; key: number };

interface Ctx {
  project: Project;
  channelId: ChannelId | null;
  patternId: PatternId | null;
  pattern: Pattern | undefined;
  rootKey: number | null;
  notes: readonly Note[];
}

export class PianoRollController {
  readonly vp = new Viewport(128, 0.004, 2);
  private dirty = new Set<Layer>(['grid', 'notes', 'overlay', 'keys', 'ruler', 'velocity']);
  private drag: Drag | null = null;
  private hover: Hit | null = null;
  private preview: Map<NoteId, Note> | null = null;
  private previewAdds: Note[] = [];
  private pressedKeys = new Map<number, number>();
  private audition: { key: number; noteId: number; channelId: ChannelId } | null = null;
  private unsubs: Array<() => void> = [];
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPlayheadX = NaN;
  private centeredFor: string | null = null;

  constructor(
    private readonly s: Services,
    private readonly els: PianoRollElements,
  ) {
    const pr = s.editor.getState().pianoRoll;
    this.vp.pxPerTick = pr.pxPerTick;
    this.vp.rowHeight = pr.rowHeight;
    this.vp.scrollTick = pr.scrollTick;
    this.vp.scrollRow = pr.scrollRow ?? rowForKey(72);
    // Keep a restored scroll position; center on the notes only when it's unknown or the channel changes.
    if (pr.scrollRow !== null) {
      const c = this.ctx();
      this.centeredFor = `${c.channelId}:${c.patternId}`;
    }
  }

  // ---------------------------------------------------------------- lifecycle

  mount(): void {
    const { s, els } = this;
    const all = () => this.invalidate('grid', 'notes', 'overlay', 'keys', 'ruler', 'velocity');
    this.unsubs.push(
      s.doc.subscribe((next, prev) => {
        if (next.project.patterns !== prev.project.patterns || next.project.channels !== prev.project.channels) all();
        if (next.project.transport !== prev.project.transport) all();
      }),
      s.editor.subscribe((next, prev) => {
        if (next.noteSelection !== prev.noteSelection) this.invalidate('notes', 'velocity');
        if (next.pianoRoll.snap !== prev.pianoRoll.snap || next.pianoRoll.ghosts !== prev.pianoRoll.ghosts) all();
        if (next.pianoRoll.velocityLane !== prev.pianoRoll.velocityLane) all();
        if (next.pianoRoll.tool !== prev.pianoRoll.tool) this.updateCursor();
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
      onFrame(() => this.frame()),
    );

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(els.gridHost);
    ro.observe(els.velocityHost);
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
      if (!this.drag && this.hover) {
        this.hover = null;
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

    on(els.velocityHost, 'pointerdown', (e) => this.onVelocityDown(e));
    on(els.velocityHost, 'pointermove', (e) => this.onVelocityMove(e));
    on(els.velocityHost, 'pointerup', (e) => this.onVelocityUp(e));

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
    let end = this.patternEnd(c);
    for (const n of c.notes) end = Math.max(end, n.tick + n.length);
    return end + bar * 8;
  }

  private selection(): ReadonlySet<NoteId> {
    return new Set(this.s.editor.getState().noteSelection);
  }

  // ---------------------------------------------------------------- layout & drawing

  invalidate(...layers: Layer[]): void {
    for (const l of layers) this.dirty.add(l);
  }

  private resize(): void {
    const r = this.els.gridHost.getBoundingClientRect();
    this.vp.width = Math.max(1, Math.round(r.width));
    this.vp.height = Math.max(1, Math.round(r.height));
    const c = this.ctx();
    this.vp.clampScroll(this.maxTick(c));
    this.invalidate('grid', 'notes', 'overlay', 'keys', 'ruler', 'velocity');
  }

  private frame(): void {
    const t0 = this.dirty.size > 0 ? performance.now() : 0;
    const c = this.ctx();
    // Center the view on the channel's notes the first time we show it.
    const key = `${c.channelId}:${c.patternId}`;
    if (this.centeredFor !== key && this.vp.height > 1) {
      this.centeredFor = key;
      this.centerOnNotes(c);
    }
    const theme = readTheme();
    const { els, vp } = this;
    const ts = c.project.transport.timeSig;
    if (this.dirty.has('grid')) {
      drawGrid(fitCanvas(els.grid, vp.width, vp.height), vp, theme, ts, this.patternEnd(c));
    }
    if (this.dirty.has('notes')) {
      const ctx = fitCanvas(els.notes, vp.width, vp.height);
      ctx.clearRect(0, 0, vp.width, vp.height);
      if (this.s.editor.getState().pianoRoll.ghosts && c.pattern) {
        for (const [cid, notes] of Object.entries(c.pattern.notes)) {
          if (cid !== c.channelId && notes) drawGhosts(ctx, vp, theme, notesSorted(notes));
        }
      }
      const selected = this.selection();
      const style = { color: theme.note, selected };
      if (this.preview) {
        const moving = this.drag?.kind === 'move' && !this.drag.duplicate;
        drawNotes(ctx, vp, theme, c.notes, style, {
          skip: moving || this.drag?.kind === 'resize' ? new Set(this.preview.keys()) : new Set(),
        });
        const shown = [...this.preview.values()].sort((a, b) => a.tick - b.tick);
        drawNotes(ctx, vp, theme, shown, { color: theme.note, selected: new Set(shown.map((n) => n.id)) });
      } else {
        drawNotes(ctx, vp, theme, c.notes, style);
      }
      if (this.previewAdds.length > 0) {
        drawNotes(ctx, vp, theme, this.previewAdds, {
          color: theme.note,
          selected: new Set(this.previewAdds.map((n) => n.id)),
        });
      }
    }
    if (this.dirty.has('overlay')) this.drawOverlay();
    if (this.dirty.has('keys')) {
      drawKeys(
        fitCanvas(els.keys, KEYS_WIDTH, vp.height),
        vp,
        theme,
        KEYS_WIDTH,
        new Set(this.pressedKeys.keys()),
        c.rootKey,
      );
    }
    if (this.dirty.has('ruler')) {
      drawRuler(fitCanvas(els.ruler, vp.width, RULER_HEIGHT), vp, theme, ts, RULER_HEIGHT, this.patternEnd(c));
    }
    if (this.dirty.has('velocity') && this.s.editor.getState().pianoRoll.velocityLane) {
      const h = Math.max(1, Math.round(els.velocityHost.getBoundingClientRect().height));
      const style = { color: theme.note, selected: this.selection() };
      drawVelocity(fitCanvas(els.velocity, vp.width, h), vp, theme, h, c.notes, style, this.preview);
    }
    if (this.dirty.size > 0) {
      this.updateScrollbar(c);
      const ms = performance.now() - t0;
      pianoRollPerf.lastDrawMs = ms;
      pianoRollPerf.maxDrawMs = Math.max(pianoRollPerf.maxDrawMs, ms);
      pianoRollPerf.draws++;
      pianoRollPerf.notesDrawn = c.notes.length;
    }
    this.dirty.clear();
    this.updatePlayhead(c);
  }

  private drawOverlay(): void {
    const { vp, els } = this;
    const ctx = fitCanvas(els.overlay, vp.width, vp.height);
    ctx.clearRect(0, 0, vp.width, vp.height);
    const theme = readTheme();
    const d = this.drag;
    if (d?.kind === 'marquee') {
      const x = Math.min(d.x0, d.x1);
      const y = Math.min(d.y0, d.y1);
      ctx.fillStyle = 'rgba(90, 164, 232, 0.12)';
      ctx.strokeStyle = 'rgba(90, 164, 232, 0.9)';
      ctx.fillRect(x, y, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    } else if (this.hover && !d) {
      const n = this.hover.note;
      const x = vp.tickToX(n.tick);
      const y = vp.rowToY(rowForKey(n.key));
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.strokeRect(x + 0.5, y + 1.5, Math.max(2, n.length * vp.pxPerTick - 2), vp.rowHeight - 3);
      if (this.s.editor.getState().pianoRoll.tool === 'slice') {
        ctx.fillStyle = theme.danger;
        ctx.fillRect(Math.round(this.sliceX), y, 1, vp.rowHeight);
      }
    }
  }

  private sliceX = 0;

  private updatePlayhead(c: Ctx): void {
    const { engine, view } = this.s;
    let x = NaN;
    if (engine.playing && c.pattern && c.patternId) {
      if (view.getState().mode === 'pattern') x = this.vp.tickToX(engine.playhead() % this.patternEnd(c));
      else {
        // Song mode: follow the clip of this pattern that's playing, if any.
        const t = patternTickAt(c.project, engine.playhead(), c.patternId);
        if (t !== null) x = this.vp.tickToX(t);
      }
    }
    if (x === this.lastPlayheadX) return;
    this.lastPlayheadX = x;
    const el = this.els.playhead;
    if (!Number.isFinite(x) || x < 0 || x > this.vp.width) el.style.display = 'none';
    else {
      el.style.display = 'block';
      el.style.transform = `translateX(${KEYS_WIDTH + x}px)`;
    }
  }

  private updateScrollbar(c: Ctx): void {
    const total = this.maxTick(c);
    const visible = this.vp.width / this.vp.pxPerTick;
    const track = this.els.hscroll.getBoundingClientRect().width;
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
    this.invalidate('grid', 'notes', 'overlay', 'keys', 'velocity');
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
    this.invalidate('grid', 'notes', 'overlay', 'keys', 'ruler', 'velocity');
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
    host.setPointerCapture(e.pointerId);
    this.s.view.getState().focusWindow('piano-roll');
    const editor = this.s.editor.getState();
    const tool = editor.pianoRoll.tool;
    const hit = this.hitTest(x, y, c);
    const mod = e.metaKey || e.ctrlKey;

    if (e.button === 2 || tool === 'delete') {
      const gesture = this.s.history.gesture('Delete notes');
      this.drag = { kind: 'erase', gesture, done: new Set() };
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
          dKey: 0,
        };
        this.auditionKey(hit.note.key, hit.note.velocity);
      }
      this.preview = new Map(originals.map((n) => [n.id, n]));
      if (this.drag.kind === 'move' && this.drag.duplicate) {
        this.preview = new Map();
        this.previewAdds = originals.map((n) => ({ ...n }));
      }
      this.invalidate('notes', 'velocity', 'overlay');
      return;
    }

    if (tool === 'select' || (tool === 'draw' && mod)) {
      this.drag = { kind: 'marquee', x0: x, y0: y, x1: x, y1: y, base: mod ? [...editor.noteSelection] : [] };
      if (!mod) editor.selectNotes([]);
      this.invalidate('overlay');
      return;
    }

    const grid = this.snapFor(e, c);
    const key = this.keyAtY(y);
    if (tool === 'paint') {
      const gesture = this.s.history.gesture('Paint notes');
      this.drag = { kind: 'paint', gesture, done: new Set(), lastTick: snapFloor(this.vp.xToTick(x), grid), key };
      this.paintAt(x, y, c, e);
      this.auditionKey(key);
      return;
    }

    // Draw tool on empty space: create a note and keep dragging it into place.
    editor.selectNotes([]);
    const tick = Math.max(0, snapFloor(this.vp.xToTick(x), grid));
    const note: Note = { id: newId.note(), tick, length: editor.pianoRoll.lastLength, key, velocity: 100 / 128 };
    this.drag = { kind: 'create', note, grabOffset: this.vp.xToTick(x) - tick };
    this.previewAdds = [note];
    this.auditionKey(key);
    this.invalidate('notes', 'velocity');
  }

  private onPointerMove(e: PointerEvent): void {
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
      return;
    }
    this.autoScroll(x, y, c);
    switch (d.kind) {
      case 'pan': {
        this.vp.scrollBy(d.x - e.clientX, d.y - e.clientY, this.maxTick(c));
        d.x = e.clientX;
        d.y = e.clientY;
        this.viewportChanged();
        return;
      }
      case 'move': {
        const grid = this.snapFor(e, c);
        const rawTick = d.anchor.tick + (x - d.x0) / this.vp.pxPerTick;
        let dTick = snapRound(rawTick, grid) - d.anchor.tick;
        const minTick = Math.min(...d.originals.map((n) => n.tick));
        if (minTick + dTick < 0) dTick = -minTick;
        let dKey = this.keyAtY(y) - this.keyAtY(d.y0);
        const keys = d.originals.map((n) => n.key);
        dKey = clamp(dKey, -Math.min(...keys), 127 - Math.max(...keys));
        if (dTick === d.dTick && dKey === d.dKey) return;
        d.dTick = dTick;
        d.dKey = dKey;
        const moved = d.originals.map((n) => ({ ...n, tick: n.tick + dTick, key: n.key + dKey }));
        if (d.duplicate) this.previewAdds = moved;
        else this.preview = new Map(moved.map((n) => [n.id, n]));
        this.auditionKey(d.anchor.key + dKey, d.anchor.velocity);
        this.invalidate('notes', 'velocity');
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
        this.invalidate('notes', 'velocity');
        return;
      }
      case 'create': {
        const grid = this.snapFor(e, c);
        const tick = Math.max(0, snapFloor(this.vp.xToTick(x) - d.grabOffset + grid / 2, grid));
        const key = this.keyAtY(y);
        if (tick === d.note.tick && key === d.note.key) return;
        d.note = { ...d.note, tick, key };
        this.previewAdds = [d.note];
        this.auditionKey(key);
        this.invalidate('notes', 'velocity');
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
        this.eraseAt(x, y, c);
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
      if (d.kind === 'move' && (d.dTick !== 0 || d.dKey !== 0 || d.duplicate)) {
        if (d.duplicate) {
          const copies = d.originals.map((n) => ({
            ...n,
            id: newId.note(),
            tick: n.tick + d.dTick,
            key: n.key + d.dKey,
          }));
          this.s.history.transact('Duplicate notes', (draft) => addNotes(draft, patternId, channelId, copies));
          this.s.editor.getState().selectNotes(copies.map((n) => n.id));
        } else {
          const edits = d.originals.map((n) => ({ id: n.id, tick: n.tick + d.dTick, key: n.key + d.dKey }));
          this.s.history.transact(d.originals.length > 1 ? 'Move notes' : 'Move note', (draft) =>
            editNotes(draft, patternId, channelId, edits),
          );
        }
      } else if (d.kind === 'resize' && d.dTick !== 0) {
        const edits = d.originals.map((n) => ({ id: n.id, length: n.length + d.dTick }));
        this.s.history.transact('Resize notes', (draft) => editNotes(draft, patternId, channelId, edits));
        this.s.editor.getState().setPianoRoll({ lastLength: d.anchor.length + d.dTick });
      } else if (d.kind === 'create') {
        const note = d.note;
        this.s.history.transact('Add note', (draft) => addNote(draft, patternId, channelId, note));
        this.s.editor.getState().selectNotes([note.id]);
      } else if (d.kind === 'paint' || d.kind === 'erase') {
        d.gesture.commit();
      }
    }
    this.preview = null;
    this.previewAdds = [];
    this.updateCursor();
    this.invalidate('notes', 'velocity', 'overlay');
  }

  private cancelDrag(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.kind === 'paint' || d.kind === 'erase' || d.kind === 'velocity') d.gesture.cancel();
    this.preview = null;
    this.previewAdds = [];
    this.stopAudition();
    this.invalidate('notes', 'velocity', 'overlay');
  }

  private paintAt(x: number, y: number, c: Ctx, e: { altKey: boolean }): void {
    const d = this.drag;
    if (d?.kind !== 'paint' || !c.patternId || !c.channelId) return;
    const grid = this.snapFor(e, c);
    const editor = this.s.editor.getState();
    const length = Math.max(grid, Math.min(editor.pianoRoll.lastLength, grid * 4));
    const tick = Math.max(0, snapFloor(this.vp.xToTick(x), grid));
    const key = this.keyAtY(y);
    // Fill every cell between the last and current position (fast drags skip cells).
    const from = Math.min(d.lastTick, tick);
    const to = Math.max(d.lastTick, tick);
    d.lastTick = tick;
    const add: Note[] = [];
    for (let t = from; t <= to; t += length) {
      const cell = `${t}:${key}`;
      if (d.done.has(cell)) continue;
      d.done.add(cell);
      if (c.notes.some((n) => n.key === key && n.tick === t)) continue;
      add.push({ id: newId.note(), tick: t, length, key, velocity: 100 / 128 });
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

  // ---------------------------------------------------------------- velocity lane

  private onVelocityDown(e: PointerEvent): void {
    const c = this.ctx();
    if (e.button !== 0 || !c.channelId || !c.patternId) return;
    e.preventDefault();
    this.els.velocityHost.setPointerCapture(e.pointerId);
    const { x } = this.local(e, this.els.velocityHost);
    this.drag = { kind: 'velocity', gesture: this.s.history.gesture('Velocity'), lastX: x };
    this.velocityAt(e, c);
  }

  private onVelocityMove(e: PointerEvent): void {
    if (this.drag?.kind !== 'velocity') return;
    this.velocityAt(e, this.ctx());
  }

  private onVelocityUp(e: PointerEvent): void {
    if (this.drag?.kind !== 'velocity') return;
    this.velocityAt(e, this.ctx());
    this.els.velocityHost.releasePointerCapture(e.pointerId);
    this.drag.gesture.commit();
    this.drag = null;
  }

  private velocityAt(e: PointerEvent, c: Ctx): void {
    const d = this.drag;
    if (d?.kind !== 'velocity' || !c.patternId || !c.channelId) return;
    const host = this.els.velocityHost;
    const { x, y } = this.local(e, host);
    const h = host.getBoundingClientRect().height;
    const velocity = clamp(1 - (y - 3) / (h - 6), 0.01, 1);
    const x0 = Math.min(d.lastX, x) - 3;
    const x1 = Math.max(d.lastX, x) + 3;
    d.lastX = x;
    const t0 = this.vp.xToTick(x0);
    const t1 = this.vp.xToTick(x1);
    const selected = this.s.editor.getState().noteSelection;
    const only = selected.length > 0 ? new Set(selected) : null;
    const edits = c.notes
      .filter((n) => n.tick >= t0 && n.tick <= t1 && (!only || only.has(n.id)) && n.velocity !== velocity)
      .map((n) => ({ id: n.id, velocity }));
    if (edits.length === 0) return;
    const { patternId, channelId } = c;
    d.gesture.update((draft) => editNotes(draft, patternId, channelId, edits));
  }
}
