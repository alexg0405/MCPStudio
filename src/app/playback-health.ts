/**
 * Says so, once, when playback can't keep up: the audio thread didn't finish the sound in time, so
 * bits of it drop out (static, stutter, a playhead that hesitates). The engine measures it
 * (`stats().keepUp`); this turns it into plain advice. Checked once a second while playing.
 */
import type { EngineApi } from '@engine/api';
import type { PrefsStore } from './stores/prefs';
import type { SessionStore } from './stores/session';

/** Below this share of real time a second counts as struggling (5% of the sound dropped). */
export const KEEP_UP_MIN = 0.95;
/** Struggling seconds in a row before it says something. */
const STRUGGLING_SECONDS = 2;

export function playbackAdvice(keepUp: number, buffer: string): string {
  const lost = Math.max(1, Math.round((1 - keepUp) * 100));
  const tips = [
    ...(buffer !== 'large' ? ['set Options → Settings → Audio buffer to Large'] : []),
    'freeze heavy synths (right-click a channel → Freeze channel to audio)',
    'use one or two shared reverbs instead of one on every track',
  ];
  return `Playback can’t keep up: about ${lost}% of the sound is dropping out because this song needs more than the browser’s audio can do in time. To smooth it out, ${tips.join(', or ')}.`;
}

export function watchPlaybackHealth(engine: EngineApi, prefs: PrefsStore, session: SessionStore): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let struggling = 0;
  let told = false;
  const check = () => {
    const keepUp = engine.stats().keepUp;
    if (keepUp === undefined) return;
    struggling = keepUp < KEEP_UP_MIN ? struggling + 1 : 0;
    if (struggling < STRUGGLING_SECONDS || told) return;
    told = true;
    session.getState().toast(playbackAdvice(keepUp, prefs.getState().audioBuffer), 'error');
  };
  const sync = () => {
    if (engine.playing && !timer) {
      struggling = 0;
      timer = setInterval(check, 1000);
    } else if (!engine.playing && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  const offEngine = engine.subscribe(sync);
  // A new buffer size is a new chance: say it again if it still struggles.
  let buffer = prefs.getState().audioBuffer;
  const offPrefs = prefs.subscribe((p) => {
    if (p.audioBuffer !== buffer) told = false;
    buffer = p.audioBuffer;
  });
  sync();
  return () => {
    offEngine();
    offPrefs();
    if (timer) clearInterval(timer);
  };
}
