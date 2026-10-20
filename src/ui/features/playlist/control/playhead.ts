/** The playhead line, and the view following it while playing. Both run on the frame loop: no React, nothing allocated. */
import { isReducedMotion } from '../../../a11y/preferences';
import type { FollowFrame } from '../../../timeline/follow';
import { closeContextMenu, isContextMenuOpen } from '../../../controls/ContextMenu';
import type { Project } from '@core/model/types';
import { songLength } from '@core/query/playlist';
import type { PlaylistContext } from './context';
import { maxScrollTick } from './lanes';

/**
 * Follow playhead (FL's auto-scroll): near the right edge the view glides a page on (or, in the smooth style, slides
 * with the playhead). It holds still while the user drags, selects, renames a marker or has a menu open, and after a
 * hand scroll until the playhead is back in view. Nothing is saved until playback stops.
 */
export function followPlayhead(ctx: PlaylistContext, project: Project): void {
  const { s, state, vp } = ctx;
  const playing = s.engine.playing;
  // Playback starting moves things under an open menu: it closes.
  if (playing && !state.wasPlaying) closeContextMenu();
  state.wasPlaying = playing;
  const enabled = s.prefs.getState().followPlayhead;
  const frame = ctx.followFrame;
  if (!playing || !enabled) {
    fillIdleFrame(frame, enabled, playing);
    ctx.follow.step(frame);
    if (!playing && state.followMoved) {
      state.followMoved = false;
      ctx.viewportSaver.flush();
    }
    return;
  }
  fillPlayingFrame(ctx, frame, project);
  const next = ctx.follow.step(frame);
  if (next === null || next === vp.scrollTick) return;
  vp.scrollTick = next;
  state.followMoved = true;
  // The grid, clips and ruler slide (see the frame); only what is drawn at the pointer, and the keyboard cursor, follow the scroll by redrawing.
  if (state.hover || state.keyboard.isActive) ctx.invalidate('overlay');
}

/** Not following (stopped, or the preference is off): the follow still hears about it, so it forgets the old state. */
function fillIdleFrame(frame: FollowFrame, enabled: boolean, playing: boolean): void {
  frame.now = performance.now();
  frame.enabled = enabled;
  frame.playing = playing;
  frame.playhead = NaN;
  frame.scrollTick = 0;
  frame.visible = 0;
  frame.maxScroll = 0;
  frame.wrapEnd = Infinity;
  frame.busy = false;
}

/** The frame's inputs while following, written into the one record this editor keeps. */
function fillPlayingFrame(ctx: PlaylistContext, frame: FollowFrame, project: Project): void {
  const { s, vp } = ctx;
  const view = s.view.getState();
  const visibleTicks = vp.width / vp.pxPerTick;
  frame.now = performance.now();
  frame.enabled = true;
  frame.playing = true;
  frame.playhead = view.mode === 'song' ? s.engine.playhead() : NaN;
  frame.scrollTick = vp.scrollTick;
  frame.visible = visibleTicks;
  frame.maxScroll = Math.max(0, maxScrollTick(project) - visibleTicks);
  frame.wrapEnd = wrapEndTick(ctx, project);
  frame.style = s.prefs.getState().followStyle;
  frame.reducedMotion = isReducedMotion();
  frame.busy = ctx.state.drag !== null || isContextMenuOpen() || ctx.els.markerRename.style.display === 'block';
}

/** Where playback wraps back to the start: the loop's end; with no loop, the song's end (recording a take plays on past it). */
function wrapEndTick(ctx: PlaylistContext, project: Project): number {
  const loop = ctx.s.view.getState().loop;
  if (loop) return loop.end;
  const isRecordingATake = !!ctx.s.audioRecorder.live.getState().take;
  return isRecordingATake ? Infinity : songLength(project);
}

/** Places the playhead line: at the playing position, or at the song position marker while stopped. Song mode only. */
export function updatePlayhead(ctx: PlaylistContext): void {
  const { s, vp } = ctx;
  const view = s.view.getState();
  let x = NaN;
  if (view.mode === 'song') x = vp.tickToX(s.engine.playing ? s.engine.playhead() : view.songStart);
  ctx.playheadLine.place(vp, x);
}
