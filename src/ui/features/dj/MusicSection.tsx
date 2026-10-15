import { useEffect } from 'react';
import { useStore } from 'zustand';
import { library, loadLibrary, pickSongFiles } from '@app/dj/library';
import { Icon } from '../../controls/Icon';
import { useServices } from '../../services-context';
import styles from '../../shell/Browser.module.css';
import { openWindow } from '../../workspace/registry';

/** The browser's "Music" section: your songs for DJ mixes, and the way into the DJ window. */
export function MusicSection() {
  const services = useServices();
  const songs = useStore(library, (s) => s.songs);
  const loaded = useStore(library, (s) => s.loaded);
  useEffect(() => void loadLibrary(), []);
  const open = () => openWindow(services, 'dj');
  return (
    <>
      <button className={styles.item} onClick={open} data-hint="Open the DJ window: make a party mix from your own songs">
        <Icon name="sparkle" size={12} /> Make a DJ mix…
      </button>
      {songs.slice(0, 50).map((x) => (
        <button key={x.key} className={styles.item} style={{ paddingLeft: 24 }} onClick={open} data-hint={`${x.label}: in your music library (open the DJ window to mix it)`}>
          <Icon name="note" size={12} />
          {x.label}
        </button>
      ))}
      {songs.length > 50 && <div className={styles.empty}>… and {songs.length - 50} more in the DJ window</div>}
      {loaded && songs.length === 0 && <div className={styles.empty}>Your own songs (MP3, AAC, WAV, FLAC) for DJ mixes</div>}
      <button className={styles.item} onClick={() => void pickSongFiles(services)} data-hint="Add song files to your music library (they stay in this browser)">
        <Icon name="plus" size={12} /> Add music…
      </button>
    </>
  );
}
