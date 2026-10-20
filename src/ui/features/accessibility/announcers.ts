/**
 * What AGstudio says through the live region without being asked: playback and recording state, the mode
 * switch, every toast (render finished, saved, an error) and the Studio's replies. Each listens to a store that
 * already exists, so nothing here runs per frame and playing makes no React commits.
 */
import type { Services } from '@app/services';
import { announce } from '../../a11y/announce';

/** The longest Studio reply read out in full; a longer one is cut at a word and says it goes on. */
const MAX_REPLY_CHARS = 400;

/** The start of `text`, cut at a word when it is longer than `limit`. */
export function shortened(text: string, limit: number = MAX_REPLY_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}… (the rest is in the Studio window)`;
}

/** "Playing" and "Stopped", when the engine starts or stops. */
function announcePlayback(services: Services): () => void {
  let wasPlaying = services.engine.playing;
  return services.engine.subscribe(() => {
    const isPlaying = services.engine.playing;
    if (isPlaying === wasPlaying) return;
    wasPlaying = isPlaying;
    announce(isPlaying ? 'Playing' : 'Stopped');
  });
}

/** "Recording armed", "Recording off" and "Recording" (armed and playing). */
function announceRecording(services: Services): () => void {
  return services.recording.store.subscribe((state, previous) => {
    if (state.recording && !previous.recording) announce('Recording');
    else if (state.armed !== previous.armed) announce(state.armed ? 'Recording armed. Press play to start.' : 'Recording off');
  });
}

/** "Song mode" and "Pattern mode", when the PAT/SONG switch changes. */
function announceMode(services: Services): () => void {
  return services.view.subscribe((state, previous) => {
    if (state.mode !== previous.mode) announce(state.mode === 'song' ? 'Song mode: plays the playlist' : 'Pattern mode: loops the current pattern');
  });
}

/** Every new toast: errors interrupt, the rest wait their turn. */
function announceToasts(services: Services): () => void {
  return services.session.subscribe((state, previous) => {
    if (state.toasts === previous.toasts) return;
    const known = new Set(previous.toasts.map((toast) => toast.id));
    for (const toast of state.toasts) {
      if (known.has(toast.id)) continue;
      if (toast.kind === 'error') announce(`Error: ${toast.text}`, 'assertive');
      else announce(toast.text);
    }
  });
}

/** The Studio's work and replies: "Studio is working", then what it answered. */
function announceStudio(services: Services): () => void {
  return services.assistant.store.subscribe((state, previous) => {
    if (state.phase !== previous.phase && state.phase === 'thinking') announce('Studio is working');
    if (state.messages === previous.messages) return;
    const known = new Set(previous.messages.map((message) => message.id));
    const reply = state.messages.filter((message) => message.from === 'assistant' && !known.has(message.id)).at(-1);
    if (!reply) return;
    announce(`Studio: ${shortened(reply.text)}`, reply.error ? 'assertive' : 'polite');
  });
}

/** Starts every announcer; returns how to stop them. */
export function installAnnouncers(services: Services): () => void {
  const stops = [
    announcePlayback(services),
    announceRecording(services),
    announceMode(services),
    announceToasts(services),
    announceStudio(services),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
