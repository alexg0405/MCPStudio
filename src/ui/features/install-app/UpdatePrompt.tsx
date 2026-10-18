import { useState, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { useServices } from '../../services-context';
import styles from './UpdatePrompt.module.css';

/**
 * "Update ready — reload": a new version of the app is downloaded and waiting (see src/app/pwa). Nothing reloads by
 * itself; while a song plays the button waits, since a reload cuts the sound.
 */
export function UpdatePrompt() {
  const s = useServices();
  const ready = useStore(s.pwa.store, (p) => p.updateReady);
  // Playing changes only when the transport starts or stops: no per-frame work here.
  const playing = useSyncExternalStore(
    (fn) => s.engine.subscribe(fn),
    () => s.engine.playing,
  );
  const [later, setLater] = useState(false);
  if (!ready || later) return null;
  return (
    <div className={styles.prompt} role="status" data-hint="A new version of AGstudio has been downloaded and is waiting to start">
      <span className={styles.text}>Update ready</span>
      <button
        className={styles.reload}
        disabled={playing}
        onClick={() => s.pwa.applyUpdate()}
        data-hint={
          playing
            ? 'Stop playback first: reloading cuts the sound'
            : 'Restart AGstudio with the new version. Your project is kept (it is autosaved) and unsaved changes are asked about first'
        }
      >
        Reload
      </button>
      <button className={styles.later} onClick={() => setLater(true)} data-hint="Keep working with this version for now (Help → Update ready, reload, brings it back)">
        Later
      </button>
    </div>
  );
}
