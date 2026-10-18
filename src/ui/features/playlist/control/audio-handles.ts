/** The gain and fade handles of audio clips: hover, hints, dragging them, resetting them, and how clips draw them. */
import { emitHint } from '@agstudio/sdk/ui';
import { tempoMapOf } from '@core/automation/tempo';
import {
  clipGain,
  dbToGain,
  formatDb,
  formatSeconds,
  gainToDb,
  MAX_CLIP_GAIN,
  type ClipLevels,
} from '@core/audio/envelope';
import type { AudioClip, ChannelId, ClipId, Project } from '@core/model/types';
import { setAudioClipEdits, type AudioClipEdits } from '@core/ops/audio-edits';
import { clamp } from '../../../timeline/viewport';
import { hitAudioHandle, type AudioHandle } from '../audio-clip';
import type { ClipStyle } from '../draw-clips';
import type { Hit, PlaylistContext } from './context';
import { updateCursor } from './cursor';
import type { LevelDrag } from './drag';
import { boxOfClip } from './hit-test';

/** Dragging a gain handle changes the gain by this many dB per pixel (Shift: the fine amount). */
const GAIN_DB_PER_PIXEL = 0.2;
const FINE_GAIN_DB_PER_PIXEL = 0.02;
/** The gain can be dragged down to this (dB) and up to the largest clip gain. */
const MIN_GAIN_DB = -48;
/** A gain within this many dB of 0 dB snaps to exactly 0 dB. */
const UNITY_SNAP_DB = 0.05;
/** A fade shorter than this (seconds) is no fade. */
const MIN_FADE_SECONDS = 0.002;
/** Gains and fade lengths are kept to four decimals. */
const LEVEL_DECIMALS = 10000;

/** The undo labels of dragging each handle. */
const DRAG_LABELS: Record<AudioHandle, string> = { gain: 'Clip gain', fadeIn: 'Fade in', fadeOut: 'Fade out' };

/** What a double-click on each handle does: the edit and its undo label. */
const RESET: Record<AudioHandle, { edits: AudioClipEdits; label: string }> = {
  gain: { edits: { gain: 1 }, label: 'Clip gain 0 dB' },
  fadeIn: { edits: { fadeIn: 0 }, label: 'Remove fade in' },
  fadeOut: { edits: { fadeOut: 0 }, label: 'Remove fade out' },
};

/** The gain and fade handles only edit with tools that edit clips (not Delete or Slice). */
function toolEditsClips(ctx: PlaylistContext): boolean {
  const tool = ctx.s.editor.getState().playlist.tool;
  return tool !== 'delete' && tool !== 'slice';
}

/** What a clip's drawing needs for audio clips: its gain and fades as dragged, which handles show, and stretching. */
export function audioDrawStyle(
  ctx: PlaylistContext,
  selected: ReadonlySet<ClipId>,
): Pick<ClipStyle, 'levels' | 'audioHandles' | 'stretching'> {
  const drag = ctx.state.drag;
  return {
    levels: (clip: AudioClip): ClipLevels => (drag?.kind === 'level' && drag.clip.id === clip.id ? drag.now : clip),
    audioHandles: (clip: AudioClip) => {
      const isDragged = drag?.kind === 'level' && drag.clip.id === clip.id;
      const hot = isDragged ? drag.handle : hoveredHandleOf(ctx, clip.id);
      return { show: selected.has(clip.id) || ctx.state.hover?.clip.id === clip.id || isDragged, hot };
    },
    stretching: (channelId: ChannelId) => ctx.s.engine.isStretching(channelId),
  };
}

/** The handle of this clip the pointer is on, or null. */
function hoveredHandleOf(ctx: PlaylistContext, clipId: ClipId): AudioHandle | null {
  const hovered = ctx.state.audioHot;
  return hovered?.clipId === clipId ? hovered.handle : null;
}

/** The audio clip handle under (`x`, `y`) (only with tools that edit clips). */
export function audioHandleAt(ctx: PlaylistContext, hit: Hit, x: number, y: number, project: Project): AudioHandle | null {
  if (hit.clip.kind !== 'audio' || !toolEditsClips(ctx)) return null;
  const box = boxOfClip(ctx, hit.clip, project);
  return box ? hitAudioHandle(ctx.vp, hit.clip, hit.clip, tempoMapOf(project, 'song'), box, x, y) : null;
}

/** The hint bar text for a handle and its current value. */
function levelHint(handle: AudioHandle, levels: ClipLevels): string {
  if (handle === 'gain') {
    return `Clip gain ${formatDb(levels.gain ?? 1)} · drag up or down (Shift: fine) · double-click for 0 dB`;
  }
  const seconds = handle === 'fadeIn' ? (levels.fadeIn ?? 0) : (levels.fadeOut ?? 0);
  const name = handle === 'fadeIn' ? 'Fade in' : 'Fade out';
  return `${name} ${seconds > 0 ? formatSeconds(seconds) : 'off'} · drag left or right · double-click to remove`;
}

/** Hover: the handle under the pointer lights up, and the hint bar says what dragging it does. */
export function updateAudioHover(ctx: PlaylistContext, hit: Hit | null, x: number, y: number, project: Project): void {
  const { state, els } = ctx;
  const handle = hit ? audioHandleAt(ctx, hit, x, y, project) : null;
  const next = handle && hit ? { clipId: hit.clip.id, handle } : null;
  const previous = state.audioHot;
  if (previous?.clipId === next?.clipId && previous?.handle === next?.handle) return;
  state.audioHot = next;
  ctx.invalidate('clips');
  updateCursor(ctx);
  if (next && hit?.clip.kind === 'audio') {
    const text = levelHint(next.handle, hit.clip);
    state.lastHint = text;
    emitHint(els.gridHost, text);
  } else if (!state.autoHover) {
    state.lastHint = null;
    emitHint(els.gridHost, els.gridHost.getAttribute('data-hint') ?? '');
  }
}

/** Starts dragging a handle of `clip` from (`x`, `y`). */
export function startLevelDrag(ctx: PlaylistContext, clip: AudioClip, handle: AudioHandle, x: number, y: number): void {
  const levels: ClipLevels = { gain: clipGain(clip), fadeIn: clip.fadeIn ?? 0, fadeOut: clip.fadeOut ?? 0 };
  ctx.state.drag = { kind: 'level', clip, handle, x0: x, y0: y, start: levels, now: levels };
}

/** Dragging a gain or fade handle: previews on the clip; the clip changes (one undo step) on release. */
export function dragLevel(ctx: PlaylistContext, drag: LevelDrag, x: number, y: number, event: PointerEvent): void {
  const project = ctx.s.doc.getState().project;
  drag.now = drag.handle === 'gain' ? draggedGain(drag, y, event.shiftKey) : draggedFade(ctx, drag, x, project);
  emitHint(ctx.els.gridHost, levelHint(drag.handle, drag.now));
  ctx.invalidate('clips');
}

/** The levels with the gain moved by how far the pointer went up (up is louder). */
function draggedGain(drag: LevelDrag, y: number, isFine: boolean): ClipLevels {
  const startDb = gainToDb(Math.max(1e-6, drag.start.gain ?? 1));
  const dbPerPixel = isFine ? FINE_GAIN_DB_PER_PIXEL : GAIN_DB_PER_PIXEL;
  const maxDb = 20 * Math.log10(MAX_CLIP_GAIN);
  const db = clamp(startDb + (drag.y0 - y) * dbPerPixel, MIN_GAIN_DB, maxDb);
  const gain = Math.abs(db) < UNITY_SNAP_DB ? 1 : dbToGain(db);
  return { ...drag.start, gain: Math.round(gain * LEVEL_DECIMALS) / LEVEL_DECIMALS };
}

/** The levels with the dragged fade as long as the pointer is from the clip's edge (it cannot overlap the other fade). */
function draggedFade(ctx: PlaylistContext, drag: LevelDrag, x: number, project: Project): ClipLevels {
  const tempo = tempoMapOf(project, 'song');
  const clip = drag.clip;
  const startSeconds = tempo.tickToSeconds(clip.start);
  const durationSeconds = tempo.tickToSeconds(clip.start + clip.length) - startSeconds;
  const tick = clamp(ctx.vp.xToTick(x), clip.start, clip.start + clip.length);
  const seconds = tempo.tickToSeconds(tick) - startSeconds;
  const otherFade = drag.handle === 'fadeIn' ? (drag.start.fadeOut ?? 0) : (drag.start.fadeIn ?? 0);
  const wanted = drag.handle === 'fadeIn' ? seconds : durationSeconds - seconds;
  const length = clamp(wanted, 0, Math.max(0, durationSeconds - otherFade));
  const fade = length < MIN_FADE_SECONDS ? 0 : Math.round(length * LEVEL_DECIMALS) / LEVEL_DECIMALS;
  return drag.handle === 'fadeIn' ? { ...drag.start, fadeIn: fade } : { ...drag.start, fadeOut: fade };
}

/** Releasing a handle: one undo step, when anything changed. */
export function commitLevelDrag(ctx: PlaylistContext, drag: LevelDrag): void {
  const { now, start, clip } = drag;
  const hasChanged = now.gain !== start.gain || now.fadeIn !== start.fadeIn || now.fadeOut !== start.fadeOut;
  if (!hasChanged) return;
  ctx.s.history.transact(DRAG_LABELS[drag.handle], (draft) => setAudioClipEdits(draft, clip.id, now));
}

/** Double-click on a handle: the gain goes back to 0 dB, or the fade is removed. */
export function resetLevel(ctx: PlaylistContext, clipId: ClipId, handle: AudioHandle): void {
  const { edits, label } = RESET[handle];
  ctx.s.history.transact(label, (draft) => setAudioClipEdits(draft, clipId, edits));
}
