import { useEffect, useRef } from 'react';
import { setBpm } from '@core/ops/notes';
import { formatBST } from '@core/time/ppq';
import { useDoc, useEngineStatus, useServices, useView } from '../../services-context';
import { CommandButton } from '../../shell/Toolbar';
import { DragNumber } from '../../controls/DragNumber';
import { paramInfoFor, showParamMenu } from '../../param-menu';
import { useGestureEdit } from '../../edit';
import { onFrame } from '../../frame-loop';
import { useParamStatus } from '@agstudio/sdk/ui';
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
  const services = useServices();
  const bpm = useDoc((p) => p.transport.bpm);
  const status = useParamStatus('tempo');
  const edit = useGestureEdit<number>('Tempo', (d, v) => setBpm(d, Math.round(v * 1000) / 1000), 'tempo');
  const box = useRef<HTMLDivElement>(null);
  // While playing, show the tempo being heard (tempo automation moves it): written straight into
  // the display's text on the frame loop, no React renders.
  useEffect(() => {
    let shown = '';
    return onFrame(() => {
      // The DragNumber's own text node (absent while it's being typed into).
      const text = box.current?.firstElementChild?.firstChild;
      if (!text || text.nodeType !== Node.TEXT_NODE) return;
      const doc = services.doc.getState().project.transport.bpm;
      const live = services.engine.playing ? services.engine.tempoNow() : doc;
      const next = (Math.abs(live - doc) < 5e-4 ? doc : live).toFixed(3);
      if (next === shown && text.nodeValue === next) return;
      shown = next;
      text.nodeValue = next;
      box.current?.toggleAttribute('data-live', next !== doc.toFixed(3));
    });
  }, [services]);
  const hint = status
    ? `Tempo (BPM) · ${status.hint} · while playing it shows the tempo you hear`
    : 'Tempo (BPM): drag up/down or scroll to change, double-click to type · right-click to automate it';
  return (
    <div
      ref={box}
      className={`${styles.lcd} ${status ? styles.lcdAutomated : ''}`}
      onContextMenu={(e) => {
        const info = paramInfoFor(services, { kind: 'tempo' });
        if (!info) return;
        e.preventDefault();
        showParamMenu(e, info, services);
      }}
    >
      <DragNumber
        className={styles.lcdValue}
        value={bpm}
        min={10}
        max={522}
        perPixel={0.25}
        step={1}
        format={(v) => v.toFixed(3)}
        {...edit}
        hint={hint}
      />
      <span className={styles.lcdLabel}>{status?.kind === 'automated' ? 'BPM · AUTO' : 'BPM'}</span>
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
      const v = services.view.getState();
      const tick = services.engine.playing ? services.engine.playhead() : v.mode === 'song' ? v.songStart : 0;
      const text = formatBST(tick, ts);
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
