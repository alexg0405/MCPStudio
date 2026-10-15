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
import { alpha, inkOn, mix, roundRectPath, type TimelineTheme } from '../../timeline/canvas';
import { clipGradient, clipPaint, type ClipPaint } from './clip-paint';
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
/** Corner radius of clips. */
export const CLIP_RADIUS = 4;

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
  const bar = ticksPerBar(ts);
  const beat = ticksPerBeat(ts);
  const [t0, t1] = vp.visibleTicks();
  // Every other bar (or group of four when zoomed out) is a shade different: calm stone, easy to count.
  const every = bar * vp.pxPerTick >= 6 ? bar : bar * 4;
  ctx.fillStyle = theme.bgAlt;
  for (let t = Math.floor(t0 / every) * every; t <= t1; t += every) {
    if ((t / every) % 2 !== 1) continue;
    const x = vp.tickToX(t);
    ctx.fillRect(Math.round(x), 0, Math.round(x + every * vp.pxPerTick) - Math.round(x), height);
  }
  // Lane separators: hairlines.
  const [r0, r1] = vp.visibleRows();
  ctx.fillStyle = theme.beat;
  for (let row = r0; row <= Math.min(r1, laneCount - 1); row++)
    ctx.fillRect(0, vp.rowToY(row) + vp.rowHeight - 1, width, 1);
  if (beat * vp.pxPerTick >= 8) {
    ctx.fillStyle = theme.beat;
    for (let t = Math.floor(t0 / beat) * beat; t <= t1; t += beat)
      if (t % every !== 0) ctx.fillRect(Math.round(vp.tickToX(t)), 0, 1, height);
  }
  ctx.fillStyle = theme.bar;
  for (let t = Math.floor(t0 / every) * every; t <= t1; t += every)
    ctx.fillRect(Math.round(vp.tickToX(t)), 0, 1, height);
  // Past the last lane.
  const lanesEnd = vp.rowToY(laneCount);
  if (lanesEnd < height) {
    ctx.fillStyle = theme.shade;
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

/** The color a clip is drawn in: its own, else its pattern's or channel's. */
export function clipColorOf(project: Project, c: Clip, theme: TimelineTheme): string {
  if (/^#[0-9a-f]{6}$/i.test(c.color ?? '')) return c.color as string;
  const pattern = c.kind === 'pattern' ? project.patterns[c.patternId] : undefined;
  const channelId = clipChannelId(c);
  return pattern?.color ?? (channelId ? project.channels[channelId]?.color : undefined) ?? theme.accent;
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
    const base = clipColorOf(project, c, theme);
    const selected = style.selected.has(c.id);
    const dim = c.muted || mutedLanes.has(c.laneId);
    const paint = clipPaint(base, theme);
    ctx.globalAlpha = dim ? 0.45 : 1;
    // The whole clip (edge, title strip, body, inner shadow) is one fill of a cached gradient.
    ctx.translate(x, y);
    ctx.fillStyle = clipGradient(ctx, base, theme, h, selected);
    ctx.beginPath();
    roundRectPath(ctx, 0, 0, w, h, CLIP_RADIUS);
    ctx.fill();
    ctx.translate(-x, -y);
    if (selected) {
      ctx.strokeStyle = theme.select;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      roundRectPath(ctx, x + 0.75, y + 0.75, w - 1.5, h - 1.5, CLIP_RADIUS - 0.5);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    let label = pattern?.name ?? c.name ?? style.label?.(c) ?? channel?.name ?? '?';
    if (c.kind === 'audio' && channel?.kind === 'audioClip') {
      const tags = audioClipTags(c, channel, tempoMapOf(project, 'song'), !!style.stretching?.(channel.id));
      if (tags.length) label = `${label} · ${tags.join(' · ')}`;
    }
    const menu = w >= CLIP_MENU_MIN_WIDTH && h >= TITLE_H;
    if (menu) {
      ctx.fillStyle = paint.inkSoft;
      ctx.beginPath();
      ctx.moveTo(x + 4, y + 5);
      ctx.lineTo(x + 9, y + 5);
      ctx.lineTo(x + 6.5, y + 8);
      ctx.closePath();
      ctx.fill();
    }
    if (w > 18) {
      ctx.fillStyle = paint.ink;
      const lx = menu ? x + CLIP_MENU_SIZE + 1 : x + 4;
      ctx.fillText(label, lx, y + TITLE_H / 2 + 0.5, x + w - 4 - lx);
    }
    // Body: notes for pattern clips, a waveform hint for audio clips, the curve for automation clips.
    const { bodyY, bodyH } = box;
    if (c.kind === 'automation') {
      if (channel?.kind === 'automation') {
        const d = style.automation?.(c) ?? { showPoints: selected, hot: null, note: null, noteIsWarning: false };
        drawAutomationBody(ctx, vp, theme, c, channel, box, paint, d);
      }
    } else if (bodyH > 3 && pattern && c.kind === 'pattern')
      drawPatternBody(ctx, vp, pattern, ts, c, x, w, bodyY, bodyH, paint);
    else if (bodyH > 3 && c.kind === 'audio') {
      const ref = channel?.kind === 'audioClip' ? project.samples[channel.sampleId] : undefined;
      const wave = ref ? (style.waveform?.(ref) ?? null) : null;
      if (channel?.kind === 'audioClip') {
        const levels = style.levels?.(c) ?? c;
        const handles = style.audioHandles?.(c) ?? { show: selected, hot: null };
        drawAudioBody(ctx, vp, theme, wave, c, channel, levels, tempoMapOf(project, 'song'), box, paint, handles);
      } else {
        ctx.fillStyle = paint.content;
        ctx.fillRect(x, bodyY + bodyH / 2, w, 1);
      }
    }
    ctx.globalAlpha = 1;
  }
}

/** Velocity steps the mini notes are drawn in (one path per step: few fills, velocity as opacity). */
const VEL_STEPS = [0.45, 0.65, 0.82, 1] as const;

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
  paint: ClipPaint,
): void {
  const pv = patternPreview(pattern, ts);
  if (pv.notes.length === 0 || pv.length <= 0) return;
  const range = Math.max(8, pv.hi - pv.lo + 1);
  const rowH = Math.max(1, Math.min(4, h / range - (h / range > 2.5 ? 0.6 : 0)));
  const ppt = vp.pxPerTick;
  const round = rowH >= 2;
  const left = Math.max(x, 0);
  const right = Math.min(x + w, vp.width);
  if (right <= left) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 1, y, w - 2, h);
  ctx.clip();
  ctx.fillStyle = paint.content;
  const base = ctx.globalAlpha;
  for (let level = 0; level < VEL_STEPS.length; level++) {
    const lo = level === 0 ? -1 : (VEL_STEPS[level - 1] as number);
    const hi = VEL_STEPS[level] as number;
    let any = false;
    ctx.beginPath();
    // The clip shows content from `offset`, repeating every pattern length.
    for (let rep = Math.floor(clip.offset / pv.length); rep * pv.length < clip.offset + clip.length; rep++) {
      const repStart = clip.start - clip.offset + rep * pv.length;
      for (const n of pv.notes) {
        const v = n.velocity;
        if (level < VEL_STEPS.length - 1 ? v <= lo || v > hi : v <= lo) continue;
        const s = repStart + n.tick;
        if (s + n.length < clip.start || s >= clip.start + clip.length) continue;
        const nx = vp.tickToX(s);
        const nw = Math.max(1.5, n.length * ppt - 1);
        if (nx > right || nx + nw < left) continue;
        const ny = y + h - ((n.key - pv.lo + 1 + (range - (pv.hi - pv.lo + 1)) / 2) / range) * h;
        if (round && nw >= 3) roundRectPath(ctx, nx, ny, nw, rowH, rowH / 2);
        else ctx.rect(nx, ny, nw, rowH);
        any = true;
      }
    }
    if (!any) continue;
    ctx.globalAlpha = base * (0.4 + 0.6 * hi);
    ctx.fill();
  }
  ctx.globalAlpha = base;
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
  ctx.fillStyle = theme.surface2;
  ctx.fillRect(0, 0, width, vp.height);
  const [r0, r1] = vp.visibleRows();
  ctx.font = `500 11px ${theme.font}`;
  ctx.textBaseline = 'middle';
  for (let row = r0; row <= Math.min(r1, lanes.length - 1); row++) {
    const lane = lanes[row] as Lane;
    const y = vp.rowToY(row);
    const h = vp.rowHeight;
    if (row % 2) {
      ctx.fillStyle = theme.sheen;
      ctx.fillRect(0, y, width, h);
    }
    ctx.fillStyle = theme.lineFaint;
    ctx.fillRect(0, y + h - 1, width, 1);
    // Mute LED (lit = playing, with a soft halo); solo shows a gold ring.
    const on = !muted.has(lane.id);
    const cy = y + h / 2;
    if (on) {
      ctx.beginPath();
      ctx.arc(14, cy, 6, 0, Math.PI * 2);
      ctx.fillStyle = alpha(theme.ledGlow, 0.35);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(14, cy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = on ? theme.led : theme.ledOff;
    ctx.fill();
    if (lane.solo) {
      ctx.beginPath();
      ctx.arc(14, cy, 6.5, 0, Math.PI * 2);
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    ctx.fillStyle = on ? theme.text : theme.textFaint;
    ctx.fillText(lane.name, 27, cy + 0.5, width - 33);
  }
  ctx.fillStyle = theme.lineFaint;
  ctx.fillRect(width - 1, 0, 1, vp.height);
}

/** The ruler's marker lane: below the bar numbers. */
export const MARKER_LANE_Y = 18;

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

/** A marker's color: its own, or the theme's gold. */
function markerColor(m: Marker, theme: TimelineTheme): string {
  return /^#[0-9a-f]{6}$/i.test(m.color ?? '') ? (m.color as string) : theme.marker;
}

/** Height of a marker's pill. */
const FLAG_H = 13;

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
  ctx.fillStyle = theme.surface2;
  ctx.fillRect(0, 0, vp.width, h);
  // The marker lane sits a touch deeper.
  ctx.fillStyle = theme.sheen;
  ctx.fillRect(0, top, vp.width, h - top);
  ctx.fillStyle = theme.lineFaint;
  ctx.fillRect(0, top, vp.width, 1);
  if (loop) {
    // The loop: a soft gold band with rounded ends behind the bar numbers.
    const x0 = vp.tickToX(loop.start);
    const x1 = vp.tickToX(loop.end);
    ctx.beginPath();
    roundRectPath(ctx, x0 + 0.5, 2.5, Math.max(1, x1 - x0 - 1), top - 5, (top - 5) / 2);
    ctx.fillStyle = theme.accentSoft;
    ctx.fill();
    ctx.strokeStyle = alpha(theme.accent, 0.55);
    ctx.stroke();
  }
  const bar = ticksPerBar(ts);
  const beat = ticksPerBeat(ts);
  const [t0, t1] = vp.visibleTicks();
  const barPx = bar * vp.pxPerTick;
  const labelEvery = barPx >= 36 ? 1 : barPx >= 18 ? 2 : barPx >= 9 ? 4 : 8;
  // Hairline ticks: beats short, bars longer, numbered bars longest.
  if (beat * vp.pxPerTick >= 10) {
    ctx.fillStyle = theme.lineFaint;
    for (let t = Math.floor(t0 / beat) * beat; t <= t1; t += beat)
      if (t % bar !== 0) ctx.fillRect(Math.round(vp.tickToX(t)), top - 3, 1, 3);
  }
  ctx.font = `500 10px ${theme.font}`;
  ctx.textBaseline = 'top';
  const tick = alpha(theme.textFaint, 0.6);
  for (let b = Math.floor(t0 / bar); b * bar <= t1; b++) {
    const x = Math.round(vp.tickToX(b * bar));
    const labelled = b % labelEvery === 0;
    ctx.fillStyle = labelled ? tick : theme.lineFaint;
    ctx.fillRect(x, top - (labelled ? 7 : 4), 1, labelled ? 7 : 4);
    if (labelled) {
      ctx.fillStyle = theme.textFaint;
      ctx.fillText(String(b + 1), x + 3, 3);
    }
  }
  if (songEnd > 0) {
    const x = vp.tickToX(songEnd);
    if (x >= 0 && x <= vp.width) {
      ctx.fillStyle = alpha(theme.textFaint, 0.7);
      ctx.fillRect(Math.round(x), 0, 1, h);
    }
  }
  // Markers: a small pill on the lane with the name (and a ✦ when there is room).
  const boxes: MarkerBox[] = [];
  const placed = placedMarkers(markers);
  // Each section (marker to the next one, the last to the song's end) as a very faint band in the lane.
  for (let i = 0; i < placed.length; i++) {
    const m = placed[i] as Marker;
    const next = placed[i + 1];
    const x0 = Math.max(0, vp.tickToX(m.tick));
    const x1 = Math.min(vp.width, vp.tickToX(next ? next.tick : Math.max(songEnd, m.tick + bar)));
    if (x1 <= x0) continue;
    ctx.fillStyle = alpha(markerColor(m, theme), 0.07);
    ctx.fillRect(x0, top + 1, x1 - x0, h - top - 2);
  }
  ctx.font = `600 10px ${theme.font}`;
  ctx.textBaseline = 'middle';
  const fy = top + (h - top - FLAG_H) / 2;
  const cy = fy + FLAG_H / 2;
  for (let i = 0; i < placed.length; i++) {
    const m = placed[i] as Marker;
    const x = Math.round(vp.tickToX(m.tick));
    const next = placed[i + 1];
    const limit = next ? vp.tickToX(next.tick) - 2 : vp.width;
    const textW = ctx.measureText(m.name).width;
    const ask = limit - x >= textW + 12 + MARKER_ASK_WIDTH;
    const x1 = Math.max(x + 8, Math.min(limit, x + textW + 12 + (ask ? MARKER_ASK_WIDTH : 0)));
    boxes.push({ id: m.id, tick: m.tick, x0: x - 3, x1, ...(ask ? { ask: { x0: x1 - MARKER_ASK_WIDTH, x1 } } : {}) });
    if (x1 < 0 || x - 3 > vp.width) continue;
    const color = markerColor(m, theme);
    const hot = markers.hot === m.id || markers.drag?.id === m.id;
    const fill = hot ? mix(color, theme.text, 0.82) : color;
    const ink = inkOn(fill, theme);
    // The flag's pole: a hairline from the pill to the lane's bottom edge.
    ctx.fillStyle = color;
    ctx.fillRect(x, top, 1, h - top);
    ctx.beginPath();
    roundRectPath(ctx, x, fy, Math.max(4, x1 - x), FLAG_H, FLAG_H / 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (x1 - x > 14) {
      ctx.fillStyle = ink;
      ctx.fillText(m.name, x + 6, cy + 0.5, x1 - x - 9 - (ask ? MARKER_ASK_WIDTH : 0));
    }
    if (ask) {
      const ax = x1 - MARKER_ASK_WIDTH;
      const askHot = markers.hot === m.id && markers.hotAsk;
      if (askHot) {
        ctx.beginPath();
        ctx.arc(ax + 6.5, cy, 5.5, 0, Math.PI * 2);
        ctx.fillStyle = alpha(ink, 0.16);
        ctx.fill();
      }
      ctx.fillStyle = askHot ? ink : alpha(ink, hot ? 0.75 : 0.42);
      ctx.fillText('✦', ax + 2.5, cy + 0.5);
    }
  }
  ctx.fillStyle = theme.lineFaint;
  ctx.fillRect(0, h - 1, vp.width, 1);
  return boxes;
}

/** The marker whose flag is at ruler x (the last drawn wins where they touch). */
export function markerAtX(boxes: readonly MarkerBox[], x: number): MarkerBox | null {
  let hit: MarkerBox | null = null;
  for (const b of boxes) if (x >= b.x0 && x < b.x1) hit = b;
  return hit;
}

/** Hairlines down the lanes where markers are. */
export function drawMarkerLines(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  markers: RulerMarkers,
  theme: TimelineTheme,
): void {
  for (const m of placedMarkers(markers)) {
    const x = Math.round(vp.tickToX(m.tick));
    if (x < 0 || x > vp.width) continue;
    ctx.fillStyle = alpha(markerColor(m, theme), 0.3);
    ctx.fillRect(x, 0, 1, vp.height);
  }
}
