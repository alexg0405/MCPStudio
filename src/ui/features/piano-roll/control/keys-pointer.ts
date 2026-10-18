/** The piano keys on the left: pressing one plays it, sliding to another plays that one instead. */
import { clamp } from '../../../timeline/viewport';
import { KEYS_WIDTH } from '../layout';
import type { PianoRollContext } from './context';
import { keyAtY, localPoint } from './hit-test';
import { editTarget } from './target';

/** A key pressed at its left edge plays at this velocity (0-1); the velocity grows by `KEY_VELOCITY_RANGE` across its width. */
const MIN_KEY_VELOCITY = 0.35;
const KEY_VELOCITY_RANGE = 0.65;
/** The velocity is kept between these. */
const LOWEST_VELOCITY = 0.1;
const HIGHEST_VELOCITY = 1;

/** A press on the keys strip. */
export function onKeysDown(ctx: PianoRollContext, event: PointerEvent): void {
  if (event.button !== 0) return;
  event.preventDefault();
  ctx.els.keys.setPointerCapture(event.pointerId);
  const key = keyAtY(ctx, localPoint(ctx, event, ctx.els.keys).y);
  ctx.state.drag = { kind: 'keys', key };
  pressKey(ctx, key, event);
}

/** Sliding along the strip: the key under the pointer sounds, the one left behind stops. */
export function onKeysMove(ctx: PianoRollContext, event: PointerEvent): void {
  const drag = ctx.state.drag;
  if (drag?.kind !== 'keys') return;
  const key = keyAtY(ctx, localPoint(ctx, event, ctx.els.keys).y);
  if (key === drag.key) return;
  releaseKey(ctx, drag.key);
  drag.key = key;
  pressKey(ctx, key, event);
}

/** The button was let go on the strip (or the pointer was cancelled). */
export function onKeysUp(ctx: PianoRollContext, event: PointerEvent): void {
  const drag = ctx.state.drag;
  if (drag?.kind !== 'keys') return;
  ctx.els.keys.releasePointerCapture(event.pointerId);
  releaseKey(ctx, drag.key);
  ctx.state.drag = null;
}

/** Plays `key`: clicking further right on a key plays it louder (FL-style). */
function pressKey(ctx: PianoRollContext, key: number, event: PointerEvent): void {
  const { channelId } = editTarget(ctx);
  if (!channelId) return;
  const across = localPoint(ctx, event, ctx.els.keys).x / KEYS_WIDTH;
  const velocity = clamp(MIN_KEY_VELOCITY + across * KEY_VELOCITY_RANGE, LOWEST_VELOCITY, HIGHEST_VELOCITY);
  ctx.state.pressedKeys.set(key, ctx.s.engine.previewNoteOn(channelId, key, velocity));
  ctx.invalidate('keys');
}

/** Stops `key` sounding. */
function releaseKey(ctx: PianoRollContext, key: number): void {
  const noteId = ctx.state.pressedKeys.get(key);
  const { channelId } = editTarget(ctx);
  if (noteId !== undefined && channelId) ctx.s.engine.previewNoteOff(channelId, noteId);
  ctx.state.pressedKeys.delete(key);
  ctx.invalidate('keys');
}
