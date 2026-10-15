/** Playlist drawing: lanes, clips (with pattern note previews), lane headers and the ruler. */
import type {
  AudioClip,
  AutomationClip,
  ChannelId,
  Clip,
  ClipId,
  Lane,
  LaneId,
  Marker,
  MarkerId,
  Note,
  Pattern,
  PatternClip,
  Project,
  SampleRef,
  Tick,
  TimeSignature,
} from '@core/model/types';
import { clipChannelId } from '@core/model/clips';
import { notesSorted, patternLength } from '@core/query/queries';
import { tempoMapOf } from '@core/automation/tempo';
import { ticksPerBar, ticksPerBeat } from '@core/time/ppq';
import type { Waveform } from '@engine/api';
import { shade, type TimelineTheme } from '../../timeline/canvas';
import type { Viewport } from '../../timeline/viewport';
import type { ClipLevels } from '@core/audio/envelope';
import { audioClipTags, drawAudioBody, type AudioHandle } from './audio-clip';
import { drawAutomationBody, type AutoDraw } from './automation';
import { clipBox, TITLE_H } from './clip-geometry';

export const HEADER_WIDTH = 132;
export const RULER_HEIGHT = 34;
/** The ▾ clip-menu button at a clip's top-left corner (clips narrower than the minimum have none). */
export const CLIP_MENU_SIZE = 12;
export const CLIP_MENU_MIN_WIDTH = 30;

export function drawLanesGrid(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  ts: TimeSignature,
  laneCount: number,
  songEnd: Tick,
): void {
  const { width, height } = vp;
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, width, height);
  const [r0, r1] = vp.visibleRows();
  for (let row = r0; row <= Math.min(r1, laneCount - 1); row++) {
    const y = vp.rowToY(row);
    if (row % 2 === 1) {
      ctx.fillStyle = theme.bgAlt;
      ctx.fillRect(0, y, width, vp.rowHeight);
    }
    ctx.fillStyle = theme.bar;
    ctx.fillRect(0, y + vp.rowHeight - 1, width, 1);
  }
  const bar = ticksPerBar(ts);
  const beat = ticksPerBeat(ts);
  const [t0, t1] = vp.visibleTicks();
  if (beat * vp.pxPerTick >= 8) {
    ctx.fillStyle = theme.beat;
    for (let t = Math.floor(t0 / beat) * beat; t <= t1; t += beat)
      ctx.fillRect(Math.round(vp.tickToX(t)), 0, 1, height);
  }
  const every = bar * vp.pxPerTick >= 6 ? bar : bar * 4;
  ctx.fillStyle = theme.bar;
  for (let t = Math.floor(t0 / every) * every; t <= t1; t += every)
    ctx.fillRect(Math.round(vp.tickToX(t)), 0, 1, height);
  // Past the last lane.
  const lanesEnd = vp.rowToY(laneCount);
  if (lanesEnd < height) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, lanesEnd, width, height - lanesEnd);
  }
  void songEnd;
}

interface PatternPreview {
  notes: readonly Note[];
  lo: number;
  hi: number;
  length: Tick;
}

const previewCache = new WeakMap<Pattern, PatternPreview>();

function patternPreview(pattern: Pattern, ts: TimeSignature): PatternPreview {
  let v = previewCache.get(pattern);
  if (!v) {
    const all: Note[] = [];
    for (const byId of Object.values(pattern.notes)) if (byId) all.push(...notesSorted(byId));
    all.sort((a, b) => a.tick - b.tick);
    let lo = 127;
    let hi = 0;
    for (const n of all) {
      lo = Math.min(lo, n.key);
      hi = Math.max(hi, n.key);
    }
    v = { notes: all, lo, hi, length: patternLength(pattern, ts) };
    previewCache.set(pattern, v);
  }
  return v;
}

export interface ClipStyle {
  selected: ReadonlySet<ClipId>;
  /** Clip ids hidden because they're being dragged. */
  skip?: ReadonlySet<ClipId>;
  /** Peak overview of an audio clip's sample (null while it decodes). */
  waveform?(ref: SampleRef): Waveform | null;
  /** A clip's title instead of its pattern/channel name (automation clips say what they drive). */
  label?(clip: Clip): string | undefined;
  /** How an automation clip shows its points and notes (default: points when selected). */
  automation?(clip: AutomationClip): AutoDraw;
  /** An audio clip's gain and fades as drawn (a drag previews new ones). */
  levels?(clip: AudioClip): ClipLevels;
  /** Whether an audio clip shows its gain and fade handles, and which one is under the pointer. */
  audioHandles?(clip: AudioClip): { show: boolean; hot: AudioHandle | null };
  /** True while an audio clip channel's sample is being time-stretched. */
  stretching?(channelId: ChannelId): boolean;
}

export function drawClips(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  project: Project,
  clips: readonly Clip[],
  laneIndex: ReadonlyMap<LaneId, number>,
  style: ClipStyle,
  mutedLanes: ReadonlySet<LaneId>,
): void {
  const [t0, t1] = vp.visibleTicks();
  const ts = project.transport.timeSig;
  ctx.font = `600 10px ${theme.font}`;
  ctx.textBaseline = 'middle';
  for (const c of clips) {
    if (c.start > t1 || c.start + c.length < t0 || style.skip?.has(c.id)) continue;
    const row = laneIndex.get(c.laneId);
    if (row === undefined) continue;
    const box = clipBox(vp, row, c);
    const { x, y, w, h } = box;
    if (y + h < 0 || y > vp.height) continue;
    const pattern = c.kind === 'pattern' ? project.patterns[c.patternId] : undefined;
    const channelId = clipChannelId(c);
    const channel = channelId ? project.channels[channelId] : undefined;
    const base = /^#[0-9a-f]{6}$/i.test(c.color ?? '')
      ? (c.color as string)
      : (pattern?.color ?? channel?.color ?? '#5f8fbf');
    const selected = style.selected.has(c.id);
    const dim = c.muted || mutedLanes.has(c.laneId);
    ctx.globalAlpha = dim ? 0.45 : 1;
    ctx.fillStyle = shade(base, selected ? -0.05 : -0.35);
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = shade(base, selected ? 0.35 : 0.05);
    ctx.fillRect(x, y, w, Math.min(TITLE_H, h));
    ctx.strokeStyle = selected ? '#ffffff' : 'rgba(0,0,0,0.6)';
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    let label = pattern?.name ?? c.name ?? style.label?.(c) ?? channel?.name ?? '?';
    if (c.kind === 'audio' && channel?.kind === 'audioClip') {
      const tags = audioClipTags(c, channel, tempoMapOf(project, 'song'), !!style.stretching?.(channel.id));
      if (tags.length) label = `${label} · ${tags.join(' · ')}`;
    }
    const menu = w >= CLIP_MENU_MIN_WIDTH && h >= TITLE_H;
    if (menu) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath();
      ctx.moveTo(x + 3, y + 4.5);
      ctx.lineTo(x + 9, y + 4.5);
      ctx.lineTo(x + 6, y + 8.5);
      ctx.closePath();
      ctx.fill();
    }
    if (w > 18) {
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      const lx = menu ? x + CLIP_MENU_SIZE : x + 4;
      ctx.fillText(label, lx, y + TITLE_H / 2 + 0.5, x + w - 4 - lx);
    }
    // Body: notes for pattern clips, a waveform hint for audio clips, the curve for automation clips.
    const { bodyY, bodyH } = box;
    if (c.kind === 'automation') {
      if (channel?.kind === 'automation') {
        const d = style.automation?.(c) ?? { showPoints: selected, hot: null, note: null, noteIsWarning: false };
        drawAutomationBody(ctx, vp, theme, c, channel, box, base, d);
      }
    } else if (bodyH > 3 && pattern && c.kind === 'pattern')
      drawPatternBody(ctx, vp, pattern, ts, c, x, w, bodyY, bodyH, shade(base, 0.55));
    else if (bodyH > 3 && c.kind === 'audio') {
      const ref = channel?.kind === 'audioClip' ? project.samples[channel.sampleId] : undefined;
      const wave = ref ? (style.waveform?.(ref) ?? null) : null;
      if (channel?.kind === 'audioClip') {
        const levels = style.levels?.(c) ?? c;
        const handles = style.audioHandles?.(c) ?? { show: selected, hot: null };
        drawAudioBody(ctx, vp, wave, c, channel, levels, tempoMapOf(project, 'song'), box, shade(base, 0.4), handles);
      } else {
        ctx.fillStyle = shade(base, 0.4);
        ctx.fillRect(x, bodyY + bodyH / 2, w, 1);
      }
    }
    ctx.globalAlpha = 1;
  }
}

function drawPatternBody(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  pattern: Pattern,
  ts: TimeSignature,
  clip: PatternClip,
  x: number,
  w: number,
  y: number,
  h: number,
  color: string,
): void {
  const pv = patternPreview(pattern, ts);
  if (pv.notes.length === 0 || pv.length <= 0) return;
  const range = Math.max(8, pv.hi - pv.lo + 1);
  const rowH = Math.max(1, h / range);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = color;
  const ppt = vp.pxPerTick;
  // The clip shows content from `offset`, repeating every pattern length.
  for (let rep = Math.floor(clip.offset / pv.length); rep * pv.length < clip.offset + clip.length; rep++) {
    const repStart = clip.start - clip.offset + rep * pv.length;
    for (const n of pv.notes) {
      const s = repStart + n.tick;
      if (s + n.length < clip.start || s >= clip.start + clip.length) continue;
      const nx = vp.tickToX(s);
      const ny = y + h - ((n.key - pv.lo + 1 + (range - (pv.hi - pv.lo + 1)) / 2) / range) * h;
      ctx.fillRect(nx, ny, Math.max(1, n.length * ppt - 0.5), rowH);
    }
  }
  ctx.restore();
}

export function drawLaneHeaders(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  lanes: readonly Lane[],
  muted: ReadonlySet<LaneId>,
  width: number,
): void {
  ctx.fillStyle = theme.surface;
  ctx.fillRect(0, 0, width, vp.height);
  const [r0, r1] = vp.visibleRows();
  ctx.font = `11px ${theme.font}`;
  ctx.textBaseline = 'middle';
  for (let row = r0; row <= Math.min(r1, lanes.length - 1); row++) {
    const lane = lanes[row] as Lane;
    const y = vp.rowToY(row);
    const h = vp.rowHeight;
    ctx.fillStyle = row % 2 ? theme.surface2 : theme.surface;
    ctx.fillRect(0, y, width, h);
    ctx.fillStyle = theme.bar;
    ctx.fillRect(0, y + h - 1, width, 1);
    // Mute LED (green = playing); solo shows an orange ring.
    const on = !muted.has(lane.id);
    ctx.beginPath();
    ctx.arc(13, y + h / 2, 5, 0, Math.PI * 2);
    ctx.fillStyle = on ? theme.led : theme.ledOff;
    ctx.fill();
    if (lane.solo) {
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    ctx.fillStyle = on ? theme.text : theme.textDim;
    ctx.fillText(lane.name, 26, y + h / 2 + 0.5, width - 32);
  }
  ctx.fillStyle = theme.border;
  ctx.fillRect(width - 1, 0, 1, vp.height);
}

/** The ruler's marker lane: below the bar numbers. */
export const MARKER_LANE_Y = 18;
export const MARKER_COLOR = '#d9c25b';

/** Where a marker's flag was drawn (hit testing on the ruler). */
export interface MarkerBox {
  id: MarkerId;
  tick: Tick;
  /** Flag and label span in ruler pixels. */
  x0: number;
  x1: number;
  /** The flag's ✦ (ask the AI about the section), on flags wide enough for it. */
  ask?: { x0: number; x1: number };
}

export interface RulerMarkers {
  markers: readonly Marker[];
  /** The marker under the pointer or being dragged (drawn brighter). */
  hot?: MarkerId | null;
  /** The pointer is on the hot marker's ✦. */
  hotAsk?: boolean;
  /** A marker being dragged: drawn at this tick instead. */
  drag?: { id: MarkerId; tick: Tick } | null;
}

/** Width of the ✦ at the end of a marker's flag. */
export const MARKER_ASK_WIDTH = 15;

/** Marker positions with a drag applied, sorted. */
function placedMarkers(m: RulerMarkers): Marker[] {
  const list = m.markers.map((x) => (m.drag?.id === x.id ? { ...x, tick: m.drag.tick } : x));
  return list.sort((a, b) => a.tick - b.tick);
}

export function drawPlaylistRuler(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  ts: TimeSignature,
  loop: { start: Tick; end: Tick } | null,
  songEnd: Tick,
  markers: RulerMarkers = { markers: [] },
): MarkerBox[] {
  const h = RULER_HEIGHT;
  const top = MARKER_LANE_Y;
  ctx.fillStyle = theme.surface;
  ctx.fillRect(0, 0, vp.width, h);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(0, top, vp.width, h - top);
  if (loop) {
    const x0 = vp.tickToX(loop.start);
    const x1 = vp.tickToX(loop.end);
    ctx.fillStyle = theme.accentSoft;
    ctx.fillRect(x0, 0, x1 - x0, top);
    ctx.fillStyle = theme.accent;
    ctx.fillRect(x0, 0, 1, h);
    ctx.fillRect(x1 - 1, 0, 1, h);
  }
  const bar = ticksPerBar(ts);
  const [t0, t1] = vp.visibleTicks();
  const barPx = bar * vp.pxPerTick;
  const labelEvery = barPx >= 36 ? 1 : barPx >= 18 ? 2 : barPx >= 9 ? 4 : 8;
  ctx.font = `10px ${theme.font}`;
  ctx.textBaseline = 'top';
  for (let b = Math.floor(t0 / bar); b * bar <= t1; b++) {
    const x = Math.round(vp.tickToX(b * bar));
    ctx.fillStyle = theme.textDim;
    ctx.fillRect(x, top - (b % labelEvery === 0 ? 8 : 4), 1, b % labelEvery === 0 ? 8 : 4);
    if (b % labelEvery === 0) {
      ctx.fillStyle = theme.text;
      ctx.fillText(String(b + 1), x + 3, 3);
    }
  }
  if (songEnd > 0) {
    const x = vp.tickToX(songEnd);
    if (x >= 0 && x <= vp.width) {
      ctx.fillStyle = theme.textDim;
      ctx.fillRect(Math.round(x), 0, 1, h);
    }
  }
  // Markers: a flag on the lane with the name (and a ✦ when there is room), up to the next marker.
  const boxes: MarkerBox[] = [];
  const placed = placedMarkers(markers);
  const colorOf = (m: Marker) => (/^#[0-9a-f]{6}$/i.test(m.color ?? '') ? (m.color as string) : MARKER_COLOR);
  // Each section (marker to the next one, the last to the song's end) as a faint band in the lane.
  for (let i = 0; i < placed.length; i++) {
    const m = placed[i] as Marker;
    const next = placed[i + 1];
    const x0 = Math.max(0, vp.tickToX(m.tick));
    const x1 = Math.min(vp.width, vp.tickToX(next ? next.tick : Math.max(songEnd, m.tick + bar)));
    if (x1 <= x0) continue;
    ctx.globalAlpha = 0.13;
    ctx.fillStyle = colorOf(m);
    ctx.fillRect(x0, top + 1, x1 - x0, h - top - 3);
    ctx.globalAlpha = 1;
  }
  ctx.font = `600 10px ${theme.font}`;
  ctx.textBaseline = 'middle';
  for (let i = 0; i < placed.length; i++) {
    const m = placed[i] as Marker;
    const x = Math.round(vp.tickToX(m.tick));
    const next = placed[i + 1];
    const limit = next ? vp.tickToX(next.tick) - 2 : vp.width;
    const textW = ctx.measureText(m.name).width;
    const ask = limit - x >= textW + 10 + MARKER_ASK_WIDTH;
    const x1 = Math.max(x + 6, Math.min(limit, x + textW + 10 + (ask ? MARKER_ASK_WIDTH : 0)));
    boxes.push({ id: m.id, tick: m.tick, x0: x - 3, x1, ...(ask ? { ask: { x0: x1 - MARKER_ASK_WIDTH, x1 } } : {}) });
    if (x1 < 0 || x - 3 > vp.width) continue;
    const color = colorOf(m);
    const hot = markers.hot === m.id || markers.drag?.id === m.id;
    ctx.fillStyle = shade(color, hot ? 0.25 : -0.15);
    ctx.fillRect(x, top + 1, Math.max(2, x1 - x), h - top - 3);
    ctx.fillStyle = color;
    ctx.fillRect(x, top, 2, h - top);
    if (x1 - x > 14) {
      ctx.fillStyle = 'rgba(0,0,0,0.85)';
      ctx.fillText(m.name, x + 5, top + (h - top) / 2, x1 - x - 7 - (ask ? MARKER_ASK_WIDTH : 0));
    }
    if (ask) {
      const ax = x1 - MARKER_ASK_WIDTH;
      if (markers.hot === m.id && markers.hotAsk) {
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.fillRect(ax, top + 2, MARKER_ASK_WIDTH - 1, h - top - 5);
      }
      ctx.fillStyle = markers.hot === m.id && markers.hotAsk ? '#ffffff' : 'rgba(0,0,0,0.8)';
      ctx.fillText('✦', ax + 3, top + (h - top) / 2 + 0.5);
    }
  }
  ctx.fillStyle = theme.border;
  ctx.fillRect(0, h - 1, vp.width, 1);
  return boxes;
}

/** The marker whose flag is at ruler x (the last drawn wins where they touch). */
export function markerAtX(boxes: readonly MarkerBox[], x: number): MarkerBox | null {
  let hit: MarkerBox | null = null;
  for (const b of boxes) if (x >= b.x0 && x < b.x1) hit = b;
  return hit;
}

/** Faint lines down the lanes where markers are. */
export function drawMarkerLines(ctx: CanvasRenderingContext2D, vp: Viewport, markers: RulerMarkers): void {
  for (const m of placedMarkers(markers)) {
    const x = Math.round(vp.tickToX(m.tick));
    if (x < 0 || x > vp.width) continue;
    const color = /^#[0-9a-f]{6}$/i.test(m.color ?? '') ? (m.color as string) : MARKER_COLOR;
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = color;
    ctx.fillRect(x, 0, 1, vp.height);
    ctx.globalAlpha = 1;
  }
}
