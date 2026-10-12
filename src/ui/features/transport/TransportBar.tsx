import { useEffect, useRef } from 'react';
import { setBpm } from '@core/ops/notes';
import { formatBST } from '@core/time/ppq';
import { useDoc, useEngineStatus, useServices, useView } from '../../services-context';
import { CommandButton } from '../../shell/Toolbar';
import { DragNumber } from '../../controls/DragNumber';
import { useGestureEdit } from '../../edit';
import { onFrame } from '../../frame-loop';
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

function Tempo() {
  const bpm = useDoc((p) => p.transport.bpm);
  const edit = useGestureEdit<number>('Tempo', (d, v) => setBpm(d, Math.round(v * 1000) / 1000), 'tempo');
  return (
    <div className={styles.lcd}>
      <DragNumber
        className={styles.lcdValue}
        value={bpm}
        min={10}
        max={522}
        perPixel={0.25}
        step={1}
        format={(v) => v.toFixed(3)}
        {...edit}
        hint="Tempo in BPM. Drag up/down (Shift = fine), scroll, or double-click to type"
      />
      <span className={styles.lcdLabel}>BPM</span>
    </div>
  );
}

/** Song position, updated every frame outside React. */
function Position() {
  const services = useServices();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let last = '';
    return onFrame(() => {
      const ts = services.doc.getState().project.transport.timeSig;
      const text = formatBST(services.engine.playhead(), ts);
      if (text !== last && ref.current) {
        ref.current.textContent = text;
        last = text;
      }
    });
  }, [services]);
  return (
    <div className={`${styles.lcd} ${styles.time}`} data-hint="Song position (bar : step : tick)">
      <span ref={ref} className={styles.lcdValue}>
        1:01:000
      </span>
      <span className={styles.lcdLabel}>B:S:T</span>
    </div>
  );
}

export function TransportBar() {
  const { playing } = useEngineStatus();
  return (
    <div className={styles.transport}>
      <ModeSwitch />
      <CommandButton command="transport.playPause" icon={playing ? 'pause' : 'play'} className={styles.play} />
      <CommandButton command="transport.stop" icon="stop" />
      <CommandButton command="transport.record" icon="record" className={styles.record} />
      <Tempo />
      <Position />
    </div>
  );
}
