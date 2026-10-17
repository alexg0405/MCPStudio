/**
 * Runs the Auto audio buffer (app/audio-buffer-auto.ts): once a second while the song plays it hands the engine's
 * `keepUp` to the decision, and when that says so it moves `autoBufferSize` in the prefs, which makes the services
 * reboot the engine with the new size (playback carries on, see EngineHost.reboot). It says so in a toast.
 * A step up (playback struggling) happens at once; a step down (trying a quicker size) waits until playback stops,
 * so a song that plays fine never drops out for it.
 */
import type { EngineApi } from '@engine/api';
import { AutoBuffer } from './audio-buffer-auto';
import { effectiveBuffer, type AudioBufferSize, type PrefsStore } from './stores/prefs';
import type { SessionStore } from './stores/session';

const NAMES: Record<AudioBufferSize, string> = { small: 'a small', medium: 'a medium', large: 'a large' };
const ORDER: AudioBufferSize[] = ['small', 'medium', 'large'];

export function watchAutoBuffer(
  engine: EngineApi,
  prefs: PrefsStore,
  session: SessionStore,
  /** A MIDI keyboard is connected. */
  midiOn: () => boolean,
  now: () => number = () => performance.now(),
): () => void {
  const auto = new AutoBuffer(effectiveBuffer(prefs.getState()));
  let timer: ReturnType<typeof setInterval> | null = null;
  /** A smaller size decided while playing: applied when playback stops. */
  let pendingDown: AudioBufferSize | null = null;
  const check = () => {
    const p = prefs.getState();
    if (p.audioBuffer !== 'auto') return;
    const next = auto.observe(engine.stats().keepUp, now(), p.typingPiano || midiOn());
    if (!next) return;
    const up = ORDER.indexOf(next) > ORDER.indexOf(pendingDown ?? p.autoBufferSize);
    if (!up) {
      pendingDown = next;
      return;
    }
    // Struggling: any step down waiting is off, and the size goes up now.
    pendingDown = null;
    if (next === p.autoBufferSize) return;
    prefs.getState().set({ autoBufferSize: next });
    session
      .getState()
      .toast(`Playback was struggling, so AGstudio moved to ${NAMES[next]} audio buffer: a little more delay, smoother sound.`);
  };
  const sync = () => {
    if (engine.playing && !timer) {
      auto.restart();
      timer = setInterval(check, 1000);
    } else if (!engine.playing && timer) {
      clearInterval(timer);
      timer = null;
      const down = pendingDown;
      pendingDown = null;
      if (down && prefs.getState().audioBuffer === 'auto' && down !== prefs.getState().autoBufferSize) {
        prefs.getState().set({ autoBufferSize: down });
        auto.startTrial();
        session
          .getState()
          .toast(`Playing smoothly, so AGstudio now uses ${NAMES[down]} audio buffer for a quicker response.`);
      }
    }
  };
  const offEngine = engine.subscribe(sync);
  // The size changed from outside (a choice in the settings, Auto switched on): the decision starts from there.
  let size = effectiveBuffer(prefs.getState());
  const offPrefs = prefs.subscribe((p) => {
    const chosen = effectiveBuffer(p);
    if (chosen !== size) {
      size = chosen;
      if (auto.size !== chosen) auto.stepped(chosen);
    }
  });
  sync();
  return () => {
    offEngine();
    offPrefs();
    if (timer) clearInterval(timer);
  };
}
