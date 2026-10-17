/**
 * The punch range (punch in and out) of audio recording: only that part of a take is kept, and without a loop
 * region the song plays on after the punch-out. It is separate from the loop region, which still repeats the
 * passes of a loop take. View state, not the song: nothing here is undoable.
 */
import { barSpan } from '@core/time/bars';
import { ticksPerBar } from '@core/time/ppq';
import type { Tick } from '@core/model/types';
import type { Services } from '../services';

export const DEFAULT_PUNCH_BARS = 4;

/** "bars 5–8" for a toast, or null. */
export function describePunch(s: Services): string | null {
  const punch = s.view.getState().punch;
  return punch ? barSpan(punch.start, punch.end, s.doc.getState().project.transport.timeSig) : null;
}

export function setPunchRange(s: Services, from: Tick, to: Tick): boolean {
  if (!(to > from)) return false;
  s.view.getState().setPunch({ start: from, end: to });
  return true;
}

/** Sets the punch-in; the punch-out stays (or becomes four bars later when there is none or it would come first). */
export function setPunchIn(s: Services, tick: Tick): void {
  const bar = ticksPerBar(s.doc.getState().project.transport.timeSig);
  const cur = s.view.getState().punch;
  const start = Math.max(0, Math.round(tick));
  s.view.getState().setPunch({ start, end: cur && cur.end > start ? cur.end : start + DEFAULT_PUNCH_BARS * bar });
}

/** Sets the punch-out; the punch-in stays (or becomes four bars earlier, at most the start of the song). */
export function setPunchOut(s: Services, tick: Tick): void {
  const bar = ticksPerBar(s.doc.getState().project.transport.timeSig);
  const cur = s.view.getState().punch;
  const end = Math.max(1, Math.round(tick));
  s.view.getState().setPunch({ start: cur && cur.start < end ? cur.start : Math.max(0, end - DEFAULT_PUNCH_BARS * bar), end });
}

export function clearPunch(s: Services): void {
  s.view.getState().setPunch(null);
}

/** The loop region becomes the punch range too. */
export function punchFromLoop(s: Services): boolean {
  const loop = s.view.getState().loop;
  return loop ? setPunchRange(s, loop.start, loop.end) : false;
}

/** Where recording the punch range starts playing: the pre-roll before the punch-in (none when looping). */
export function punchStartTick(s: Services): Tick | null {
  const { punch, loop } = s.view.getState();
  if (!punch) return null;
  if (loop) return null;
  const bar = ticksPerBar(s.doc.getState().project.transport.timeSig);
  return Math.max(0, punch.start - Math.max(0, Math.round(s.prefs.getState().preRollBars)) * bar);
}

/**
 * Records the punch range: audio record mode on, song mode, playback from the pre-roll before the punch-in
 * (after the count-in), recording from the punch-in to the punch-out. Needs a click the first time (the
 * browser's microphone permission). False when there is no punch range.
 */
export async function recordPunch(s: Services): Promise<boolean> {
  const start = punchStartTick(s);
  if (!s.view.getState().punch) return false;
  s.prefs.getState().set({ recordAudio: true });
  s.view.getState().setMode('song');
  const input = await s.audioInput.open();
  if (!input) {
    s.session.getState().toast(s.audioInput.store.getState().error ?? 'The audio input could not be opened.', 'error');
    return false;
  }
  s.recording.setArmed(true);
  s.engine.play(start ?? undefined);
  return true;
}
