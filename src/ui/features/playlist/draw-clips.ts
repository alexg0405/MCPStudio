/** Drawing the clips of the playlist: the clip shapes, their titles and bodies (notes, waveform or curve). */
import type {
  AudioClip,
  AudioClipChannel,
  AutomationClip,
  Channel,
  ChannelId,
  Clip,
  ClipId,
  LaneId,
  Pattern,
  PatternClip,
  Project,
  SampleRef,
  TimeSignature,
} from '@core/model/types';
import type { ClipLevels } from '@core/audio/envelope';
import { clipSampleId } from '@core/audio/playback';
import { tempoMapOf } from '@core/automation/tempo';
import { clipChannelId } from '@core/model/clips';
import type { Waveform } from '@engine/api';
import { drawPattern, patternFor } from '../../a11y/color-patterns';
import { roundRectPath, type TimelineTheme, fontPx } from '../../timeline/canvas';
import type { Viewport } from '../../timeline/viewport';
import { audioClipTags, drawAudioBody, type AudioHandle } from './audio-clip';
import { drawAutomationBody, type AutoDraw } from './automation';
import {
  CLIP_MENU_MIN_WIDTH,
  CLIP_MENU_SIZE,
  CLIP_RADIUS,
  CLIP_TITLE_HEIGHT,
  clipBox,
  type ClipBox,
} from './clip-geometry';
import { clipGradient, clipPaint, type ClipPaint } from './clip-paint';
import { drawPatternBody } from './pattern-body';

/** How the clips are drawn right now: what is selected, hidden, previewed or under the pointer. */
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

/** Clips on a muted track, and muted clips, are drawn at this opacity. */
const DIMMED_ALPHA = 0.45;
/** Titles are left out of clips narrower than this (px). */
const MIN_TITLE_CLIP_WIDTH = 18;
/** Gap between a clip's left edge and its title when the clip has no ▾ button (px). */
const TITLE_INSET = 4;
/** Clip bodies at most this tall (px) are too small to show anything. */
const MIN_BODY_HEIGHT = 3;
const SELECTION_OUTLINE_WIDTH = 1.5;

/** The color a clip is drawn in: its own, else its pattern's or channel's. */
export function clipColorOf(project: Project, clip: Clip, theme: TimelineTheme): string {
  if (/^#[0-9a-f]{6}$/i.test(clip.color ?? '')) return clip.color as string;
  const pattern = clip.kind === 'pattern' ? project.patterns[clip.patternId] : undefined;
  const channelId = clipChannelId(clip);
  return pattern?.color ?? (channelId ? project.channels[channelId]?.color : undefined) ?? theme.accent;
}

/** What drawing one clip needs besides the clip: the same for every clip of one `drawClips` call. */
interface ClipScene {
  ctx: CanvasRenderingContext2D;
  vp: Viewport;
  theme: TimelineTheme;
  project: Project;
  timeSig: TimeSignature;
  style: ClipStyle;
  mutedLanes: ReadonlySet<LaneId>;
}

/**
 * Draws `clips` (those in view) on the tracks `laneIndex` gives rows to. Runs when the clips layer is redrawn (an edit, a
 * zoom, a theme change), not every frame, so it keeps no state between calls.
 */
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
  const scene: ClipScene = { ctx, vp, theme, project, timeSig: project.transport.timeSig, style, mutedLanes };
  const [firstTick, lastTick] = vp.visibleTicks();
  ctx.font = `600 ${fontPx(10)}px ${theme.font}`;
  ctx.textBaseline = 'middle';
  for (const clip of clips) {
    if (clip.start > lastTick || clip.start + clip.length < firstTick || style.skip?.has(clip.id)) continue;
    const row = laneIndex.get(clip.laneId);
    if (row === undefined) continue;
    drawClip(scene, clip, row);
  }
}

function drawClip(scene: ClipScene, clip: Clip, row: number): void {
  const { ctx, vp, theme, project, style } = scene;
  const box = clipBox(vp, row, clip);
  if (box.y + box.h < 0 || box.y > vp.height) return;
  const pattern = clip.kind === 'pattern' ? project.patterns[clip.patternId] : undefined;
  const channelId = clipChannelId(clip);
  const channel = channelId ? project.channels[channelId] : undefined;
  const baseColor = clipColorOf(project, clip, theme);
  const isSelected = style.selected.has(clip.id);
  const isDimmed = clip.muted || scene.mutedLanes.has(clip.laneId);
  const paint = clipPaint(baseColor, theme);
  ctx.globalAlpha = isDimmed ? DIMMED_ALPHA : 1;
  fillClipShape(ctx, theme, box, baseColor, isSelected);
  if (theme.colorSafe) markClipForColorBlindness(ctx, paint, box, baseColor, isDimmed);
  if (isSelected) outlineSelectedClip(ctx, theme, box);
  const hasMenuButton = box.w >= CLIP_MENU_MIN_WIDTH && box.h >= CLIP_TITLE_HEIGHT;
  if (hasMenuButton) drawMenuMark(ctx, box, paint);
  if (box.w > MIN_TITLE_CLIP_WIDTH) drawTitle(scene, clip, box, paint, hasMenuButton, pattern, channel);
  drawBody(scene, clip, box, paint, isSelected, pattern, channel);
  ctx.globalAlpha = 1;
}

/** The whole clip (edge, title strip, body, inner shadow) is one fill of a cached gradient. */
function fillClipShape(
  ctx: CanvasRenderingContext2D,
  theme: TimelineTheme,
  box: ClipBox,
  baseColor: string,
  isSelected: boolean,
): void {
  const { x, y, w, h } = box;
  ctx.translate(x, y);
  ctx.fillStyle = clipGradient(ctx, baseColor, theme, h, isSelected);
  ctx.beginPath();
  roundRectPath(ctx, 0, 0, w, h, CLIP_RADIUS);
  ctx.fill();
  ctx.translate(-x, -y);
}

/** Width of the pattern badge at the right end of a clip's title strip (px), and the narrowest clip that shows it. */
const PATTERN_BADGE_WIDTH = 16;
const MIN_PATTERN_CLIP_WIDTH = 56;

/**
 * Colour-blind safe colours: a badge of the colour's pattern at the right of the title strip, so clips of different
 * colours differ by more than colour, and muted clips get diagonal stripes (they are otherwise only paler).
 */
function markClipForColorBlindness(ctx: CanvasRenderingContext2D, paint: ClipPaint, box: ClipBox, baseColor: string, isDimmed: boolean): void {
  if (box.w >= MIN_PATTERN_CLIP_WIDTH) {
    const badgeX = box.x + box.w - PATTERN_BADGE_WIDTH - 2;
    drawPattern(ctx, patternFor(baseColor), badgeX, box.y + 2, PATTERN_BADGE_WIDTH, CLIP_TITLE_HEIGHT - 4, paint.ink);
  }
  if (isDimmed && box.bodyH > MIN_BODY_HEIGHT) drawPattern(ctx, 'slash', box.x + 1, box.bodyY, box.w - 2, box.bodyH, paint.inkSoft);
}

function outlineSelectedClip(ctx: CanvasRenderingContext2D, theme: TimelineTheme, box: ClipBox): void {
  const inset = SELECTION_OUTLINE_WIDTH / 2;
  ctx.strokeStyle = theme.select;
  ctx.lineWidth = SELECTION_OUTLINE_WIDTH;
  ctx.beginPath();
  roundRectPath(ctx, box.x + inset, box.y + inset, box.w - 2 * inset, box.h - 2 * inset, CLIP_RADIUS - 0.5);
  ctx.stroke();
  ctx.lineWidth = 1;
}

/** The little ▾ at the clip's top-left corner: the clip menu button. */
function drawMenuMark(ctx: CanvasRenderingContext2D, box: ClipBox, paint: ClipPaint): void {
  const { x, y } = box;
  ctx.fillStyle = paint.inkSoft;
  ctx.beginPath();
  ctx.moveTo(x + 4, y + 5);
  ctx.lineTo(x + 9, y + 5);
  ctx.lineTo(x + 6.5, y + 8);
  ctx.closePath();
  ctx.fill();
}

/** The clip's name (an audio clip adds how it plays: "Stretch 90→128 BPM", "Reversed"...). */
function clipTitle(
  scene: ClipScene,
  clip: Clip,
  pattern: Pattern | undefined,
  channel: Channel | undefined,
): string {
  const title = pattern?.name ?? clip.name ?? scene.style.label?.(clip) ?? channel?.name ?? '?';
  if (clip.kind !== 'audio' || channel?.kind !== 'audioClip') return title;
  const isStretching = !!scene.style.stretching?.(channel.id);
  const tags = audioClipTags(clip, channel, tempoMapOf(scene.project, 'song'), isStretching);
  return tags.length > 0 ? `${title} · ${tags.join(' · ')}` : title;
}

function drawTitle(
  scene: ClipScene,
  clip: Clip,
  box: ClipBox,
  paint: ClipPaint,
  hasMenuButton: boolean,
  pattern: Pattern | undefined,
  channel: Channel | undefined,
): void {
  const { ctx } = scene;
  ctx.fillStyle = paint.ink;
  const left = hasMenuButton ? box.x + CLIP_MENU_SIZE + 1 : box.x + TITLE_INSET;
  // The pattern badge of the colour-blind safe colours takes the end of the strip.
  const badge = scene.theme.colorSafe && box.w >= MIN_PATTERN_CLIP_WIDTH ? PATTERN_BADGE_WIDTH + 4 : 0;
  ctx.fillText(clipTitle(scene, clip, pattern, channel), left, box.y + CLIP_TITLE_HEIGHT / 2 + 0.5, box.x + box.w - TITLE_INSET - left - badge);
}

/** The body: notes for pattern clips, a waveform for audio clips, the curve for automation clips. */
function drawBody(
  scene: ClipScene,
  clip: Clip,
  box: ClipBox,
  paint: ClipPaint,
  isSelected: boolean,
  pattern: Pattern | undefined,
  channel: Channel | undefined,
): void {
  const { ctx, vp, theme, style } = scene;
  if (clip.kind === 'automation') {
    if (channel?.kind !== 'automation') return;
    const look = style.automation?.(clip) ?? { showPoints: isSelected, hot: null, note: null, noteIsWarning: false };
    drawAutomationBody(ctx, vp, theme, clip, channel, box, paint, look);
    return;
  }
  if (box.bodyH <= MIN_BODY_HEIGHT) return;
  if (clip.kind === 'pattern' && pattern) {
    drawPatternBody(ctx, vp, pattern, scene.timeSig, clip as PatternClip, box.x, box.w, box.bodyY, box.bodyH, paint);
  } else if (clip.kind === 'audio') {
    drawAudioClipBody(scene, clip, box, paint, isSelected, channel);
  }
}

function drawAudioClipBody(
  scene: ClipScene,
  clip: AudioClip,
  box: ClipBox,
  paint: ClipPaint,
  isSelected: boolean,
  channel: Channel | undefined,
): void {
  const { ctx, vp, theme, project, style } = scene;
  if (channel?.kind !== 'audioClip') {
    // Not an audio channel (it was deleted): a flat line where the waveform would be.
    ctx.fillStyle = paint.content;
    ctx.fillRect(box.x, box.bodyY + box.bodyH / 2, box.w, 1);
    return;
  }
  const levels = style.levels?.(clip) ?? clip;
  const handles = style.audioHandles?.(clip) ?? { show: isSelected, hot: null };
  const wave = waveformPlayed(scene, clip, channel);
  drawAudioBody(ctx, vp, theme, wave, clip, channel, levels, tempoMapOf(project, 'song'), box, paint, handles);
}

/**
 * The waveform of what plays: a pitch-corrected clip draws its render (the same length and timeline as the recording)
 * once the engine has it, and the recording until then.
 */
function waveformPlayed(scene: ClipScene, clip: AudioClip, channel: AudioClipChannel): Waveform | null {
  const { project, style } = scene;
  const played = project.samples[clipSampleId(channel, clip)];
  const own = project.samples[channel.sampleId];
  return (played && style.waveform?.(played)) || (own ? (style.waveform?.(own) ?? null) : null);
}
