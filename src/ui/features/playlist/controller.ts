/**
 * Imperative playlist editor (same architecture as the piano roll): canvases for lane headers,
 * ruler and clips, redrawn on the frame loop when dirty; geometry drags preview and commit once.
 */
import type { Services } from '@app/services';
import type { Gesture } from '@core/history/history';
import { newId } from '@core/model/ids';
import type { Clip, ClipId, Lane, LaneId, PatternClip, Project, Tick } from '@core/model/types';
import { addClips, editClips, removeClips, setLaneProps, splitClip, toggleSoloLane } from '@core/ops/playlist';
import { clipAt, clipsInRect, clipsSorted, mutedLanes, patternClipLength, songLength } from '@core/query/playlist';
import { PPQ, ticksPerBar } from '@core/time/ppq';
import { gridTicks, snapFloor, snapRound } from '@core/time/snap';
import { onFrame } from '../../frame-loop';
import { fitCanvas, readTheme } from '../../timeline/canvas';
import { clamp, Viewport } from '../../timeline/viewport';
import { drawClips, drawLaneHeaders, drawLanesGrid, drawPlaylistRuler, HEADER_WIDTH, RULER_HEIGHT } from './render';

export interface PlaylistElements {
  gridHost: HTMLElement;
  grid: HTMLCanvasElement;
  clips: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  headers: HTMLCanvasElement;
  ruler: HTMLCanvasElement;
  playhead: HTMLElement;
  hscroll: HTMLElement;
  hthumb: HTMLElement;
  rename: HTMLInputElement;
}

type Layer = 'grid' | 'clips' | 'overlay' | 'headers' | 'ruler';
type Zone = 'body' | 'start' | 'end';
type Hit = { clip: Clip; zone: Zone };

type Drag =
  | {
      kind: 'move';
      x0: number;
      y0: number;
      anchor: Clip;
      originals: Clip[];
      duplicate: boolean;
      dTick: number;
      dLane: number;
    }
  | { kind: 'resize'; x0: number; anchor: Clip; originals: Clip[]; side: 'start' | 'end'; dTick: number }
  | { kind: 'create'; clip: PatternClip; grab: number }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; base: ClipId[] }
  | { kind: 'paint'; gesture: Gesture; lane: LaneId; last: Tick; done: Set<Tick> }
  | { kind: 'erase'; gesture: Gesture; done: Set<ClipId> }
  | { kind: 'pan'; x: number; y: number }
  | { kind: 'loop'; t0: Tick; moved: boolean };

export class PlaylistController {
  readonly vp = new Viewport(32, 0.0015, 0.5);
  private dirty = new Set<Layer>(['grid', 'clips', 'overlay', 'headers', 'ruler']);
  private drag: Drag | null = null;
  private hover: Hit | null = null;
  private preview: Clip[] | null = null;
  private unsubs: Array<() => void> = [];
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPlayheadX = NaN;
  private sliceX = -1;

  constructor(
    private readonly s: Services,
    private readonly els: PlaylistElements,
  ) {
    const pl = s.editor.getState().playlist;
    this.vp.pxPerTick = pl.pxPerTick;
    this.vp.rowHeight = pl.laneHeight;
    this.vp.scrollTick = pl.scrollTick;
    this.vp.scrollRow = pl.scrollLane;
  }

  // ---------------------------------------------------------------- lifecycle

  mount(): void {
    const { s, els } = this;
    const all = () => this.invalidate('grid', 'clips', 'overlay', 'headers', 'ruler');
    this.unsubs.push(
      s.doc.subscribe((next, prev) => {
        const a = next.project;
        const b = prev.project;
        if (
          a.playlist !== b.playlist ||
          a.patterns !== b.patterns ||
          a.channels !== b.channels ||
          a.transport !== b.transport
        )
          all();
      }),
      s.editor.subscribe((next, prev) => {
        if (next.clipSelection !== prev.clipSelection) this.invalidate('clips');
        if (next.playlist.snap !== prev.playlist.snap) all();
        if (next.playlist.tool !== prev.playlist.tool) this.updateCursor();
      }),
      s.view.subscribe((next, prev) => {
        if (next.loop !== prev.loop || next.mode !== prev.mode) this.invalidate('ruler');
        if (next.currentPatternId !== prev.currentPatternId) this.invalidate('clips');
      }),
      onFrame(() => this.frame()),
    );
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(els.gridHost);
    this.unsubs.push(() => ro.disconnect());

    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.unsubs.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    const host = els.gridHost;
    on(host, 'pointerdown', (e) => this.onPointerDown(e));
    on(host, 'pointermove', (e) => this.onPointerMove(e));
    on(host, 'pointerup', (e) => this.onPointerUp(e));
    on(host, 'pointercancel', () => this.cancelDrag());
    on(host, 'dblclick', (e) => this.onDoubleClick(e));
    on(host, 'contextmenu', (e) => e.preventDefault());
    on(host, 'pointerleave', () => {
      if (!this.drag && this.hover) {
        this.hover = null;
        this.invalidate('overlay');
      }
    });
    for (const el of [host, els.headers, els.ruler]) on(el, 'wheel', (e) => this.onWheel(e), { passive: false });
    on(els.headers, 'pointerdown', (e) => this.onHeaderDown(e));
    on(els.headers, 'dblclick', (e) => this.onHeaderDouble(e));
    on(els.headers, 'contextmenu', (e) => e.preventDefault());
    on(els.ruler, 'pointerdown', (e) => this.onRulerDown(e));
    on(els.ruler, 'pointermove', (e) => this.onRulerMove(e));
    on(els.ruler, 'pointerup', (e) => this.onRulerUp(e));
    on(els.ruler, 'dblclick', () => this.s.view.getState().setLoop(null));
    on(els.hthumb, 'pointerdown', (e) => this.onThumbDown(e));
    on(host, 'dragover', (e) => this.onDragOver(e));
    on(host, 'drop', (e) => this.onDrop(e));

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
    for (const fn of this.unsubs.splice(0)) fn();
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistViewport();
  }

  /** Called with a sound dragged in from the browser: the playlist creates an audio clip for it. */
  onSampleDrop?: (generator: string, laneId: LaneId, tick: Tick) => void;

  // ---------------------------------------------------------------- data

  private project(): Project {
    return this.s.doc.getState().project;
  }

  private lanes(p: Project): Lane[] {
    return p.playlist.laneOrder.map((id) => p.playlist.lanes[id]).filter((l): l is Lane => !!l);
  }

  private grid(p: Project, e?: { altKey: boolean }): Tick {
    if (e?.altKey) return 1;
    return gridTicks(this.s.editor.getState().playlist.snap, p.transport.timeSig, this.vp.pxPerTick);
  }

  private maxTick(p: Project): Tick {
    return Math.max(songLength(p), 0) + ticksPerBar(p.transport.timeSig) * 32;
  }

  private laneAtY(y: number, p: Project): LaneId | null {
    const row = Math.floor(this.vp.yToRow(y));
    return p.playlist.laneOrder[row] ?? null;
  }

  private laneRow(p: Project, laneId: LaneId): number {
    return p.playlist.laneOrder.indexOf(laneId);
  }

  // ---------------------------------------------------------------- drawing

  invalidate(...layers: Layer[]): void {
    for (const l of layers) this.dirty.add(l);
  }

  private resize(): void {
    const r = this.els.gridHost.getBoundingClientRect();
    this.vp.width = Math.max(1, Math.round(r.width));
    this.vp.height = Math.max(1, Math.round(r.height));
    const p = this.project();
    this.vp.rows = p.playlist.laneOrder.length;
    this.vp.clampScroll(this.maxTick(p));
    this.invalidate('grid', 'clips', 'overlay', 'headers', 'ruler');
  }

  private frame(): void {
    const p = this.project();
    const { vp, els } = this;
    vp.rows = p.playlist.laneOrder.length;
    if (this.dirty.size > 0) {
      const theme = readTheme();
      const ts = p.transport.timeSig;
      const muted = mutedLanes(p.playlist);
      if (this.dirty.has('grid'))
        drawLanesGrid(fitCanvas(els.grid, vp.width, vp.height), vp, theme, ts, vp.rows, songLength(p));
      if (this.dirty.has('clips')) {
        const ctx = fitCanvas(els.clips, vp.width, vp.height);
        ctx.clearRect(0, 0, vp.width, vp.height);
        const laneIndex = new Map(p.playlist.laneOrder.map((id, i) => [id, i]));
        const selected = new Set(this.s.editor.getState().clipSelection);
        const d = this.drag;
        const hideOriginals = this.preview && (d?.kind === 'resize' || (d?.kind === 'move' && !d.duplicate));
        const skip = hideOriginals ? new Set(this.preview?.map((c) => c.id)) : undefined;
        drawClips(
          ctx,
          vp,
          theme,
          p,
          clipsSorted(p.playlist.clips),
          laneIndex,
          { selected, ...(skip ? { skip } : {}) },
          muted,
        );
        if (this.preview) {
          const sel = new Set(this.preview.map((c) => c.id));
          drawClips(ctx, vp, theme, p, this.preview, laneIndex, { selected: sel }, muted);
        }
      }
      if (this.dirty.has('overlay')) this.drawOverlay();
      if (this.dirty.has('headers')) {
        drawLaneHeaders(fitCanvas(els.headers, HEADER_WIDTH, vp.height), vp, theme, this.lanes(p), muted, HEADER_WIDTH);
      }
      if (this.dirty.has('ruler')) {
        drawPlaylistRuler(
          fitCanvas(els.ruler, vp.width, RULER_HEIGHT),
          vp,
          theme,
          ts,
          this.s.view.getState().loop,
          songLength(p),
        );
      }
      this.updateScrollbar(p);
      this.dirty.clear();
    }
    this.updatePlayhead();
  }

  private drawOverlay(): void {
    const { vp, els } = this;
    const ctx = fitCanvas(els.overlay, vp.width, vp.height);
    ctx.clearRect(0, 0, vp.width, vp.height);
    const d = this.drag;
    if (d?.kind === 'marquee') {
      const x = Math.min(d.x0, d.x1);
      const y = Math.min(d.y0, d.y1);
      ctx.fillStyle = 'rgba(90, 164, 232, 0.12)';
      ctx.strokeStyle = 'rgba(90, 164, 232, 0.9)';
      ctx.fillRect(x, y, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    } else if (this.hover && !d && this.s.editor.getState().playlist.tool === 'slice' && this.sliceX >= 0) {
      const row = this.laneRow(this.project(), this.hover.clip.laneId);
      ctx.fillStyle = readTheme().danger;
      ctx.fillRect(Math.round(this.sliceX), vp.rowToY(row), 1, vp.rowHeight);
    }
  }

  private updatePlayhead(): void {
    const { engine, view } = this.s;
    const v = view.getState();
    let x = NaN;
    if (v.mode === 'song') x = this.vp.tickToX(engine.playing ? engine.playhead() : v.songStart);
    if (x === this.lastPlayheadX) return;
    this.lastPlayheadX = x;
    const el = this.els.playhead;
    if (!Number.isFinite(x) || x < 0 || x > this.vp.width) el.style.display = 'none';
    else {
      el.style.display = 'block';
      el.style.transform = `translateX(${HEADER_WIDTH + x}px)`;
    }
  }

  private updateScrollbar(p: Project): void {
    const total = this.maxTick(p);
    const visible = this.vp.width / this.vp.pxPerTick;
    const track = this.els.hscroll.getBoundingClientRect().width;
    const w = Math.max(24, Math.min(track, (visible / total) * track));
    const x = total > visible ? (this.vp.scrollTick / (total - visible)) * (track - w) : 0;
    this.els.hthumb.style.width = `${w}px`;
    this.els.hthumb.style.transform = `translateX(${x}px)`;
  }

  private persistViewport(): void {
    this.s.editor.getState().setPlaylist({
      pxPerTick: this.vp.pxPerTick,
      laneHeight: this.vp.rowHeight,
      scrollTick: this.vp.scrollTick,
      scrollLane: this.vp.scrollRow,
    });
  }

  private viewportChanged(): void {
    this.invalidate('grid', 'clips', 'overlay', 'headers', 'ruler');
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistViewport(), 300);
  }

  zoomBy(factor: number): void {
    this.vp.zoomX(factor, this.vp.width / 2);
    this.vp.clampScroll(this.maxTick(this.project()));
    this.viewportChanged();
  }

  // ---------------------------------------------------------------- hit testing

  private local(e: { clientX: number; clientY: number }, el: HTMLElement = this.els.gridHost) {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private hitTest(x: number, y: number, p: Project): Hit | null {
    const lane = this.laneAtY(y, p);
    if (!lane) return null;
    const c = clipAt(clipsSorted(p.playlist.clips), this.vp.xToTick(x), lane);
    if (!c) return null;
    const left = this.vp.tickToX(c.start);
    const right = this.vp.tickToX(c.start + c.length);
    const edge = Math.min(8, Math.max(3, (right - left) / 4));
    const zone: Zone = right - x <= edge ? 'end' : x - left <= edge ? 'start' : 'body';
    return { clip: c, zone };
  }

  private updateCursor(): void {
    const tool = this.s.editor.getState().playlist.tool;
    const h = this.hover;
    let cursor = 'default';
    if (this.drag?.kind === 'pan') cursor = 'grabbing';
    else if (tool === 'delete') cursor = 'not-allowed';
    else if (tool === 'slice') cursor = h ? 'col-resize' : 'default';
    else if (h && h.zone !== 'body') cursor = 'ew-resize';
    else if (h) cursor = 'move';
    else if (tool === 'draw' || tool === 'paint') cursor = 'crosshair';
    this.els.gridHost.style.cursor = cursor;
  }

  // ---------------------------------------------------------------- clips pointer

  private currentPatternClip(p: Project, laneId: LaneId, start: Tick): PatternClip | null {
    const patternId = this.s.view.getState().currentPatternId;
    if (!patternId || !p.patterns[patternId]) return null;
    return {
      kind: 'pattern',
      id: newId.clip(),
      laneId,
      start,
      length: patternClipLength(p, patternId),
      patternId,
      offset: 0,
    };
  }

  private onPointerDown(e: PointerEvent): void {
    const p = this.project();
    const host = this.els.gridHost;
    const { x, y } = this.local(e);
    if (e.button === 1) {
      e.preventDefault();
      host.setPointerCapture(e.pointerId);
      this.drag = { kind: 'pan', x: e.clientX, y: e.clientY };
      this.updateCursor();
      return;
    }
    e.preventDefault();
    host.setPointerCapture(e.pointerId);
    this.s.view.getState().focusWindow('playlist');
    const editor = this.s.editor.getState();
    const tool = editor.playlist.tool;
    const hit = this.hitTest(x, y, p);
    const mod = e.metaKey || e.ctrlKey;

    if (e.button === 2 || tool === 'delete') {
      this.drag = { kind: 'erase', gesture: this.s.history.gesture('Delete clips'), done: new Set() };
      this.eraseAt(x, y, p);
      return;
    }
    if (e.button !== 0) return;

    if (tool === 'slice') {
      if (hit) {
        const at = snapRound(this.vp.xToTick(x), this.grid(p, e));
        const spt = 60 / (p.transport.bpm * PPQ);
        this.s.history.transact('Slice clip', (d) => splitClip(d, hit.clip.id, at, spt));
      }
      return;
    }

    if (hit && tool !== 'paint') {
      const sel = editor.clipSelection;
      if (mod) {
        editor.selectClips(sel.includes(hit.clip.id) ? sel.filter((id) => id !== hit.clip.id) : [...sel, hit.clip.id]);
        return;
      }
      const ids = sel.includes(hit.clip.id) ? sel : [hit.clip.id];
      editor.selectClips(ids);
      const originals = ids.map((id) => p.playlist.clips[id]).filter((c): c is Clip => !!c);
      if (hit.clip.kind === 'pattern') this.s.view.getState().setCurrentPattern(hit.clip.patternId);
      if (hit.zone === 'body') {
        this.drag = {
          kind: 'move',
          x0: x,
          y0: y,
          anchor: hit.clip,
          originals,
          duplicate: e.shiftKey,
          dTick: 0,
          dLane: 0,
        };
      } else {
        this.drag = { kind: 'resize', x0: x, anchor: hit.clip, originals, side: hit.zone, dTick: 0 };
      }
      this.preview = originals.map((c) => ({ ...c }));
      this.invalidate('clips');
      return;
    }

    if (tool === 'select' || (tool === 'draw' && mod)) {
      this.drag = { kind: 'marquee', x0: x, y0: y, x1: x, y1: y, base: mod ? [...editor.clipSelection] : [] };
      if (!mod) editor.selectClips([]);
      this.invalidate('overlay');
      return;
    }

    const lane = this.laneAtY(y, p);
    if (!lane) return;
    const grid = this.grid(p, e);
    const tick = Math.max(0, snapFloor(this.vp.xToTick(x), grid));
    if (tool === 'paint') {
      this.drag = { kind: 'paint', gesture: this.s.history.gesture('Paint clips'), lane, last: tick, done: new Set() };
      this.paintAt(x, p, e);
      return;
    }
    const clip = this.currentPatternClip(p, lane, tick);
    if (!clip) return;
    editor.selectClips([]);
    this.drag = { kind: 'create', clip, grab: this.vp.xToTick(x) - tick };
    this.preview = [clip];
    this.invalidate('clips');
  }

  private onPointerMove(e: PointerEvent): void {
    const p = this.project();
    const { x, y } = this.local(e);
    const d = this.drag;
    if (!d) {
      const hit = this.hitTest(x, y, p);
      const slice = this.s.editor.getState().playlist.tool === 'slice';
      if (hit?.clip.id !== this.hover?.clip.id || hit?.zone !== this.hover?.zone || slice) {
        this.hover = hit;
        this.sliceX = hit ? this.vp.tickToX(snapRound(this.vp.xToTick(x), this.grid(p, e))) : -1;
        this.invalidate('overlay');
        this.updateCursor();
      }
      return;
    }
    this.autoScroll(x, y, p);
    switch (d.kind) {
      case 'pan':
        this.vp.scrollBy(d.x - e.clientX, d.y - e.clientY, this.maxTick(p));
        d.x = e.clientX;
        d.y = e.clientY;
        this.viewportChanged();
        return;
      case 'move': {
        const grid = this.grid(p, e);
        let dTick = snapRound(d.anchor.start + (x - d.x0) / this.vp.pxPerTick, grid) - d.anchor.start;
        const minStart = Math.min(...d.originals.map((c) => c.start));
        if (minStart + dTick < 0) dTick = -minStart;
        const rows = d.originals.map((c) => this.laneRow(p, c.laneId));
        const dLane = clamp(
          Math.floor(this.vp.yToRow(y)) - Math.floor(this.vp.yToRow(d.y0)),
          -Math.min(...rows),
          p.playlist.laneOrder.length - 1 - Math.max(...rows),
        );
        if (dTick === d.dTick && dLane === d.dLane) return;
        d.dTick = dTick;
        d.dLane = dLane;
        this.preview = d.originals.map((c, i) => ({
          ...c,
          start: c.start + dTick,
          laneId: p.playlist.laneOrder[(rows[i] as number) + dLane] as LaneId,
        }));
        this.invalidate('clips');
        return;
      }
      case 'resize': {
        const grid = this.grid(p, e);
        if (d.side === 'end') {
          const end = d.anchor.start + d.anchor.length + (x - d.x0) / this.vp.pxPerTick;
          let dTick = snapRound(end, grid) - (d.anchor.start + d.anchor.length);
          const minLen = Math.min(...d.originals.map((c) => c.length));
          if (minLen + dTick < Math.max(grid, 1)) dTick = Math.max(grid, 1) - minLen;
          if (dTick === d.dTick) return;
          d.dTick = dTick;
          this.preview = d.originals.map((c) => ({ ...c, length: c.length + dTick }));
        } else {
          // Left edge trims the start: content stays in place (offset follows).
          let dTick = snapRound(d.anchor.start + (x - d.x0) / this.vp.pxPerTick, grid) - d.anchor.start;
          const maxD = Math.min(...d.originals.map((c) => c.length - Math.max(grid, 1)));
          const minD = -Math.min(
            ...d.originals.map((c) => Math.min(c.start, c.kind === 'audio' ? Infinity : c.offset)),
          );
          dTick = clamp(dTick, minD, maxD);
          if (dTick === d.dTick) return;
          d.dTick = dTick;
          const spt = 60 / (p.transport.bpm * PPQ);
          this.preview = d.originals.map((c) =>
            c.kind === 'audio'
              ? {
                  ...c,
                  start: c.start + dTick,
                  length: c.length - dTick,
                  offsetSec: Math.max(0, c.offsetSec + dTick * spt),
                }
              : { ...c, start: c.start + dTick, length: c.length - dTick, offset: c.offset + dTick },
          );
        }
        this.invalidate('clips');
        return;
      }
      case 'create': {
        const grid = this.grid(p, e);
        const start = Math.max(0, snapFloor(this.vp.xToTick(x) - d.grab + grid / 2, grid));
        const lane = this.laneAtY(y, p) ?? d.clip.laneId;
        if (start === d.clip.start && lane === d.clip.laneId) return;
        d.clip = { ...d.clip, start, laneId: lane };
        this.preview = [d.clip];
        this.invalidate('clips');
        return;
      }
      case 'marquee': {
        d.x1 = x;
        d.y1 = y;
        const r0 = Math.max(0, Math.floor(this.vp.yToRow(Math.min(d.y0, d.y1))));
        const r1 = Math.floor(this.vp.yToRow(Math.max(d.y0, d.y1)));
        const lanes = new Set(p.playlist.laneOrder.slice(r0, r1 + 1));
        const ids = clipsInRect(
          clipsSorted(p.playlist.clips),
          this.vp.xToTick(Math.min(d.x0, d.x1)),
          this.vp.xToTick(Math.max(d.x0, d.x1)),
          lanes,
        );
        this.s.editor.getState().selectClips([...new Set([...d.base, ...ids])]);
        this.invalidate('overlay');
        return;
      }
      case 'paint':
        this.paintAt(x, p, e);
        return;
      case 'erase':
        this.eraseAt(x, y, p);
        return;
      default:
        return;
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    this.els.gridHost.releasePointerCapture(e.pointerId);
    this.drag = null;
    const editor = this.s.editor.getState();
    if (d.kind === 'move' && this.preview && (d.dTick !== 0 || d.dLane !== 0 || d.duplicate)) {
      const moved = this.preview;
      if (d.duplicate) {
        const copies = moved.map((c) => ({ ...c, id: newId.clip() }));
        this.s.history.transact('Duplicate clips', (draft) => addClips(draft, copies));
        editor.selectClips(copies.map((c) => c.id));
      } else {
        this.s.history.transact(moved.length > 1 ? 'Move clips' : 'Move clip', (draft) =>
          editClips(
            draft,
            moved.map((c) => ({ id: c.id, start: c.start, laneId: c.laneId })),
          ),
        );
      }
    } else if (d.kind === 'resize' && this.preview && d.dTick !== 0) {
      const changed = this.preview;
      this.s.history.transact('Resize clips', (draft) =>
        editClips(
          draft,
          changed.map((c) => ({
            id: c.id,
            start: c.start,
            length: c.length,
            ...(c.kind === 'audio' ? { offsetSec: c.offsetSec } : { offset: c.offset }),
          })),
        ),
      );
    } else if (d.kind === 'create') {
      const clip = d.clip;
      this.s.history.transact('Add clip', (draft) => addClips(draft, [clip]));
      editor.selectClips([clip.id]);
    } else if (d.kind === 'paint' || d.kind === 'erase') {
      d.gesture.commit();
    }
    this.preview = null;
    this.updateCursor();
    this.invalidate('clips', 'overlay');
  }

  private cancelDrag(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.kind === 'paint' || d.kind === 'erase') d.gesture.cancel();
    this.preview = null;
    this.invalidate('clips', 'overlay');
  }

  private onDoubleClick(e: MouseEvent): void {
    const p = this.project();
    const { x, y } = this.local(e);
    const hit = this.hitTest(x, y, p);
    if (hit?.clip.kind === 'pattern') {
      // FL: double-clicking a pattern clip opens that pattern.
      this.s.view.getState().setCurrentPattern(hit.clip.patternId);
      this.s.view.getState().showWindow('channel-rack', 'channel-rack');
    }
  }

  private paintAt(x: number, p: Project, e: { altKey: boolean }): void {
    const d = this.drag;
    if (d?.kind !== 'paint') return;
    const patternId = this.s.view.getState().currentPatternId;
    if (!patternId) return;
    const len = patternClipLength(p, patternId);
    const grid = Math.max(this.grid(p, e), 1);
    const tick = Math.max(0, snapFloor(this.vp.xToTick(x), grid));
    const from = Math.min(d.last, tick);
    const to = Math.max(d.last, tick);
    d.last = tick;
    const existing = clipsSorted(p.playlist.clips).filter((c) => c.laneId === d.lane);
    const add: Clip[] = [];
    for (let t = snapFloor(from, len); t <= to; t += len) {
      if (d.done.has(t) || existing.some((c) => c.start < t + len && c.start + c.length > t)) continue;
      d.done.add(t);
      const clip = this.currentPatternClip(p, d.lane, t);
      if (clip) add.push(clip);
    }
    if (add.length > 0) d.gesture.update((draft) => addClips(draft, add));
  }

  private eraseAt(x: number, y: number, p: Project): void {
    const d = this.drag;
    if (d?.kind !== 'erase') return;
    const hit = this.hitTest(x, y, p);
    if (!hit || d.done.has(hit.clip.id)) return;
    d.done.add(hit.clip.id);
    const id = hit.clip.id;
    d.gesture.update((draft) => removeClips(draft, [id]));
    this.hover = null;
  }

  private autoScroll(x: number, y: number, p: Project): void {
    const d = this.drag;
    if (!d || d.kind === 'pan') return;
    const edge = 24;
    let dx = 0;
    let dy = 0;
    if (x > this.vp.width - edge) dx = (x - (this.vp.width - edge)) * 0.8;
    else if (x < edge && this.vp.scrollTick > 0) dx = (x - edge) * 0.8;
    if (y > this.vp.height - edge) dy = (y - (this.vp.height - edge)) * 0.3;
    else if (y < edge) dy = (y - edge) * 0.3;
    if (dx || dy) {
      this.vp.scrollBy(dx, dy, this.maxTick(p));
      this.viewportChanged();
    }
  }

  // ---------------------------------------------------------------- headers, ruler, wheel

  private onHeaderDown(e: PointerEvent): void {
    const p = this.project();
    const { x, y } = this.local(e, this.els.headers);
    const lane = this.laneAtY(y, p);
    if (!lane) return;
    e.preventDefault();
    if (x < 24) {
      if (e.button === 2) this.s.history.transact('Solo track', (d) => toggleSoloLane(d, lane));
      else if (e.button === 0) {
        const muted = !!p.playlist.lanes[lane]?.muted;
        this.s.history.transact(muted ? 'Unmute track' : 'Mute track', (d) => setLaneProps(d, lane, { muted: !muted }));
      }
    }
  }

  private onHeaderDouble(e: MouseEvent): void {
    const p = this.project();
    const { x, y } = this.local(e, this.els.headers);
    const laneId = this.laneAtY(y, p);
    const lane = laneId ? p.playlist.lanes[laneId] : undefined;
    if (!lane || x < 24) return;
    const input = this.els.rename;
    const row = this.laneRow(p, lane.id);
    input.style.display = 'block';
    input.style.top = `${RULER_HEIGHT + this.vp.rowToY(row) + 4}px`;
    input.style.height = `${Math.max(16, this.vp.rowHeight - 8)}px`;
    input.value = lane.name;
    input.focus();
    input.select();
    const finish = (save: boolean) => {
      input.style.display = 'none';
      input.onblur = null;
      input.onkeydown = null;
      const name = input.value.trim();
      if (save && name && name !== lane.name)
        this.s.history.transact('Rename track', (d) => setLaneProps(d, lane.id, { name }));
    };
    input.onblur = () => finish(true);
    input.onkeydown = (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') finish(true);
      if (ev.key === 'Escape') finish(false);
    };
  }

  private onRulerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    this.els.ruler.setPointerCapture(e.pointerId);
    const p = this.project();
    const t = Math.max(
      0,
      snapRound(this.vp.xToTick(this.local(e, this.els.ruler).x), ticksPerBar(p.transport.timeSig) / 4),
    );
    this.drag = { kind: 'loop', t0: t, moved: false };
  }

  private onRulerMove(e: PointerEvent): void {
    const d = this.drag;
    if (d?.kind !== 'loop') return;
    const p = this.project();
    const t = Math.max(
      0,
      snapRound(this.vp.xToTick(this.local(e, this.els.ruler).x), ticksPerBar(p.transport.timeSig) / 4),
    );
    if (t === d.t0 && !d.moved) return;
    d.moved = true;
    this.s.view.getState().setLoop({ start: Math.min(d.t0, t), end: Math.max(d.t0, t) });
  }

  private onRulerUp(e: PointerEvent): void {
    const d = this.drag;
    if (d?.kind !== 'loop') return;
    this.els.ruler.releasePointerCapture(e.pointerId);
    this.drag = null;
    if (!d.moved) {
      // A click sets the song position (playback continues from there when playing).
      const v = this.s.view.getState();
      v.setSongStart(d.t0);
      if (v.mode !== 'song') v.setMode('song');
      if (this.s.engine.playing) this.s.engine.play(d.t0);
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.project();
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.vp.height : 1;
    const dx = e.deltaX * scale;
    const dy = e.deltaY * scale;
    const { x, y } = this.local(e);
    if (e.ctrlKey || e.metaKey) this.vp.zoomX(Math.exp(-dy * 0.01), Math.max(0, x));
    else if (e.altKey) this.vp.zoomY(Math.exp(-dy * 0.005), Math.max(0, y), 18, 120);
    else if (e.shiftKey) this.vp.scrollBy(dy || dx, 0, this.maxTick(p));
    else this.vp.scrollBy(dx, dy, this.maxTick(p));
    this.vp.clampScroll(this.maxTick(p));
    this.viewportChanged();
  }

  private onThumbDown(e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const thumb = this.els.hthumb;
    thumb.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startTick = this.vp.scrollTick;
    const total = this.maxTick(this.project());
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

  // ---------------------------------------------------------------- drag & drop from the browser

  private onDragOver(e: DragEvent): void {
    if (e.dataTransfer?.types.includes('application/x-agstudio-sound')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }

  private onDrop(e: DragEvent): void {
    const generator = e.dataTransfer?.getData('application/x-agstudio-sound');
    if (!generator) return;
    e.preventDefault();
    const p = this.project();
    const { x, y } = this.local(e);
    const lane = this.laneAtY(y, p);
    if (!lane) return;
    const tick = Math.max(0, snapFloor(this.vp.xToTick(x), this.grid(p)));
    this.onSampleDrop?.(generator, lane, tick);
  }
}
