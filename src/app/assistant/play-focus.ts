import { resolveFocus, type AiFocus } from '../ai/focus';
import type { Services } from '../services';

/**
 * Plays a part: a span of the song loops in song mode from its start; selected notes play their
 * pattern in pattern mode. False when there is nothing to play.
 */
export function playFocus(services: Services, focus: AiFocus | null): boolean {
  const r = resolveFocus(services.doc.getState().project, focus);
  if (!r) return false;
  const v = services.view.getState();
  if (r.notes) {
    v.setCurrentPattern(r.notes.patternId);
    services.session.getState().selectChannel(r.notes.channelId);
    v.setMode('pattern');
    services.engine.play();
  } else {
    v.setLoop({ start: r.from, end: r.to });
    v.setMode('song');
    services.engine.play(r.from);
  }
  return true;
}
