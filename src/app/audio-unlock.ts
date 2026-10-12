import type { EngineApi } from '@engine/api';

/**
 * Browsers start audio suspended until a user gesture. Resume on the first pointer/key press
 * anywhere (and again if the context gets suspended later, e.g. after the device changed).
 */
export function installAudioUnlock(engine: EngineApi): () => void {
  const onGesture = () => {
    if (engine.state !== 'running') void engine.resume();
  };
  window.addEventListener('pointerdown', onGesture, { capture: true });
  window.addEventListener('keydown', onGesture, { capture: true });
  return () => {
    window.removeEventListener('pointerdown', onGesture, { capture: true });
    window.removeEventListener('keydown', onGesture, { capture: true });
  };
}
