import { useEffect, useRef, useState } from 'react';
import { setBpm } from '@core/ops/notes';
import { formatBST } from '@core/time/ppq';
import { useDoc, useEngineStatus, useServices, useView } from '../../services-context';
import { CommandButton } from '../../shell/Toolbar';
import { DragNumber } from '../../controls/DragNumber';
import { paramInfoFor, showParamMenu } from '../../param-menu';
import { useGestureEdit } from '../../edit';
import { onFrame } from '../../frame-loop';
import { useParamStatus } from '@agstudio/sdk/ui';
import { RecordSource } from '../recording/RecordSource';
import styles from './Transport.module.css';

function ModeSwitch() {
  const services = useServices();
  const mode = useView((s) => s.mode);
  return (
    <button
      className={styles.modeSwitch}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => services.commands.run('transport.toggleMode')}
      aria-label={`${mode === 'pattern' ? 'Pattern' : 'Song'} mode, press to switch to ${mode === 'pattern' ? 'song' : 'pattern'} mode`}
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
    // The last tempo shown (a number, compared first: the text is only built when it changes).
    let shownBpm = Number.NaN;
    let shownText = '';
    return onFrame(() => {
      // The DragNumber's own text node (absent while it's being typed into).
      const text = box.current?.firstElementChild?.firstChild;
      if (!text || text.nodeType !== Node.TEXT_NODE) return;
      const doc = services.doc.getState().project.transport.bpm;
      const live = services.engine.playing ? services.engine.tempoNow() : doc;
      const bpm = Math.abs(live - doc) < 5e-4 ? doc : live;
      if (bpm === shownBpm && text.nodeValue === shownText) return;
      shownBpm = bpm;
      shownText = bpm.toFixed(3);
      text.nodeValue = shownText;
      box.current?.toggleAttribute('data-live', shownText !== doc.toFixed(3));
    });
  }, [services]);
  const hint = status
    ? `Tempo in BPM: drag, scroll, or click to type · ${status.hint} · while playing it shows the tempo you hear`
    : 'Tempo in BPM: drag, scroll, or click to type (10–522, decimals like 140.5 work) · right-click to automate it';
  return (
    <div
      ref={box}
      className={`${styles.lcd} ${status ? styles.lcdAutomated : ''}`}
      data-tour="tempo"
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
        editHint="Type a tempo in BPM (10–522, e.g. 140.5) · Enter sets it, Esc cancels"
        label="Tempo in BPM"
      />
      <span className={styles.lcdLabel}>{status?.kind === 'automated' ? 'BPM · AUTO' : 'BPM'}</span>
    </div>
  );
}

/**
 * Song position, updated every frame outside React. It holds both forms ("1:01:000" and "1:01"): a wide
 * toolbar shows the full one; a narrow one (see the container queries in Transport.module.css) shows
 * bar:step and gives the room back, and a click shows the ticks too until it is clicked again.
 */
function Position() {
  const services = useServices();
  const full = useRef<HTMLSpanElement>(null);
  const short = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let last = '';
    // The whole tick last formatted: the text only changes when it does (formatBST floors the tick), so a
    // frame that stays on the same tick builds no string.
    let lastTick = Number.NaN;
    let lastTs: unknown = null;
    return onFrame(() => {
      const fullEl = full.current;
      const shortEl = short.current;
      if (!fullEl || !shortEl) return;
      const ts = services.doc.getState().project.transport.timeSig;
      const v = services.view.getState();
      const tick = services.engine.playing ? services.engine.playhead() : v.mode === 'song' ? v.songStart : 0;
      const whole = Math.floor(tick);
      if (whole === lastTick && ts === lastTs) return;
      lastTick = whole;
      lastTs = ts;
      const text = formatBST(tick, ts);
      if (text === last) return;
      fullEl.textContent = text;
      shortEl.textContent = text.slice(0, text.lastIndexOf(':'));
      last = text;
    });
  }, [services]);
  return (
    <button
      className={`${styles.lcd} ${styles.time}`}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => setExpanded((on) => !on)}
      data-expanded={expanded || undefined}
      data-hint="Song position (bar : step : tick). In a narrow window it shows bar : step; click to show the ticks too"
      aria-label="Song position"
      aria-pressed={expanded}
    >
      <span ref={full} className={`${styles.lcdValue} ${styles.timeFull}`}>
        1:01:000
      </span>
      <span ref={short} className={`${styles.lcdValue} ${styles.timeShort}`}>
        1:01
      </span>
      <span className={styles.lcdLabel}>B:S:T</span>
    </button>
  );
}

export function TransportBar() {
  const { playing } = useEngineStatus();
  return (
    <div className={styles.transport} role="toolbar" aria-label="Transport" data-roving>
      <ModeSwitch />
      <CommandButton command="transport.playPause" icon={playing ? 'pause' : 'play'} className={styles.play} />
      <CommandButton command="transport.stop" icon="stop" />
      <CommandButton command="transport.record" icon="record" className={styles.record} />
      <RecordSource />
      <CommandButton command="transport.metronome" icon="metronome" className={styles.metronome} />
      <Tempo />
      <Position />
    </div>
  );
}
