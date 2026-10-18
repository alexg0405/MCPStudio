/** Hearing notes while editing: the key under a note being drawn or dragged, and the keys held on the keys strip. */
import { editTarget } from './target';
import type { PianoRollContext } from './context';

/** Sounds `key` (silencing the one sounding before), unless it already is the sounding one. */
export function auditionKey(ctx: PianoRollContext, key: number, velocity = 0.8): void {
  const target = editTarget(ctx);
  if (!target.channelId) return;
  if (ctx.state.audition?.key === key) return;
  stopAudition(ctx);
  const noteId = ctx.s.engine.previewNoteOn(target.channelId, key, velocity);
  ctx.state.audition = { key, noteId, channelId: target.channelId };
}

/** Stops the sounding key, if any. */
export function stopAudition(ctx: PianoRollContext): void {
  const { state } = ctx;
  if (!state.audition) return;
  ctx.s.engine.previewNoteOff(state.audition.channelId, state.audition.noteId);
  state.audition = null;
}
