/**
 * Imperative playlist editor (same architecture as the piano roll): canvases for lane headers,
 * ruler and clips, redrawn on the frame loop when dirty; geometry drags preview and commit once.
 */
import type { Services } from '@app/services';
import type { LiveTake } from '@app/audio-recorder';
import { describeMarker, jumpToMarker, moveMarkerTo, renameMarkerTo } from '@app/actions/markers';
import type { Gesture } from '@core/history/history';
import { pointBefore } from '@core/automation/curve';
import { tempoMapOf } from '@core/automation/tempo';
import { clipTickOffset } from '@core/model/clips';
import { newId } from '@core/model/ids';
import type {
  AudioClip,
  AutomationChannel,
  AutomationClip,
  ChannelId,
  Clip,
  ClipId,
  Lane,
  LaneId,
  MarkerId,
  PatternClip,
  Project,
  SampleRef,
  Tick,
} from '@core/model/types';
import { addAutomationPoint, moveAutomationPoint, setAutomationPointTension } from '@core/ops/automation';
import { setAudioClipEdits } from '@core/ops/audio-edits';
import { clipGain, dbToGain, formatDb, formatSeconds, gainToDb, MAX_CLIP_GAIN, type ClipLevels } from '@core/audio/envelope';
import { playbackMode, sourceSecondsAt, tickAtSourceSeconds } from '@core/audio/playback';
import { markersSorted } from '@core/ops/markers';
import { addClips, editClips, removeClips, setLaneProps, splitClip, toggleSoloLane } from '@core/ops/playlist';
import { clipAt, clipsInRect, clipsSorted, mutedLanes, patternClipLength, songLength } from '@core/query/playlist';
import { sectionMatching, songSections } from '@core/query/sections';
import { barSpan } from '@core/time/bars';
import { formatBST, ticksPerBar } from '@core/time/ppq';
import { gridTicks, snapFloor, snapRound } from '@core/time/snap';
import { emitHint } from '@agstudio/sdk/ui';
import { onFrame } from '../../frame-loop';
import {
  AUTO_HINTS,
  contentToTick,
  drawReadout,
  hitAutomation,
  tickToContent,
  yToValue,
  type AutoDraw,
  type AutoHit,
} from './automation';
import { clipBox, type ClipBox } from './clip-geometry';
import { alpha, fitCanvas, inkOn, mix, onThemeChange, readTheme, roundRectPath } from '../../timeline/canvas';
import { clipPaint } from './clip-paint';
import { clamp, Viewport } from '../../timeline/viewport';
import {
  CLIP_MENU_MIN_WIDTH,
  CLIP_MENU_SIZE,
  drawClips,
  drawLaneHeaders,
  drawLanesGrid,
  drawMarkerLines,
  drawPlaylistRuler,
  HEADER_WIDTH,
  MARKER_LANE_Y,
  markerAtX,
  RULER_HEIGHT,
  type MarkerBox,
  CLIP_RADIUS,
  clipColorOf,
} from './render';
import { markerRename } from './markers';
import { askPillPlace, pillText, PILL_HEIGHT, type PillTarget } from './ask-pill';
import { studioMarkSvg } from '../../controls/studio-mark';
import { hitAudioHandle, type AudioHandle } from './audio-clip';
import { dragMayHaveAudio, takeAudioFiles } from '../../audio-drag';

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
  /** Inline rename field for markers on the ruler. */
  markerRename: HTMLInputElement;
  /** The Ask AI pill over the selection or the loop region (moved on dirty frames). */
  askPill: HTMLElement;
}

/** A rect in client pixels. */
export interface ClientBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
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
  | { kind: 'loop'; t0: Tick; moved: boolean }
  | { kind: 'marker'; id: MarkerId; x0: number; grab: number; tick: Tick; moved: boolean }
  | { kind: 'level'; clip: AudioClip; handle: AudioHandle; x0: number; y0: number; start: ClipLevels; now: ClipLevels }
  | {
      kind: 'point';
      gesture: Gesture;
      clip: AutomationClip;
      channelId: ChannelId;
      index: number;
      readout: { x: number; y: number; text: string } | null;
    }
  | {
      kind: 'tension';
      gesture: Gesture;
      clip: AutomationClip;
      channelId: ChannelId;
      index: number;
      y0: number;
      t0: number;
      /** +1 when dragging up bends a falling segment's curve up, −1 for a rising one. */
      sign: number;
      readout: { x: number; y: number; text: string } | null;
    };

/** What the pointer is over inside an automation clip. */
interface AutoTarget {
  clip: AutomationClip;
  ch: AutomationChannel;
  box: ClipBox;
  hit: AutoHit;
}

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
  /** The automation clip part under the pointer (its points show, the hint bar explains it). */
  private autoHover: { clipId: ClipId; hit: AutoHit } | null = null;
  private lastHint: string | null = null;
  /** Marker flags as last drawn on the ruler, the one under the pointer, and one being dragged. */
  private markerBoxes: MarkerBox[] = [];
  private markerHot: MarkerId | null = null;
  /** The pointer is on the hot marker's Studio mark. */
  private markerAskHot = false;
  private markerDrag: { id: MarkerId; tick: Tick } | null = null;
  /** The Ask AI pill's text as last set, and its width for that text. */
  private pillLabel = '';
  private pillWidth = 0;
  /** The audio clip gain/fade handle under the pointer. */
  private audioHot: { clipId: ClipId; handle: AudioHandle } | null = null;

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
      // A sample finished decoding: its clips can show their waveform now.
      s.engine.subscribe(() => this.invalidate('clips')),
      onThemeChange(() => this.invalidate('grid', 'clips', 'overlay', 'headers', 'ruler')),
      onFrame(() => this.frame()),
      // A take being recorded grows on the playlist.
      s.audioRecorder.live.subscribe(() => this.invalidate('overlay')),
      // Alt+T and "Rename…" ask for a marker's name right on the ruler.
      markerRename.subscribe(({ id }) => {
        if (!id) return;
        markerRename.setState({ id: null });
        // After the new marker is drawn, so the field sits on its flag.
        requestAnimationFrame(() => this.renameMarker(id));
      }),
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
      if (!this.drag && this.autoHover) {
        this.autoHover = null;
        this.lastHint = null;
        this.invalidate('clips');
      }
    });
    for (const el of [host, els.headers, els.ruler]) on(el, 'wheel', (e) => this.onWheel(e), { passive: false });
    on(els.headers, 'pointerdown', (e) => this.onHeaderDown(e));
    on(els.headers, 'dblclick', (e) => this.onHeaderDouble(e));
    on(els.headers, 'contextmenu', (e) => e.preventDefault());
    on(els.ruler, 'pointerdown', (e) => this.onRulerDown(e));
    on(els.ruler, 'pointermove', (e) => this.onRulerMove(e));
    on(els.ruler, 'pointerup', (e) => this.onRulerUp(e));
    on(els.ruler, 'pointercancel', () => this.cancelDrag());
    on(els.ruler, 'contextmenu', (e) => e.preventDefault());
    on(els.ruler, 'pointerleave', () => this.setMarkerHot(null));
    on(els.ruler, 'dblclick', (e) => this.onRulerDouble(e));
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
  /** Audio files dropped from the sample browser or the desktop. */
  onFilesDrop?: (files: Promise<File[]>, laneId: LaneId, tick: Tick) => void;

  /** The ▾ menu of a clip was clicked. */
  onClipMenu?: (clip: Clip, at: { clientX: number; clientY: number }) => void;
  /** An automation point was right-clicked. */
  onPointMenu?: (clip: AutomationClip, index: number, at: { clientX: number; clientY: number }) => void;
  /** A track name was right-clicked. */
  onLaneMenu?: (laneId: LaneId, at: { clientX: number; clientY: number }) => void;
  /** A marker on the ruler was right-clicked. */
  onMarkerMenu?: (id: MarkerId, at: { clientX: number; clientY: number }) => void;
  /** An empty spot of the ruler was right-clicked (at a snapped song tick). */
  onRulerMenu?: (tick: Tick, at: { clientX: number; clientY: number }) => void;
  /** A marker flag's Studio mark was clicked: ask the AI about its section. */
  onMarkerAsk?: (id: MarkerId, at: { clientX: number; clientY: number }) => void;

  private readonly waveform = (ref: SampleRef) => this.s.engine.waveform(ref);

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
      const markers = { markers: markersSorted(p), hot: this.markerHot, hotAsk: this.markerAskHot, drag: this.markerDrag };
      if (this.dirty.has('grid')) {
        const g = fitCanvas(els.grid, vp.width, vp.height);
        drawLanesGrid(g, vp, theme, ts, vp.rows, songLength(p));
        drawMarkerLines(g, vp, markers, theme);
      }
      if (this.dirty.has('clips')) {
        const ctx = fitCanvas(els.clips, vp.width, vp.height);
        ctx.clearRect(0, 0, vp.width, vp.height);
        const laneIndex = new Map(p.playlist.laneOrder.map((id, i) => [id, i]));
        const selected = new Set(this.s.editor.getState().clipSelection);
        const d = this.drag;
        const hideOriginals = this.preview && (d?.kind === 'resize' || (d?.kind === 'move' && !d.duplicate));
        const skip = hideOriginals ? new Set(this.preview?.map((c) => c.id)) : undefined;
        const label = (c: Clip) => (c.kind === 'automation' ? this.autoLabel(c, p) : undefined);
        const automation = (c: AutomationClip) => this.autoDraw(c, p, selected);
        const audio = this.audioStyle(selected);
        drawClips(
          ctx,
          vp,
          theme,
          p,
          clipsSorted(p.playlist.clips),
          laneIndex,
          { selected, waveform: this.waveform, label, automation, ...audio, ...(skip ? { skip } : {}) },
          muted,
        );
        if (this.preview) {
          const sel = new Set(this.preview.map((c) => c.id));
          drawClips(
            ctx,
            vp,
            theme,
            p,
            this.preview,
            laneIndex,
            {
              selected: sel,
              waveform: this.waveform,
              label,
              automation: (c) => this.autoDraw(c, p, sel),
              ...this.audioStyle(sel),
            },
            muted,
          );
        }
      }
      if (this.dirty.has('overlay')) this.drawOverlay();
      if (this.dirty.has('headers')) {
        drawLaneHeaders(fitCanvas(els.headers, HEADER_WIDTH, vp.height), vp, theme, this.lanes(p), muted, HEADER_WIDTH);
      }
      if (this.dirty.has('ruler')) {
        this.markerBoxes = drawPlaylistRuler(
          fitCanvas(els.ruler, vp.width, RULER_HEIGHT),
          vp,
          theme,
          ts,
          this.s.view.getState().loop,
          songLength(p),
          markers,
        );
      }
      this.updateScrollbar(p);
      this.updateAskPill(p);
      this.dirty.clear();
    }
    // A take being recorded grows every frame.
    if (this.s.audioRecorder.live.getState().take) this.invalidate('overlay');
    this.updatePlayhead();
  }

  /** The take being recorded: a red clip from where it started to now, with its waveform so far. */
  private drawLiveTake(ctx: CanvasRenderingContext2D, live: LiveTake): void {
    const { vp } = this;
    const p = this.project();
    const theme = readTheme();
    const x0 = vp.tickToX(live.start);
    const x1 = Math.max(x0 + 2, vp.tickToX(Math.max(live.start, live.now)));
    const y = vp.rowToY(live.lane) + 1;
    const h = vp.rowHeight - 2;
    if (x1 < 0 || x0 > vp.width || y > vp.height || y + h < 0) return;
    ctx.beginPath();
    roundRectPath(ctx, x0, y, x1 - x0, h, CLIP_RADIUS);
    ctx.fillStyle = alpha(theme.danger, 0.24);
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = alpha(theme.danger, 0.8);
    ctx.fillRect(x0, y, x1 - x0, Math.min(13, h));
    ctx.restore();
    ctx.strokeStyle = theme.danger;
    ctx.beginPath();
    roundRectPath(ctx, x0 + 0.5, y + 0.5, x1 - x0 - 1, h - 1, CLIP_RADIUS);
    ctx.stroke();
    const tempo = tempoMapOf(p, 'song');
    const seconds = Math.max(0, tempo.tickToSeconds(live.now) - tempo.tickToSeconds(live.start));
    ctx.font = `600 10px ${theme.font}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = inkOn(theme.danger, theme);
    ctx.fillText(`● Recording… ${seconds.toFixed(1)} s`, x0 + 4, y + 7, Math.max(0, x1 - x0 - 8));
    const c = live.capture;
    const bodyY = y + 14;
    const bodyH = h - 16;
    if (bodyH < 4 || c.buckets === 0) return;
    const mid = bodyY + bodyH / 2;
    const startSec = tempo.tickToSeconds(live.start);
    ctx.fillStyle = mix(theme.danger, theme.text, 0.35);
    for (let px = Math.max(0, Math.floor(x0)); px < Math.min(vp.width, x1); px++) {
      const a = live.startFrame + (tempo.tickToSeconds(vp.xToTick(px)) - startSec) * c.sampleRate;
      const b = live.startFrame + (tempo.tickToSeconds(vp.xToTick(px + 1)) - startSec) * c.sampleRate;
      const b0 = Math.max(0, Math.floor(a / c.bucket));
      const b1 = Math.min(c.buckets, Math.max(b0 + 1, Math.ceil(b / c.bucket)));
      let lo = 0;
      let hi = 0;
      for (let k = b0; k < b1; k++) {
        lo = Math.min(lo, c.peaks[k * 2] as number);
        hi = Math.max(hi, c.peaks[k * 2 + 1] as number);
      }
      const top = Math.max(bodyY, mid - hi * (bodyH / 2));
      ctx.fillRect(px, top, 1, Math.max(1, Math.min(bodyY + bodyH, mid - lo * (bodyH / 2)) - top));
    }
  }

  /** The clip under the pointer lifts a little: a brighter edge around it. */
  private drawHoverEdge(ctx: CanvasRenderingContext2D, clip: Clip): void {
    const p = this.project();
    const box = this.boxOf(clip, p);
    if (!box || this.s.editor.getState().clipSelection.includes(clip.id)) return;
    const theme = readTheme();
    const base = clipColorOf(p, clip, theme);
    ctx.strokeStyle = clipPaint(base, theme).hoverEdge;
    ctx.beginPath();
    roundRectPath(ctx, box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1, CLIP_RADIUS - 0.5);
    ctx.stroke();
  }

  private drawOverlay(): void {
    const { vp, els } = this;
    const ctx = fitCanvas(els.overlay, vp.width, vp.height);
    ctx.clearRect(0, 0, vp.width, vp.height);
    const live = this.s.audioRecorder.live.getState().take;
    if (live) this.drawLiveTake(ctx, live);
    const d = this.drag;
    if (!d && this.hover) this.drawHoverEdge(ctx, this.hover.clip);
    if (d?.kind === 'marquee') {
      const theme = readTheme();
      const x = Math.min(d.x0, d.x1);
      const y = Math.min(d.y0, d.y1);
      ctx.fillStyle = theme.selectTint;
      ctx.strokeStyle = theme.select;
      ctx.fillRect(x, y, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    } else if (this.hover && !d && this.s.editor.getState().playlist.tool === 'slice' && this.sliceX >= 0) {
      const row = this.laneRow(this.project(), this.hover.clip.laneId);
      ctx.fillStyle = readTheme().danger;
      ctx.fillRect(Math.round(this.sliceX), vp.rowToY(row), 1, vp.rowHeight);
    } else if ((d?.kind === 'point' || d?.kind === 'tension') && d.readout) {
      // The value being set, in its units (and where).
      drawReadout(ctx, readTheme(), d.readout.x, d.readout.y, d.readout.text, vp);
    }
  }

  // ---------------------------------------------------------------- automation clips

  private autoChannel(c: AutomationClip, p: Project): AutomationChannel | null {
    const ch = p.channels[c.channelId];
    return ch?.kind === 'automation' ? ch : null;
  }

  /** What an automation clip shows as its title: what it drives ("Cutoff · 3xOsc"). */
  private autoLabel(c: AutomationClip, p: Project): string | undefined {
    const ch = this.autoChannel(c, p);
    return ch ? this.s.automation.labelOf(ch, p) : undefined;
  }

  private autoDraw(c: AutomationClip, p: Project, selected: ReadonlySet<ClipId>): AutoDraw {
    const ch = this.autoChannel(c, p);
    const d = this.drag;
    const dragging = (d?.kind === 'point' || d?.kind === 'tension') && d.clip.id === c.id;
    const hovered = this.autoHover?.clipId === c.id;
    const hot: AutoHit | null = dragging
      ? { part: d.kind === 'point' ? 'point' : 'handle', index: d.index }
      : hovered
        ? (this.autoHover?.hit ?? null)
        : null;
    let note: string | null = null;
    let noteIsWarning = false;
    if (ch && (!ch.target || this.s.automation.nameOf(ch.target, p) === null)) {
      note = 'Drives nothing: what it controlled was deleted';
      noteIsWarning = true;
    } else if (ch && ch.points.length <= 2 && ch.points.every((pt) => pt.value === ch.points[0]?.value)) {
      note = 'Flat: double-click to add points';
    }
    return { showPoints: selected.has(c.id) || hovered || dragging, hot, note, noteIsWarning };
  }

  private boxOf(c: Clip, p: Project): ClipBox | null {
    const row = this.laneRow(p, c.laneId);
    return row < 0 ? null : clipBox(this.vp, row, c);
  }

  /** The automation clip part at (x, y), when `hit` is an automation clip and the tool edits clips. */
  private autoAt(hit: Hit | null, x: number, y: number, p: Project): AutoTarget | null {
    const tool = this.s.editor.getState().playlist.tool;
    if (!hit || hit.clip.kind !== 'automation' || tool === 'delete' || tool === 'slice') return null;
    const ch = this.autoChannel(hit.clip, p);
    const box = this.boxOf(hit.clip, p);
    if (!ch || !box) return null;
    const h = hitAutomation(this.vp, hit.clip, ch, box, x, y);
    return h ? { clip: hit.clip, ch, box, hit: h } : null;
  }

  /** Hover inside automation clips: points show, the cursor and the hint bar explain what a drag does. */
  private updateAutoHover(hit: Hit | null, x: number, y: number, p: Project): void {
    const at = this.autoAt(hit, x, y, p);
    let next: { clipId: ClipId; hit: AutoHit } | null = null;
    let hint: string | null = null;
    if (at) {
      const label = this.s.automation.labelOf(at.ch, p);
      const editable = at.hit.part === 'point' || at.hit.part === 'handle' || hit?.zone === 'body';
      next = editable ? { clipId: at.clip.id, hit: at.hit } : null;
      hint = !editable
        ? AUTO_HINTS.title(label)
        : at.hit.part === 'curve'
          ? AUTO_HINTS.curve(label)
          : at.hit.part === 'small'
            ? AUTO_HINTS.small
            : AUTO_HINTS[at.hit.part];
    } else if (hit?.clip.kind === 'automation') {
      const ch = this.autoChannel(hit.clip, p);
      if (ch) hint = AUTO_HINTS.title(this.s.automation.labelOf(ch, p));
    }
    const a = this.autoHover;
    const same =
      a === next ||
      (!!a &&
        !!next &&
        a.clipId === next.clipId &&
        a.hit.part === next.hit.part &&
        ('index' in a.hit ? a.hit.index : -1) === ('index' in next.hit ? next.hit.index : -1));
    if (!same) {
      this.autoHover = next;
      this.invalidate('clips');
      this.updateCursor();
    }
    if (hint !== this.lastHint) {
      this.lastHint = hint;
      emitHint(this.els.gridHost, hint ?? this.els.gridHost.getAttribute('data-hint') ?? '');
    }
  }

  /** Song tick and content tick under x (on the grid unless Alt), kept inside the clip. */
  private autoTickAt(clip: AutomationClip, x: number, p: Project, e: { altKey: boolean }): Tick {
    const song = Math.max(0, snapRound(this.vp.xToTick(x), this.grid(p, e)));
    return clamp(tickToContent(clip, song), clip.offset, clip.offset + clip.length);
  }

  private pointText(ch: AutomationChannel, clip: AutomationClip, tick: Tick, value: number, p: Project): string {
    const v = ch.target ? this.s.automation.format(ch.target, value, ch.range) : `${Math.round(value * 100)}%`;
    return `${v} · ${formatBST(contentToTick(clip, tick), p.transport.timeSig)}`;
  }

  /** Adds a point under the pointer (it takes the shape of the stretch it lands in). */
  private addAutoPoint(at: AutoTarget, x: number, y: number, p: Project, e: { altKey: boolean }): void {
    const tick = this.autoTickAt(at.clip, x, p, e);
    const value = yToValue(y, at.box);
    const before = pointBefore(at.ch.points, tick);
    const shape = before >= 0 ? at.ch.points[before]?.shape : undefined;
    const id = at.ch.id;
    this.s.history.transact('Add automation point', (d) => {
      addAutomationPoint(d, id, { tick, value, ...(shape ? { shape } : {}) });
    });
    this.s.editor.getState().selectClips([at.clip.id]);
    emitHint(this.els.gridHost, `Added a point: ${this.pointText(at.ch, at.clip, tick, value, p)} · drag it to adjust`);
  }

  private dragAutoPoint(d: Extract<Drag, { kind: 'point' }>, x: number, y: number, e: PointerEvent): void {
    const p = this.project();
    const box = this.boxOf(d.clip, p);
    if (!box) return;
    const tick = this.autoTickAt(d.clip, x, p, e);
    const value = yToValue(y, box);
    d.gesture.update((dr) => moveAutomationPoint(dr, d.channelId, d.index, tick, value));
    const now = this.project();
    const ch = this.autoChannel(d.clip, now);
    const pt = ch?.points[d.index];
    if (!ch || !pt) return;
    const text = this.pointText(ch, d.clip, pt.tick, pt.value, now);
    d.readout = { x, y, text };
    emitHint(this.els.gridHost, `${this.s.automation.labelOf(ch, now)}: ${text}`);
    this.invalidate('overlay');
  }

  private dragAutoTension(d: Extract<Drag, { kind: 'tension' }>, x: number, y: number): void {
    const t = clamp(d.t0 + ((d.y0 - y) / 60) * d.sign, -1, 1);
    const tension = Math.abs(t) < 0.02 ? 0 : t;
    d.gesture.update((dr) => setAutomationPointTension(dr, d.channelId, d.index, tension));
    const text = tension === 0 ? 'Straight' : `Bend ${Math.round(Math.abs(tension) * 100)}%`;
    d.readout = { x, y, text };
    emitHint(this.els.gridHost, `Curve: ${text} · drag up or down · double-click to straighten`);
    this.invalidate('overlay');
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

  /** The part the Ask AI pill belongs to (the selected clips, else the loop region), in grid pixels, with its hint. */
  private askTarget(p: Project): (PillTarget & { hint: string }) | null {
    const { vp } = this;
    const ts = p.transport.timeSig;
    let start = Infinity;
    let end = -Infinity;
    let r0 = Infinity;
    let r1 = -Infinity;
    let n = 0;
    for (const id of this.s.editor.getState().clipSelection) {
      const c = p.playlist.clips[id];
      const row = c ? this.laneRow(p, c.laneId) : -1;
      if (!c || row < 0) continue;
      start = Math.min(start, c.start);
      end = Math.max(end, c.start + c.length);
      r0 = Math.min(r0, row);
      r1 = Math.max(r1, row);
      n++;
    }
    if (n > 0) {
      const span = barSpan(start, end, ts);
      return {
        x0: vp.tickToX(start),
        x1: vp.tickToX(end),
        y0: vp.rowToY(r0),
        y1: vp.rowToY(r1) + vp.rowHeight,
        compact: n === 1,
        hint:
          n === 1
            ? `Ask the AI to change this clip (${span}), Alt+A: only it changes`
            : `Ask the AI to change the ${n} selected clips (${span}), Alt+A: only they change`,
      };
    }
    const loop = this.s.view.getState().loop;
    if (!loop || loop.end <= loop.start) return null;
    const section = sectionMatching(p, loop.start, loop.end);
    const span = barSpan(loop.start, loop.end, ts);
    return {
      x0: vp.tickToX(loop.start),
      x1: vp.tickToX(loop.end),
      y0: 0,
      y1: 0,
      compact: false,
      hint: `Ask the AI to change ${section ? `${section.name} (${span})` : span}, Alt+A: only those bars change`,
    };
  }

  /** Moves the Ask AI pill (dirty frames only); hidden while dragging and when there is nothing to ask about. */
  private updateAskPill(p: Project): void {
    const el = this.els.askPill;
    const t = this.drag ? null : this.askTarget(p);
    const hide = () => {
      if (el.style.display !== 'none') el.style.display = 'none';
    };
    if (!t) return hide();
    const text = pillText(t);
    if (el.style.display === 'none') el.style.display = '';
    if (text !== this.pillLabel || !this.pillWidth) {
      // The Studio mark, then the label (fixed strings: no user text goes into the markup).
      el.innerHTML = studioMarkSvg(13) + (text ? `<span>${text}</span>` : '');
      this.pillLabel = text;
      this.pillWidth = el.offsetWidth;
    }
    if (el.getAttribute('data-hint') !== t.hint) el.setAttribute('data-hint', t.hint);
    const at = askPillPlace(t, { w: this.pillWidth || 64, h: PILL_HEIGHT }, { w: this.vp.width, h: this.vp.height });
    if (!at) return hide();
    el.style.transform = `translate(${HEADER_WIDTH + at.x}px, ${RULER_HEIGHT + at.y}px)`;
  }

  /** The Ask AI pill on screen (null while it is hidden). */
  pillBox(): ClientBox | null {
    const el = this.els.askPill;
    if (el.style.display === 'none') return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 ? r : null;
  }

  /** A marker's flag on screen (null when it is scrolled away or the playlist is hidden). */
  markerBox(id: MarkerId): ClientBox | null {
    const b = this.markerBoxes.find((x) => x.id === id);
    const r = this.els.ruler.getBoundingClientRect();
    if (!b || r.width === 0) return null;
    const x0 = Math.max(0, b.x0);
    const x1 = Math.min(this.vp.width, b.x1);
    if (x1 <= x0) return null;
    return { left: r.left + x0, top: r.top + MARKER_LANE_Y, right: r.left + x1, bottom: r.top + RULER_HEIGHT };
  }

  /** A span of the song on the ruler (null when it is scrolled away or the playlist is hidden). */
  spanBox(from: Tick, to: Tick): ClientBox | null {
    const r = this.els.ruler.getBoundingClientRect();
    const x0 = Math.max(0, this.vp.tickToX(from));
    const x1 = Math.min(this.vp.width, this.vp.tickToX(to));
    if (r.width === 0 || x1 <= x0) return null;
    return { left: r.left + x0, top: r.top, right: r.left + x1, bottom: r.bottom };
  }

  /** Scrolls so the span starts on screen (a little in from the left edge); true when it scrolled or already showed it. */
  revealSpan(from: Tick, to: Tick): boolean {
    if (this.els.ruler.getBoundingClientRect().width === 0) return false;
    const visible = this.vp.width / this.vp.pxPerTick;
    const start = this.vp.scrollTick;
    if (from >= start && Math.min(to, from + visible * 0.5) <= start + visible) return true;
    const total = this.maxTick(this.project());
    this.vp.scrollTick = clamp(from - visible * 0.1, 0, Math.max(0, Math.max(total, to) - visible * 0.9));
    this.viewportChanged();
    return true;
  }

  /** Scrolls a marker's flag into view. */
  revealMarker(id: MarkerId): boolean {
    const m = this.project().playlist.markers[id];
    return m ? this.revealSpan(m.tick, m.tick + 1) : false;
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
    const auto = this.autoHover?.hit.part;
    const level = this.drag?.kind === 'level' ? this.drag.handle : this.audioHot?.handle;
    if (this.drag?.kind === 'pan' || this.drag?.kind === 'point') cursor = 'grabbing';
    else if (this.drag?.kind === 'tension') cursor = 'ns-resize';
    else if (level === 'gain' && tool !== 'delete' && tool !== 'slice') cursor = 'ns-resize';
    else if (level && tool !== 'delete' && tool !== 'slice') cursor = 'ew-resize';
    else if (tool === 'delete') cursor = 'not-allowed';
    else if (auto === 'point') cursor = 'grab';
    else if (auto === 'handle') cursor = 'ns-resize';
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

    if (e.button === 0 && hit && this.onMenuButton(hit.clip, x, y, p)) {
      host.releasePointerCapture(e.pointerId);
      // A clip that is part of the selection keeps it (its menu can act on all of them).
      if (!editor.clipSelection.includes(hit.clip.id)) editor.selectClips([hit.clip.id]);
      this.onClipMenu?.(hit.clip, e);
      return;
    }
    // Automation clips: points and curve handles are edited in place.
    const auto = this.autoAt(hit, x, y, p);
    if (auto && e.button === 2 && auto.hit.part !== 'small') {
      host.releasePointerCapture(e.pointerId);
      if (auto.hit.part === 'point') {
        editor.selectClips([auto.clip.id]);
        this.onPointMenu?.(auto.clip, auto.hit.index, e);
      } else this.addAutoPoint(auto, x, y, p, e);
      return;
    }
    if (auto && e.button === 0 && (auto.hit.part === 'point' || auto.hit.part === 'handle')) {
      editor.selectClips([auto.clip.id]);
      const index = auto.hit.index;
      if (auto.hit.part === 'point') {
        this.drag = {
          kind: 'point',
          gesture: this.s.history.gesture('Move automation point'),
          clip: auto.clip,
          channelId: auto.ch.id,
          index,
          readout: null,
        };
      } else {
        const a = auto.ch.points[index];
        const b = auto.ch.points[index + 1];
        this.drag = {
          kind: 'tension',
          gesture: this.s.history.gesture('Bend automation curve'),
          clip: auto.clip,
          channelId: auto.ch.id,
          index,
          y0: y,
          t0: a?.tension ?? 0,
          sign: a && b && b.value > a.value ? -1 : 1,
          readout: null,
        };
      }
      this.updateCursor();
      this.invalidate('clips');
      return;
    }
    if (e.button === 2 || tool === 'delete') {
      this.startErase(x, y, p);
      return;
    }
    if (e.button !== 0) return;

    if (tool === 'slice') {
      if (hit) {
        const at = snapRound(this.vp.xToTick(x), this.grid(p, e));
        const tempo = tempoMapOf(p, 'song');
        this.s.history.transact('Slice clip', (d) => splitClip(d, hit.clip.id, at, tempo));
      }
      return;
    }

    // Audio clips: the gain and fade handles along the top of the body.
    const handle = hit && !mod ? this.audioHandleAt(hit, x, y, p) : null;
    if (hit?.clip.kind === 'audio' && handle) {
      editor.selectClips([hit.clip.id]);
      const clip = hit.clip;
      const levels: ClipLevels = { gain: clipGain(clip), fadeIn: clip.fadeIn ?? 0, fadeOut: clip.fadeOut ?? 0 };
      this.drag = { kind: 'level', clip, handle, x0: x, y0: y, start: levels, now: levels };
      this.updateCursor();
      this.invalidate('clips');
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
      this.updateAutoHover(hit, x, y, p);
      this.updateAudioHover(hit, x, y, p);
      return;
    }
    this.autoScroll(x, y, p);
    switch (d.kind) {
      case 'level':
        this.dragLevel(d, x, y, e);
        return;
      case 'point':
        this.dragAutoPoint(d, x, y, e);
        return;
      case 'tension':
        this.dragAutoTension(d, x, y);
        return;
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
          const minD = -Math.min(...d.originals.map((c) => Math.min(c.start, this.trimRoom(c, p))));
          dTick = clamp(dTick, minD, maxD);
          if (dTick === d.dTick) return;
          d.dTick = dTick;
          const tempo = tempoMapOf(p, 'song');
          this.preview = d.originals.map((c) =>
            c.kind === 'audio'
              ? {
                  ...c,
                  start: c.start + dTick,
                  length: c.length - dTick,
                  // The trim follows the clip's playback (pitch, tempo follow), so the audio stays put.
                  offsetSec: Math.max(0, sourceSecondsAt(c, this.modeOf(c, p), tempo, c.start + dTick)),
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
    } else if (d.kind === 'paint' || d.kind === 'erase' || d.kind === 'point' || d.kind === 'tension') {
      d.gesture.commit();
    } else if (d.kind === 'level') {
      const { now, start, clip } = d;
      const changed = now.gain !== start.gain || now.fadeIn !== start.fadeIn || now.fadeOut !== start.fadeOut;
      const label = d.handle === 'gain' ? 'Clip gain' : d.handle === 'fadeIn' ? 'Fade in' : 'Fade out';
      if (changed) this.s.history.transact(label, (draft) => setAudioClipEdits(draft, clip.id, now));
    }
    this.preview = null;
    this.updateCursor();
    this.invalidate('clips', 'overlay');
  }

  private cancelDrag(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.kind === 'marker') {
      this.markerDrag = null;
      this.invalidate('ruler', 'grid');
    }
    if (d.kind === 'paint' || d.kind === 'erase' || d.kind === 'point' || d.kind === 'tension') d.gesture.cancel();
    this.preview = null;
    this.updateCursor();
    this.invalidate('clips', 'overlay');
  }

  private onDoubleClick(e: MouseEvent): void {
    const p = this.project();
    const { x, y } = this.local(e);
    const hit = this.hitTest(x, y, p);
    const handle = hit ? this.audioHandleAt(hit, x, y, p) : null;
    if (hit?.clip.kind === 'audio' && handle) {
      // Double-click a handle: back to 0 dB, or no fade.
      const id = hit.clip.id;
      const reset = handle === 'gain' ? { gain: 1 } : handle === 'fadeIn' ? { fadeIn: 0 } : { fadeOut: 0 };
      const label = handle === 'gain' ? 'Clip gain 0 dB' : handle === 'fadeIn' ? 'Remove fade in' : 'Remove fade out';
      this.s.history.transact(label, (d) => setAudioClipEdits(d, id, reset));
      return;
    }
    const auto = this.autoAt(hit, x, y, p);
    if (auto) {
      // Double-click: straighten a curve handle, or add a point on the curve.
      if (auto.hit.part === 'handle') {
        const { index } = auto.hit;
        const id = auto.ch.id;
        this.s.history.transact('Straighten curve', (d) => setAutomationPointTension(d, id, index, 0));
      } else if (auto.hit.part === 'curve') this.addAutoPoint(auto, x, y, p, e);
      return;
    }
    if (hit?.clip.kind === 'pattern') {
      // FL: double-clicking a pattern clip opens that pattern.
      this.s.view.getState().setCurrentPattern(hit.clip.patternId);
      this.s.view.getState().showWindow('channel-rack', 'channel-rack');
    }
  }

  // ---------------------------------------------------------------- audio clips

  private modeOf(c: AudioClip, p: Project) {
    const ch = p.channels[c.channelId];
    return playbackMode(ch?.kind === 'audioClip' ? ch : {});
  }

  /** How far left an audio clip's start can go before its trim reaches the sample's start (ticks). */
  private trimRoom(c: Clip, p: Project): number {
    if (c.kind !== 'audio') return clipTickOffset(c) ?? Infinity;
    const first = tickAtSourceSeconds(c, this.modeOf(c, p), tempoMapOf(p, 'song'), 0);
    return Math.max(0, Math.floor(c.start - first));
  }

  /** Gain, fades and handle state for drawing audio clips (a level drag previews its values). */
  private audioStyle(selected: ReadonlySet<ClipId>) {
    const d = this.drag;
    return {
      levels: (c: AudioClip): ClipLevels => (d?.kind === 'level' && d.clip.id === c.id ? d.now : c),
      audioHandles: (c: AudioClip) => {
        const dragging = d?.kind === 'level' && d.clip.id === c.id;
        const hot = dragging ? d.handle : this.audioHot?.clipId === c.id ? this.audioHot.handle : null;
        return { show: selected.has(c.id) || this.hover?.clip.id === c.id || dragging, hot };
      },
      stretching: (channelId: ChannelId) => this.s.engine.isStretching(channelId),
    };
  }

  /** The audio clip handle under the pointer (only with tools that edit clips). */
  private audioHandleAt(hit: Hit, x: number, y: number, p: Project): AudioHandle | null {
    const tool = this.s.editor.getState().playlist.tool;
    if (hit.clip.kind !== 'audio' || tool === 'delete' || tool === 'slice') return null;
    const box = this.boxOf(hit.clip, p);
    return box ? hitAudioHandle(this.vp, hit.clip, hit.clip, tempoMapOf(p, 'song'), box, x, y) : null;
  }

  private levelText(handle: AudioHandle, v: ClipLevels): string {
    if (handle === 'gain') return `Clip gain ${formatDb(v.gain ?? 1)} · drag up or down (Shift: fine) · double-click for 0 dB`;
    const s = handle === 'fadeIn' ? (v.fadeIn ?? 0) : (v.fadeOut ?? 0);
    const name = handle === 'fadeIn' ? 'Fade in' : 'Fade out';
    return `${name} ${s > 0 ? formatSeconds(s) : 'off'} · drag left or right · double-click to remove`;
  }

  private updateAudioHover(hit: Hit | null, x: number, y: number, p: Project): void {
    const handle = hit ? this.audioHandleAt(hit, x, y, p) : null;
    const next = handle && hit ? { clipId: hit.clip.id, handle } : null;
    const a = this.audioHot;
    if (a?.clipId === next?.clipId && a?.handle === next?.handle) return;
    this.audioHot = next;
    this.invalidate('clips');
    this.updateCursor();
    if (next && hit?.clip.kind === 'audio') {
      const text = this.levelText(next.handle, hit.clip);
      this.lastHint = text;
      emitHint(this.els.gridHost, text);
    } else if (!this.autoHover) {
      this.lastHint = null;
      emitHint(this.els.gridHost, this.els.gridHost.getAttribute('data-hint') ?? '');
    }
  }

  /** Dragging a gain or fade handle: previews on the clip, one undo step on release. */
  private dragLevel(d: Extract<Drag, { kind: 'level' }>, x: number, y: number, e: PointerEvent): void {
    const p = this.project();
    const tempo = tempoMapOf(p, 'song');
    const clip = d.clip;
    const startSec = tempo.tickToSeconds(clip.start);
    const dur = tempo.tickToSeconds(clip.start + clip.length) - startSec;
    let now: ClipLevels;
    if (d.handle === 'gain') {
      // 0.2 dB per pixel (Shift: 0.02), −48 … +12 dB.
      const db0 = gainToDb(Math.max(1e-6, d.start.gain ?? 1));
      const db = clamp(db0 + ((d.y0 - y) * (e.shiftKey ? 0.02 : 0.2)), -48, 20 * Math.log10(MAX_CLIP_GAIN));
      const g = Math.abs(db) < 0.05 ? 1 : dbToGain(db);
      now = { ...d.start, gain: Math.round(g * 10000) / 10000 };
    } else {
      const tick = clamp(this.vp.xToTick(x), clip.start, clip.start + clip.length);
      const sec = tempo.tickToSeconds(tick) - startSec;
      const other = d.handle === 'fadeIn' ? (d.start.fadeOut ?? 0) : (d.start.fadeIn ?? 0);
      const len = clamp(d.handle === 'fadeIn' ? sec : dur - sec, 0, Math.max(0, dur - other));
      // Under 2 ms is no fade.
      const v = len < 0.002 ? 0 : Math.round(len * 10000) / 10000;
      now = d.handle === 'fadeIn' ? { ...d.start, fadeIn: v } : { ...d.start, fadeOut: v };
    }
    d.now = now;
    emitHint(this.els.gridHost, this.levelText(d.handle, now));
    this.invalidate('clips');
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

  private startErase(x: number, y: number, p: Project): void {
    this.drag = { kind: 'erase', gesture: this.s.history.gesture('Delete clips'), done: new Set() };
    this.eraseAt(x, y, p);
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
    // Points stay inside their clip: no scrolling while editing them.
    if (!d || d.kind === 'pan' || d.kind === 'point' || d.kind === 'tension' || d.kind === 'level') return;
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

  /** The ▾ button in a clip's title bar (FL's clip menu). */
  private onMenuButton(c: Clip, x: number, y: number, p: Project): boolean {
    const row = p.playlist.laneOrder.indexOf(c.laneId);
    if (row < 0 || c.length * this.vp.pxPerTick < CLIP_MENU_MIN_WIDTH) return false;
    const cx = this.vp.tickToX(c.start);
    const cy = this.vp.rowToY(row) + 1;
    return x >= cx && x < cx + CLIP_MENU_SIZE && y >= cy && y < cy + CLIP_MENU_SIZE;
  }

  private onHeaderDown(e: PointerEvent): void {
    const p = this.project();
    const { x, y } = this.local(e, this.els.headers);
    const lane = this.laneAtY(y, p);
    if (!lane) return;
    e.preventDefault();
    if (x >= 24 && e.button === 2) {
      this.onLaneMenu?.(lane, e);
      return;
    }
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
    if (laneId && x >= 24) this.renameLane(laneId);
  }

  /** Shows the inline rename field on a track header. */
  renameLane(laneId: LaneId): void {
    const p = this.project();
    const lane = p.playlist.lanes[laneId];
    if (!lane) return;
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

  /** The marker flag under a ruler position (markers live in the lower part of the ruler). */
  private markerHit(x: number, y: number): MarkerBox | null {
    return y >= MARKER_LANE_Y - 2 ? markerAtX(this.markerBoxes, x) : null;
  }

  /** Whether ruler x is on a flag's Studio mark. */
  private onAsk(b: MarkerBox | null, x: number): boolean {
    return !!b?.ask && x >= b.ask.x0 && x < b.ask.x1;
  }

  private setMarkerHot(id: MarkerId | null, ask = false): void {
    if (id === this.markerHot && ask === this.markerAskHot) return;
    this.markerHot = id;
    this.markerAskHot = ask;
    this.invalidate('ruler');
    this.els.ruler.style.cursor = ask ? 'pointer' : '';
    const p = this.project();
    const m = id ? p.playlist.markers[id] : undefined;
    const section = ask && id ? songSections(p).find((x) => x.markerId === id) : undefined;
    emitHint(
      this.els.ruler,
      m && section
        ? `Ask the AI about this section (${m.name}, ${barSpan(section.from, section.to, p.transport.timeSig)}): it loops and a box opens for your request`
        : m
          ? `Marker ${describeMarker(this.s, m)}: click to jump there, drag to move it, double-click to rename, right-click for more`
          : (this.els.ruler.getAttribute('data-hint') ?? ''),
    );
  }

  private onRulerDown(e: PointerEvent): void {
    const p = this.project();
    const { x, y } = this.local(e, this.els.ruler);
    const hit = this.markerHit(x, y);
    if (e.button === 2) {
      e.preventDefault();
      if (hit) this.onMarkerMenu?.(hit.id, e);
      else this.onRulerMenu?.(Math.max(0, snapRound(this.vp.xToTick(x), this.grid(p, e))), e);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    // The flag's Studio mark acts at once (like a clip's ▾): ask the AI about the section.
    if (hit && this.onAsk(hit, x)) {
      this.onMarkerAsk?.(hit.id, e);
      return;
    }
    this.els.ruler.setPointerCapture(e.pointerId);
    if (hit) {
      this.drag = { kind: 'marker', id: hit.id, x0: x, grab: this.vp.xToTick(x) - hit.tick, tick: hit.tick, moved: false };
      return;
    }
    const t = Math.max(0, snapRound(this.vp.xToTick(x), ticksPerBar(p.transport.timeSig) / 4));
    this.drag = { kind: 'loop', t0: t, moved: false };
  }

  private onRulerMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) {
      const { x, y } = this.local(e, this.els.ruler);
      const hit = this.markerHit(x, y);
      this.setMarkerHot(hit?.id ?? null, this.onAsk(hit, x));
      return;
    }
    if (d.kind === 'marker') {
      const p = this.project();
      const { x } = this.local(e, this.els.ruler);
      if (!d.moved && Math.abs(x - d.x0) < 3) return;
      d.moved = true;
      // Snapped to the playlist grid (Alt: free).
      d.tick = Math.max(0, snapRound(this.vp.xToTick(x) - d.grab, this.grid(p, e)));
      this.markerDrag = { id: d.id, tick: d.tick };
      const m = p.playlist.markers[d.id];
      if (m) emitHint(this.els.ruler, `Move ‘${m.name}’ to ${formatBST(d.tick, p.transport.timeSig)} · release to drop it`);
      this.invalidate('ruler', 'grid');
      return;
    }
    if (d.kind !== 'loop') return;
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
    if (d?.kind === 'marker') {
      this.els.ruler.releasePointerCapture(e.pointerId);
      this.drag = null;
      this.markerDrag = null;
      // A click on a marker sets the song position there; a drag moves it (one undo step).
      if (d.moved) moveMarkerTo(this.s, d.id, d.tick);
      else jumpToMarker(this.s, d.id);
      this.invalidate('ruler', 'grid');
      return;
    }
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

  private onRulerDouble(e: MouseEvent): void {
    const { x, y } = this.local(e, this.els.ruler);
    const hit = this.markerHit(x, y);
    // A double-click on the Studio mark is two clicks on it, not a rename.
    if (hit && this.onAsk(hit, x)) return;
    if (hit) this.renameMarker(hit.id);
    else this.s.view.getState().setLoop(null);
  }

  /** Shows the inline rename field on a marker's flag. */
  renameMarker(id: MarkerId): void {
    const m = this.project().playlist.markers[id];
    const box = this.markerBoxes.find((b) => b.id === id);
    if (!m) return;
    const input = this.els.markerRename;
    const x = box ? box.x0 + 3 : this.vp.tickToX(m.tick);
    input.style.display = 'block';
    input.style.left = `${HEADER_WIDTH + Math.max(0, Math.min(this.vp.width - 120, x))}px`;
    input.style.top = `${MARKER_LANE_Y}px`;
    input.style.height = `${RULER_HEIGHT - MARKER_LANE_Y - 1}px`;
    input.style.width = `${Math.max(120, box ? box.x1 - box.x0 : 0)}px`;
    input.value = m.name;
    input.focus();
    input.select();
    const finish = (save: boolean) => {
      input.style.display = 'none';
      input.onblur = null;
      input.onkeydown = null;
      if (save) renameMarkerTo(this.s, id, input.value);
    };
    input.onblur = () => finish(true);
    input.onkeydown = (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') finish(true);
      if (ev.key === 'Escape') finish(false);
    };
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
    const dt = e.dataTransfer;
    if (!dt) return;
    if (
      dt.types.includes('application/x-agstudio-sound') ||
      dt.types.includes('application/x-agstudio-pattern') ||
      dragMayHaveAudio(dt)
    ) {
      e.preventDefault();
      dt.dropEffect = 'copy';
    }
  }

  private onDrop(e: DragEvent): void {
    const dt = e.dataTransfer;
    const generator = dt?.getData('application/x-agstudio-sound');
    const patternId = dt?.getData('application/x-agstudio-pattern');
    // Must be read during the event: the DataTransfer is emptied afterwards.
    const files = !generator && !patternId && dt ? takeAudioFiles(dt) : null;
    if (!generator && !patternId && !files) return;
    e.preventDefault();
    const p = this.project();
    const { x, y } = this.local(e);
    const lane = this.laneAtY(y, p);
    if (!lane) return;
    const tick = Math.max(0, snapFloor(this.vp.xToTick(x), this.grid(p)));
    if (files) this.onFilesDrop?.(files, lane, tick);
    else if (generator) this.onSampleDrop?.(generator, lane, tick);
    else if (patternId && p.patterns[patternId as keyof typeof p.patterns]) {
      this.s.view.getState().setCurrentPattern(patternId as never);
      const clip = this.currentPatternClip(p, lane, tick);
      if (clip) {
        this.s.history.transact('Add clip', (d) => addClips(d, [clip]));
        this.s.editor.getState().selectClips([clip.id]);
      }
    }
  }
}
