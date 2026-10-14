import { ticksPerBar } from '@core/time/ppq';
import type { SessionTransport } from './persistence/session';
import type { Services } from './services';

/** A "was playing" snapshot this recent means the page reloaded mid-song (not a tab opened later). */
export const RESUME_WINDOW_MS = 15_000;
/** How long to wait for a click when the browser won't start audio by itself. */
export const RESUME_WAIT_MS = 60_000;

/**
 * Carries on playing after a reload: a dev server reload when the code changed, or the musician
 * pressing reload by accident. Playback resumes where it was once the instruments have loaded. When
 * the browser won't start audio without a click, a toast asks for one and that click carries on.
 * Returns a function that gives up (nothing more happens).
 */
export function resumeAfterReload(
  s: Services,
  transport: SessionTransport | undefined,
  opts: { now?: number; askAfterMs?: number } = {},
): () => void {
  const now = opts.now ?? Date.now();
  if (!transport?.playing || now - transport.at > RESUME_WINDOW_MS || now < transport.at) return () => {};
  const tick = transport.tick;
  let done = false;
  let asked = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const offs: (() => void)[] = [];
  const stop = () => {
    done = true;
    for (const t of timers) clearTimeout(t);
    for (const off of offs) off();
  };
  const go = async () => {
    if (done || s.engine.state !== 'running') return;
    stop();
    await s.engine.ready().catch(() => {});
    // The musician started or stopped something meanwhile: leave it be.
    if (s.engine.playing) return;
    s.engine.play(tick);
    if (asked) {
      const bar = Math.floor(tick / ticksPerBar(s.doc.getState().project.transport.timeSig)) + 1;
      s.session.getState().toast(`Carrying on from bar ${bar}`);
    }
  };
  // Running now (the browser allows audio here without a click), or as soon as a click resumes it.
  offs.push(s.engine.subscribe(() => void go()));
  void s.engine.resume().then(() => go(), () => {});
  timers.push(
    setTimeout(() => {
      if (done || s.engine.state === 'running') return;
      asked = true;
      s.session.getState().toast('The page reloaded while playing: click anywhere to carry on.');
    }, opts.askAfterMs ?? 800),
    setTimeout(stop, RESUME_WAIT_MS),
  );
  // Pressing play or stop yourself takes over.
  const startedPlaying = s.engine.playing;
  offs.push(
    s.engine.subscribe(() => {
      if (!done && s.engine.playing !== startedPlaying && s.engine.playing) stop();
    }),
  );
  return stop;
}
