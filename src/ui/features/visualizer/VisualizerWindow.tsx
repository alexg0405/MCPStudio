import { useEffect, useRef } from 'react';
import { MASTER } from '@core/model/types';
import { addEffect } from '@app/actions/mixer';
import { useServices } from '../../services-context';
import { openWindow } from '../../workspace/registry';
import { VisualizerController } from './controller';
import styles from './Visualizer.module.css';

const ANALYZER = 'agstudio.analyzer';

/**
 * What you hear, bigger: the spectrum (low notes left, highs right; louder is higher) over a grid,
 * the left and right waveforms, and their peaks. Loudness (LUFS) is the Analyzer's job: one click
 * puts it on the master.
 */
export function VisualizerWindow() {
  const s = useServices();
  const specRef = useRef<HTMLCanvasElement>(null);
  const scopeRef = useRef<HTMLCanvasElement>(null);
  const peakL = useRef<HTMLElement>(null);
  const peakR = useRef<HTMLElement>(null);
  const idleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const spectrum = specRef.current;
    const scope = scopeRef.current;
    if (!spectrum || !scope) return;
    const controller = new VisualizerController(s, { spectrum, scope, peakLeft: peakL.current, peakRight: peakR.current, idle: idleRef.current });
    return controller.start();
  }, [s]);

  const loudness = () => {
    const master = s.doc.getState().project.mixer.inserts[MASTER];
    const there = master?.fx.find((f) => f.plugin.pluginId === ANALYZER);
    const slotId = there?.id ?? addEffect(s, MASTER, ANALYZER);
    if (slotId) openWindow(s, 'plugin', { kind: 'fx', insertId: MASTER, slotId });
  };

  return (
    <div className={styles.window}>
      <div className={styles.panel} data-hint="The spectrum of what you hear: low notes on the left, highs on the right; higher means louder">
        <canvas ref={specRef} className={styles.canvas} />
        <div ref={idleRef} className={styles.idle}>
          Press play: this shows what you hear (the master track, previews and the metronome).
        </div>
      </div>
      <div className={styles.scopePanel} data-hint="The waveforms: left channel in the accent color (gold), right channel in blue">
        <canvas ref={scopeRef} className={styles.canvas} />
      </div>
      <div className={styles.footer}>
        <span data-hint="The loudest sample in the last ~40 ms, in dB below full scale (0 dB). Above −1 dB risks clipping">
          Peak L <b ref={peakL}>−∞ dB</b> R <b ref={peakR}>−∞ dB</b>
        </span>
        <span className={styles.spacer} />
        <button
          className={styles.button}
          onClick={loudness}
          data-hint="Loudness (LUFS), true peak and stereo correlation: puts the Analyzer on the master track (or opens it)"
        >
          Loudness (LUFS)…
        </button>
      </div>
    </div>
  );
}
