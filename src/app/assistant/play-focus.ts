import { resolveFocus, type AiFocus } from '../ai/focus';
import type { Services } from '../services';

/**
 * Plays a part: a span of the song loops in song mode from its start; selected notes play their
 * pattern in pattern mode. False when there is nothing to play.
 */
export function playFocus(s: Services, focus: AiFocus | null): boolean {
  const r = resolveFocus(s.doc.getState().project, focus);
  if (!r) return false;
  const v = s.view.getState();
  if (r.notes) {
    v.setCurrentPattern(r.notes.patternId);
    s.session.getState().selectChannel(r.notes.channelId);
    v.setMode('pattern');
    s.engine.play();
  } else {
    v.setLoop({ start: r.from, end: r.to });
    v.setMode('song');
    s.engine.play(r.from);
  }
  return true;
}
