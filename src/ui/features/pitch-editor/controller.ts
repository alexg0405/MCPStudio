/**
 * Imperative Pitch editor: owns the canvases, the viewport and the pointer, wheel and key handling.
 * React only renders the toolbar; data changes mark layers dirty and the shared frame loop redraws
 * them (nothing here runs per frame while the picture is still, except the playhead while playing).
 *
 * The viewport's "ticks" are milliseconds on the clip's sample timeline; its rows are MIDI notes.
 * A drag previews locally and commits one undo step on release.
 */
import type { Services } from '@app/services';
import { audioClipOf, editFor, mergeAt, moveNotes, resetNotes, splitAt, keyMask } from '@app/actions/pitch';
import { pitchState, type ClipPitch } from '@app/pitch/state';
import { tempoMapOf } from '@core/automation/tempo';
import { playbackMode, sourceSecondsAt } from '@core/audio/playback';
import { isNeutralEdit, noteIndexAt } from '@core/audio/pitch-edit';
import type { PitchEdit, Project } from '@core/model/types';
import type { TempoMap } from '@core/time/ppq';
import { noteName } from '@agstudio/sdk/notes';
import { onFrame } from '../../frame-loop';
import { fitCanvas, onThemeChange, readTheme } from '../../timeline/canvas';
import { clamp, Viewport } from '../../timeline/viewport';
import { curveMidi, dragTarget, drawNotes, hitNote, notesInRect, pitchText, rowForKey, type DrawNote } from './model';
import { drawContent, drawGrid, drawKeys, drawOverlay, drawRuler, type PitchScene } from './pitch-draw';
import { KEYS_WIDTH, RULER_HEIGHT, type Drag, type Layer, type PitchTool } from './pitch-types';

export { KEYS_WIDTH, RULER_HEIGHT, type PitchTool };

export interface PitchEditorElements {
  area: HTMLElement;
  stage: HTMLElement;
  ruler: HTMLCanvasElement;
  keys: HTMLCanvasElement;
  grid: HTMLCanvasElement;
  content: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  hscroll: HTMLElement;
  hthumb: HTMLElement;
}

export class PitchEditorController {
  readonly vp = new Viewport(128, 0.01, 1.5);
  /** The tool the toolbar chose. */
  tool: PitchTool = 'select';
  /** Whether drags snap to the chosen key's notes instead of every semitone. */
  private snapToScale = false;
  /** Shade the rows outside the chosen key. */
  private showScale = true;
  /** Set by the window: opens the note menu for a right-click (`index` −1 = empty space). */
  onMenu: ((index: number, ms: number, at: { clientX: number; clientY: number }) => void) | null = null;

  private dirty = new Set<Layer>(['grid', 'content', 'overlay', 'keys', 'ruler']);
  private drag: Drag | null = null;
  private hover = -1;
  private hoverMs = 0;
  private pointer: { x: number; y: number } | null = null;
  private unsubs: Array<() => void> = [];
  private clip: ClipPitch | null = null;
  private project: Project | null = null;
  private edit: PitchEdit | null = null;
  private notes: DrawNote[] = [];
  private sung: Float32Array | null = null;
  private corrected: Float32Array | null = null;
  /** The edit and analysis `corrected` was made from (the curve is only made again when one changes). */
  private correctedFrom: { edit: PitchEdit; analysis: ClipPitch['analysis'] } | null = null;
  private fitted: ClipPitch['analysis'] | null = null;
  private tempo: { project: Project; map: TempoMap } | null = null;
  private lastPlayheadMs = Number.NaN;
  private lastHint = '';
  private scrollTrackW = 1;

  constructor(
    private readonly s: Services,
    private readonly els: PitchEditorElements,
  ) {}

  // ---- Lifecycle ----

  mount(): void {
    const { stage, area } = this.els;
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.unsubs.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    on(stage, 'pointerdown', (e) => this.onPointerDown(e));
    on(stage, 'pointermove', (e) => this.onPointerMove(e));
    on(stage, 'pointerup', (e) => this.onPointerUp(e));
    on(stage, 'pointercancel', () => this.cancelDrag());
    on(stage, 'pointerleave', () => {
      if (!this.drag) this.setHover(-1);
      this.pointer = null;
      this.mark('overlay');
    });
    on(stage, 'wheel', (e) => this.onWheel(e), { passive: false });
    on(stage, 'contextmenu', (e) => this.onContext(e));
    on(stage, 'dblclick', (e) => this.onDoubleClick(e));
    on(area, 'keydown', (e) => this.onKey(e));
    on(this.els.keys, 'wheel', (e) => this.onWheel(e), { passive: false });
    on(this.els.ruler, 'wheel', (e) => this.onWheel(e), { passive: false });
    on(this.els.hthumb, 'pointerdown', (e) => this.onThumbDown(e));
    on(this.els.hscroll, 'pointerdown', (e) => this.onTrackDown(e));
    on(this.els.hscroll, 'pointermove', (e) => this.onPointerMove(e));
    on(this.els.hscroll, 'pointerup', (e) => this.onPointerUp(e));
    this.unsubs.push(
      pitchState.subscribe(() => this.onData()),
      this.s.doc.subscribe(() => this.onData()),
      onThemeChange(() => this.mark('grid', 'content', 'overlay', 'keys', 'ruler')),
      onFrame((now) => this.frame(now)),
    );
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(this.els.stage);
    this.unsubs.push(() => ro.disconnect());
    this.resize();
    this.onData();
  }

  unmount(): void {
    for (const off of this.unsubs.splice(0)) off();
  }

  setSnapToScale(on: boolean): void {
    this.snapToScale = on;
  }

  setShowScale(on: boolean): void {
    this.showScale = on;
    this.mark('grid', 'keys');
  }

  zoomBy(factor: number): void {
    this.vp.zoomX(factor, this.vp.width / 2);
    this.clampScroll();
    this.mark('grid', 'content', 'overlay', 'ruler');
  }

  /** Fits the whole analysed stretch in the view and the notes' range in height. */
  fit(): void {
    const c = this.clip;
    const vp = this.vp;
    if (!c || vp.width <= 0) return;
    const from = c.range.from * 1000;
    const to = Math.max(from + 1000, c.range.to * 1000);
    vp.pxPerTick = clamp(vp.width / (to - from), vp.minPxPerTick, vp.maxPxPerTick);
    vp.scrollTick = Math.max(0, from);
    const pitches = this.notes.map((n) => n.target);
    const lo = pitches.length ? Math.min(...pitches) : 55;
    const hi = pitches.length ? Math.max(...pitches) : 67;
    const mid = (lo + hi) / 2;
    const rows = Math.max(6, vp.height / vp.rowHeight);
    vp.scrollRow = clamp(rowForKey(mid) + 0.5 - rows / 2, 0, Math.max(0, vp.rows - rows));
    this.clampScroll();
    this.mark('grid', 'content', 'overlay', 'keys', 'ruler');
  }

  // ---- Data ----

  private mark(...layers: Layer[]): void {
    for (const l of layers) this.dirty.add(l);
  }

  private onData(): void {
    const st = pitchState.getState();
    const project = this.s.doc.getState().project;
    const clip = st.clip;
    const clipChanged = clip !== this.clip;
    this.clip = clip;
    this.project = project;
    if (!clip || !audioClipOf(project, clip.clipId)) {
      this.edit = null;
      this.notes = [];
      this.sung = null;
      this.corrected = null;
    } else {
      this.edit = editFor(project, clip);
      this.notes = drawNotes(this.edit);
      if (clipChanged || !this.sung) this.sung = curveMidi(clip.analysis, null);
      const same = this.correctedFrom?.edit === this.edit && this.correctedFrom?.analysis === clip.analysis;
      if (!same) {
        this.corrected = this.edit && !isNeutralEdit(this.edit) ? curveMidi(clip.analysis, this.edit) : null;
        this.correctedFrom = this.edit ? { edit: this.edit, analysis: clip.analysis } : null;
      }
    }
    if (clip && clip.analysis !== this.fitted) {
      this.fitted = clip.analysis;
      this.fit();
    }
    // Selection never points past the notes.
    const n = this.notes.length;
    if (st.selected.some((i) => i >= n)) pitchState.setState({ selected: st.selected.filter((i) => i < n) });
    this.mark('grid', 'content', 'overlay', 'keys');
  }

  private selected(): number[] {
    return pitchState.getState().selected;
  }

  private setSelected(list: number[]): void {
    const cur = this.selected();
    if (cur.length === list.length && cur.every((v, i) => v === list[i])) return;
    pitchState.setState({ selected: list });
    this.mark('content', 'overlay');
  }

  private setHover(i: number): void {
    if (i === this.hover) return;
    this.hover = i;
    this.mark('overlay');
    const n = this.notes[i];
    const hint = n
      ? `${pitchText(n.target, noteName)}${n.edited ? ` (sung ${pitchText(n.sung, noteName)})` : ''}: drag up or down to retune it (Alt: by cents), right-click for more`
      : '';
    if (hint !== this.lastHint) {
      this.lastHint = hint;
      this.s.session.getState().setHint(hint);
    }
  }

  // ---- Geometry ----

  private resize(): void {
    const { stage } = this.els;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (w === this.vp.width && h === this.vp.height) return;
    this.vp.width = w;
    this.vp.height = h;
    this.clampScroll();
    this.scrollTrackW = Math.max(1, this.els.hscroll.clientWidth);
    this.mark('grid', 'content', 'overlay', 'keys', 'ruler');
  }

  private maxMs(): number {
    return this.clip ? this.clip.range.to * 1000 + 300 : 1000;
  }

  private clampScroll(): void {
    this.vp.scrollBy(0, 0, this.maxMs());
    if (this.clip) this.vp.scrollTick = Math.max(Math.min(this.vp.scrollTick, this.maxMs()), 0);
  }

  private pitchAt(y: number): number {
    return 127.5 - this.vp.yToRow(y);
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.els.stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private tempoMap(p: Project): TempoMap {
    if (!this.tempo || this.tempo.project !== p) this.tempo = { project: p, map: tempoMapOf(p, 'song') };
    return this.tempo.map;
  }

  /** The song position as milliseconds on the sample timeline, NaN when nothing of this clip is playing. */
  private playheadMs(): number {
    const clip = this.clip;
    const p = this.project;
    if (!clip || !p || !this.s.engine.playing) return Number.NaN;
    const found = audioClipOf(p, clip.clipId);
    if (!found) return Number.NaN;
    const tick = this.s.engine.playhead();
    if (tick < found.clip.start || tick >= found.clip.start + found.clip.length) return Number.NaN;
    return 1000 * sourceSecondsAt(found.clip, playbackMode(found.channel), this.tempoMap(p), tick);
  }

  private keyMaskNow(): readonly boolean[] {
    const st = pitchState.getState();
    return keyMask(st.keyRoot, st.keyScale);
  }

  // ---- Pointer ----

  private onPointerDown(e: PointerEvent): void {
    this.els.area.focus({ preventScroll: true });
    const { x, y } = this.local(e);
    if (e.button === 1) {
      this.drag = { kind: 'pan', x: e.clientX, y: e.clientY };
      this.els.stage.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button !== 0 || !this.clip) return;
    const ms = this.vp.xToTick(x);
    const hit = hitNote(this.notes, ms, this.pitchAt(y));
    if (this.tool === 'split') {
      if (hit >= 0) splitAt(this.s, this.clip, ms / 1000);
      return;
    }
    this.els.stage.setPointerCapture(e.pointerId);
    if (hit >= 0) {
      const sel = this.selected();
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      let next = sel;
      if (additive) next = sel.includes(hit) ? sel.filter((i) => i !== hit) : [...sel, hit].sort((a, b) => a - b);
      else if (!sel.includes(hit)) next = [hit];
      this.setSelected(next);
      if (next.includes(hit)) {
        const n = this.notes[hit] as DrawNote;
        this.drag = { kind: 'move', y0: y, anchor: hit, anchorTarget: n.target, indices: next, delta: 0 };
      }
    } else {
      const base = e.shiftKey ? this.selected() : [];
      if (!e.shiftKey) this.setSelected([]);
      this.drag = { kind: 'marquee', x0: x, y0: y, x1: x, y1: y, base };
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const { x, y } = this.local(e);
    const d = this.drag;
    this.pointer = { x, y };
    if (!d) {
      const ms = this.vp.xToTick(x);
      this.hoverMs = ms;
      this.setHover(hitNote(this.notes, ms, this.pitchAt(y)));
      this.els.stage.style.cursor = this.tool === 'split' ? (this.hover >= 0 ? 'col-resize' : 'default') : this.hover >= 0 ? 'ns-resize' : 'default';
      this.mark('overlay');
      return;
    }
    if (d.kind === 'pan') {
      this.vp.scrollBy(-(e.clientX - d.x), -(e.clientY - d.y), this.maxMs());
      d.x = e.clientX;
      d.y = e.clientY;
      this.mark('grid', 'content', 'overlay', 'keys', 'ruler');
    } else if (d.kind === 'thumb') {
      this.scrollTo(d.scroll + ((e.clientX - d.x) / this.scrollTrackW) * this.maxMs());
    } else if (d.kind === 'move') {
      const semitones = -(y - d.y0) / this.vp.rowHeight;
      const target = dragTarget(d.anchorTarget, semitones, { free: e.altKey, mask: this.snapToScale ? this.keyMaskNow() : null });
      const delta = target - d.anchorTarget;
      if (delta !== d.delta) {
        d.delta = delta;
        this.refreshPreview();
      }
    } else {
      d.x1 = x;
      d.y1 = y;
      this.mark('overlay');
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    try {
      this.els.stage.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    if (!d) return;
    if (d.kind === 'move') {
      if (Math.abs(d.delta) > 1e-6 && this.clip) moveNotes(this.s, this.clip, d.indices, d.delta);
      else this.onData();
    } else if (d.kind === 'marquee') {
      const moved = Math.abs(d.x1 - d.x0) > 3 || Math.abs(d.y1 - d.y0) > 3;
      if (moved) {
        const a = this.vp.xToTick(Math.min(d.x0, d.x1));
        const b = this.vp.xToTick(Math.max(d.x0, d.x1));
        const lo = this.pitchAt(Math.max(d.y0, d.y1));
        const hi = this.pitchAt(Math.min(d.y0, d.y1));
        const inside = notesInRect(this.notes, a, b, lo, hi);
        this.setSelected([...new Set([...d.base, ...inside])].sort((p, q) => p - q));
      }
      this.mark('overlay');
    }
    this.mark('overlay');
  }

  private cancelDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    this.onData();
  }

  private refreshPreview(): void {
    const c = this.clip;
    const d = this.drag;
    if (!c || d?.kind !== 'move') return;
    const base = this.project ? editFor(this.project, c) : null;
    if (!base) return;
    const moving = new Set(d.indices);
    this.notes = drawNotes(base, d.delta, moving);
    const preview: PitchEdit = {
      ...base,
      notes: base.notes.map((n, i) => (moving.has(i) ? { ...n, shift: (n.shift ?? 0) + d.delta * 100 } : n)),
    };
    this.corrected = curveMidi(c.analysis, preview);
    this.correctedFrom = null; // the preview is not the edit: the next data change makes the real curve again
    this.mark('content', 'overlay');
  }

  private onDoubleClick(e: MouseEvent): void {
    // Double-click on a note picks it (and the notes of its phrase stay as they are).
    const { x, y } = this.local(e);
    const hit = hitNote(this.notes, this.vp.xToTick(x), this.pitchAt(y));
    if (hit >= 0) this.setSelected([hit]);
  }

  private onContext(e: MouseEvent): void {
    e.preventDefault();
    const { x, y } = this.local(e);
    const ms = this.vp.xToTick(x);
    const hit = hitNote(this.notes, ms, this.pitchAt(y));
    if (hit >= 0 && !this.selected().includes(hit)) this.setSelected([hit]);
    this.onMenu?.(hit, ms, e);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const vp = this.vp;
    const r = this.els.stage.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const unit = e.deltaMode === 1 ? 16 : 1;
    if (e.ctrlKey || e.metaKey) {
      vp.zoomX(Math.exp(-e.deltaY * unit * 0.0025), clamp(x, 0, vp.width));
      this.clampScroll();
    } else if (e.altKey) {
      vp.zoomY(Math.exp(-e.deltaY * unit * 0.0025), clamp(y, 0, vp.height), 8, 40);
    } else if (e.shiftKey) {
      vp.scrollBy((e.deltaY || e.deltaX) * unit, 0, this.maxMs());
    } else {
      vp.scrollBy(e.deltaX * unit, e.deltaY * unit, this.maxMs());
    }
    this.mark('grid', 'content', 'overlay', 'keys', 'ruler');
  }

  private onKey(e: KeyboardEvent): void {
    const sel = this.selected();
    const c = this.clip;
    if (!c) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') {
      if (this.drag) this.cancelDrag();
      else this.setSelected([]);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length > 0) {
      resetNotes(this.s, c, new Set(sel));
    } else if (mod && e.key.toLowerCase() === 'a') {
      this.setSelected(this.notes.map((n) => n.index));
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && sel.length > 0) {
      const step = (e.key === 'ArrowUp' ? 1 : -1) * (e.altKey ? 0.01 : 1);
      moveNotes(this.s, c, sel, step);
    } else if (e.key.toLowerCase() === 's' && !mod) {
      if (this.hover >= 0) splitAt(this.s, c, this.hoverMs / 1000);
    } else if (e.key.toLowerCase() === 'm' && !mod && sel.length > 0) {
      mergeAt(this.s, c, sel[0] as number);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  // ---- Scrolling ----

  private scrollTo(ms: number): void {
    this.vp.scrollTick = clamp(ms, 0, Math.max(0, this.maxMs() - this.vp.width / this.vp.pxPerTick));
    this.mark('grid', 'content', 'overlay', 'ruler');
  }

  private onThumbDown(e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    this.drag = { kind: 'thumb', x: e.clientX, scroll: this.vp.scrollTick };
    this.els.hscroll.setPointerCapture(e.pointerId);
  }

  private onTrackDown(e: PointerEvent): void {
    if (e.target === this.els.hthumb) return;
    const r = this.els.hscroll.getBoundingClientRect();
    const ms = ((e.clientX - r.left) / r.width) * this.maxMs();
    this.scrollTo(ms - this.vp.width / this.vp.pxPerTick / 2);
  }

  // ---- Drawing ----

  private frame(_now: number): void {
    if (!this.els.stage.isConnected) return;
    const playhead = this.playheadMs();
    if (!(playhead === this.lastPlayheadMs) && !(Number.isNaN(playhead) && Number.isNaN(this.lastPlayheadMs))) {
      this.lastPlayheadMs = playhead;
      this.mark('overlay');
      // Follow: keep the playhead in view while it plays.
      const x = this.vp.tickToX(playhead);
      if (!Number.isNaN(playhead) && !this.drag && (x > this.vp.width * 0.9 || x < 0)) {
        this.scrollTo(playhead - (this.vp.width * 0.15) / this.vp.pxPerTick);
        this.mark('grid', 'content', 'ruler');
      }
    }
    if (this.dirty.size === 0) return;
    const theme = readTheme();
    const vp = this.vp;
    vp.dpr = window.devicePixelRatio || 1;
    const scene = this.scene();
    if (this.dirty.has('grid')) drawGrid(fitCanvas(this.els.grid, vp.width, vp.height), theme, scene);
    if (this.dirty.has('content')) drawContent(fitCanvas(this.els.content, vp.width, vp.height), theme, scene);
    if (this.dirty.has('overlay')) drawOverlay(fitCanvas(this.els.overlay, vp.width, vp.height), theme, scene);
    if (this.dirty.has('keys')) drawKeys(fitCanvas(this.els.keys, KEYS_WIDTH, vp.height), theme, scene);
    if (this.dirty.has('ruler')) drawRuler(fitCanvas(this.els.ruler, vp.width, RULER_HEIGHT), theme, scene);
    this.dirty.clear();
    this.updateScrollbar();
  }

  /** What the layers draw from, as of now (made only when something is dirty, not on idle frames). */
  private scene(): PitchScene {
    const st = pitchState.getState();
    return {
      vp: this.vp,
      clip: this.clip,
      notes: this.notes,
      sung: this.sung,
      corrected: this.corrected,
      selected: new Set(st.selected),
      keyRoot: st.keyRoot,
      keyScale: st.keyScale,
      showScale: this.showScale,
      tool: this.tool,
      drag: this.drag,
      hover: this.hover,
      pointer: this.pointer,
      playheadMs: this.lastPlayheadMs,
    };
  }

  private updateScrollbar(): void {
    const total = this.maxMs();
    const visible = this.vp.width / this.vp.pxPerTick;
    const track = this.els.hscroll.clientWidth || 1;
    this.scrollTrackW = track;
    const w = clamp((visible / total) * track, 24, track);
    const left = total > visible ? (this.vp.scrollTick / (total - visible)) * (track - w) : 0;
    this.els.hthumb.style.width = `${w}px`;
    this.els.hthumb.style.transform = `translateX(${clamp(left, 0, track - w)}px)`;
  }

  /** The note index at a time (ms), or -1. */
  noteAt(ms: number): number {
    return this.edit ? noteIndexAt(this.edit, ms / 1000) : -1;
  }
}
