/**
 * Runs the Auto audio buffer (app/audio-buffer-auto.ts): once a second while the song plays it hands the engine's
 * `keepUp` to the decision, and when that says so it moves `autoBufferSize` in the prefs, which makes the services
 * reboot the engine with the new size (playback carries on, see EngineHost.reboot). It says so in a toast.
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
  const check = () => {
    const p = prefs.getState();
    if (p.audioBuffer !== 'auto') return;
    const next = auto.observe(engine.stats().keepUp, now(), p.typingPiano || midiOn());
    if (!next) return;
    const up = ORDER.indexOf(next) > ORDER.indexOf(p.autoBufferSize);
    prefs.getState().set({ autoBufferSize: next });
    session
      .getState()
      .toast(
        up
          ? `Playback was struggling, so AGstudio moved to ${NAMES[next]} audio buffer: a little more delay, smoother sound.`
          : `Playing smoothly, so AGstudio is trying ${NAMES[next]} audio buffer for a quicker response.`,
      );
  };
  const sync = () => {
    if (engine.playing && !timer) {
      auto.restart();
      timer = setInterval(check, 1000);
    } else if (!engine.playing && timer) {
      clearInterval(timer);
      timer = null;
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
