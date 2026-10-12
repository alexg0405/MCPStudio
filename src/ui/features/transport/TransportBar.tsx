import { useStore } from 'zustand';
import { useServices, useView } from '../../services-context';
import { CommandButton } from '../../shell/Toolbar';
import { stubTransport } from './stub-transport';
import styles from './Transport.module.css';

function ModeSwitch() {
  const services = useServices();
  const mode = useView((s) => s.mode);
  return (
    <button
      className={styles.modeSwitch}
      tabIndex={-1}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => services.commands.run('transport.toggleMode')}
      data-hint="Pattern mode loops the current pattern; song mode plays the playlist (L)"
    >
      <span className={mode === 'pattern' ? styles.modeOn : ''}>
        <i className={styles.led} />
        PAT
      </span>
      <span className={mode === 'song' ? styles.modeOn : ''}>
        <i className={styles.led} />
        SONG
      </span>
    </button>
  );
}

export function TransportBar() {
  const playing = useStore(stubTransport, (s) => s.playing);
  return (
    <div className={styles.transport}>
      <ModeSwitch />
      <CommandButton command="transport.playPause" icon={playing ? 'pause' : 'play'} className={styles.play} />
      <CommandButton command="transport.stop" icon="stop" />
      <CommandButton command="transport.record" icon="record" className={styles.record} />
      <div className={styles.lcd} data-hint="Tempo in beats per minute">
        <span className={styles.lcdValue}>130.000</span>
        <span className={styles.lcdLabel}>BPM</span>
      </div>
      <div className={`${styles.lcd} ${styles.time}`} data-hint="Song position (bar : step : tick)">
        <span className={styles.lcdValue}>1:01:000</span>
        <span className={styles.lcdLabel}>B:S:T</span>
      </div>
    </div>
  );
}
