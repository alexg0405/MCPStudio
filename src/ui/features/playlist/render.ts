/** Playlist drawing: lanes, clips (with pattern note previews), lane headers and the ruler. */
import type {
  AudioClip,
  Clip,
  ClipId,
  Lane,
  LaneId,
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
import { ticksPerBar, ticksPerBeat, type TempoMap } from '@core/time/ppq';
import type { Waveform } from '@engine/api';
import { shade, type TimelineTheme } from '../../timeline/canvas';
import type { Viewport } from '../../timeline/viewport';

export const HEADER_WIDTH = 132;
export const RULER_HEIGHT = 22;
const TITLE_H = 13;
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
    const y = vp.rowToY(row) + 1;
    const h = vp.rowHeight - 2;
    if (y + h < 0 || y > vp.height) continue;
    const x = vp.tickToX(c.start);
    const w = Math.max(3, c.length * vp.pxPerTick - 1);
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
    const label = pattern?.name ?? c.name ?? channel?.name ?? '?';
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
    // Body: notes for pattern clips, a waveform hint for audio clips.
    const bodyY = y + TITLE_H + 1;
    const bodyH = h - TITLE_H - 3;
    if (bodyH > 3 && pattern && c.kind === 'pattern')
      drawPatternBody(ctx, vp, pattern, ts, c, x, w, bodyY, bodyH, shade(base, 0.55));
    else if (bodyH > 3 && c.kind === 'audio') {
      const ref = channel?.kind === 'audioClip' ? project.samples[channel.sampleId] : undefined;
      const wave = ref ? style.waveform?.(ref) : null;
      ctx.fillStyle = shade(base, 0.4);
      if (wave) drawWaveform(ctx, vp, wave, c, tempoMapOf(project, 'song'), x, w, bodyY, bodyH);
      else ctx.fillRect(x, bodyY + bodyH / 2, w, 1);
    }
    ctx.globalAlpha = 1;
  }
}

/** The part of the sample the clip plays (from its trim point; audio keeps its speed through tempo changes). */
function drawWaveform(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  wave: Waveform,
  clip: AudioClip,
  tempo: TempoMap,
  x: number,
  w: number,
  y: number,
  h: number,
): void {
  const mid = y + h / 2;
  const amp = h / 2;
  const buckets = wave.peaks.length / 2;
  const from = Math.max(Math.floor(x), 0);
  const to = Math.min(Math.ceil(x + w), vp.width);
  const clipSec = tempo.tickToSeconds(clip.start);
  for (let px = from; px < to; px++) {
    const tick = clip.start + (px - x) / vp.pxPerTick;
    const t0 = clip.offsetSec + tempo.tickToSeconds(tick) - clipSec;
    const perPx = tempo.secondsPerTick(tick) / vp.pxPerTick;
    if (t0 >= wave.duration) break;
    const b0 = Math.max(0, Math.floor((t0 * wave.sampleRate) / wave.bucket));
    const b1 = Math.min(buckets, Math.max(b0 + 1, Math.ceil(((t0 + perPx) * wave.sampleRate) / wave.bucket)));
    let lo = 0;
    let hi = 0;
    for (let b = b0; b < b1; b++) {
      lo = Math.min(lo, wave.peaks[b * 2] as number);
      hi = Math.max(hi, wave.peaks[b * 2 + 1] as number);
    }
    const top = Math.max(y, mid - hi * amp);
    ctx.fillRect(px, top, 1, Math.max(1, Math.min(y + h, mid - lo * amp) - top));
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
    ctx.fillStyle = row % 2 ? '#2e363c' : '#2a3238';
    ctx.fillRect(0, y, width, h);
    ctx.fillStyle = theme.bar;
    ctx.fillRect(0, y + h - 1, width, 1);
    // Mute LED (green = playing); solo shows an orange ring.
    const on = !muted.has(lane.id);
    ctx.beginPath();
    ctx.arc(13, y + h / 2, 5, 0, Math.PI * 2);
    ctx.fillStyle = on ? '#9fde5a' : '#46532f';
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

export function drawPlaylistRuler(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  ts: TimeSignature,
  loop: { start: Tick; end: Tick } | null,
  songEnd: Tick,
): void {
  const h = RULER_HEIGHT;
  ctx.fillStyle = theme.surface;
  ctx.fillRect(0, 0, vp.width, h);
  if (loop) {
    const x0 = vp.tickToX(loop.start);
    const x1 = vp.tickToX(loop.end);
    ctx.fillStyle = 'rgba(255, 154, 60, 0.32)';
    ctx.fillRect(x0, 0, x1 - x0, h);
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
    ctx.fillRect(x, h - (b % labelEvery === 0 ? 9 : 5), 1, b % labelEvery === 0 ? 9 : 5);
    if (b % labelEvery === 0) {
      ctx.fillStyle = theme.text;
      ctx.fillText(String(b + 1), x + 3, 4);
    }
  }
  if (songEnd > 0) {
    const x = vp.tickToX(songEnd);
    if (x >= 0 && x <= vp.width) {
      ctx.fillStyle = theme.textDim;
      ctx.fillRect(Math.round(x), 0, 1, h);
    }
  }
  ctx.fillStyle = theme.border;
  ctx.fillRect(0, h - 1, vp.width, 1);
}
