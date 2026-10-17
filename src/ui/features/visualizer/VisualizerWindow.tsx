import { useEffect, useRef } from 'react';
import { MASTER } from '@core/model/types';
import { addEffect } from '@app/actions/mixer';
import { onFrame } from '../../frame-loop';
import { useServices } from '../../services-context';
import { fitCanvas, readTheme } from '../../timeline/canvas';
import { openWindow } from '../../workspace/registry';
import { DB_FLOOR, drawScope, drawSpectrum, drawSpectrumGrid, peakOf, peakText } from './draw';
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
    const spec = specRef.current;
    const scope = scopeRef.current;
    if (!spec || !scope) return;
    const tap = s.engine.outputTap();
    const left = new Float32Array(2048);
    const right = new Float32Array(2048);
    let bins = new Float32Array(0);
    const size = { sw: 0, sh: 0, ow: 0, oh: 0 };
    let frame = 0;
    // null: draw the next frame even if it is silent (first frame, or the canvas was resized).
    let silent: boolean | null = null;
    /** The peak last written to each readout (NaN: none yet). */
    const shownPeak = [Number.NaN, Number.NaN];
    const measure = () => {
      size.sw = spec.clientWidth;
      size.sh = spec.clientHeight;
      size.ow = scope.clientWidth;
      size.oh = scope.clientHeight;
      silent = null;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(spec);
    observer.observe(scope);
    const stop = onFrame(() => {
      if (!s.engine.playing && ++frame % 4 !== 0) return;
      const theme = readTheme();
      const active = tap.active;
      if (active && bins.length !== tap.fftSize / 2) bins = new Float32Array(tap.fftSize / 2);
      const gotSpec = active && tap.spectrum(bins);
      const gotWave = active && tap.waveform(left, 0) && tap.waveform(right, 1);
      const pl = gotWave ? peakOf(left) : 0;
      const pr = gotWave ? peakOf(right) : 0;
      const quiet = pl < 1e-4 && pr < 1e-4;
      if (quiet !== silent && idleRef.current) idleRef.current.style.display = quiet ? '' : 'none';
      if (quiet && silent === true) return;
      silent = quiet;

      const g = fitCanvas(spec, size.sw, size.sh);
      g.clearRect(0, 0, size.sw, size.sh);
      drawSpectrumGrid(g, size.sw, size.sh, theme);
      if (gotSpec && !quiet) {
        let loudest = -Infinity;
        for (let i = 0; i < bins.length; i++) if ((bins[i] as number) > loudest) loudest = bins[i] as number;
        if (loudest > DB_FLOOR) drawSpectrum(g, size.sw, size.sh, bins, tap.sampleRate, tap.fftSize, theme.accent, 0.3);
      }
      const o = fitCanvas(scope, size.ow, size.oh);
      o.clearRect(0, 0, size.ow, size.oh);
      o.fillStyle = theme.lineFaint;
      o.fillRect(0, Math.floor(size.oh / 2), size.ow, 1);
      if (gotWave && !quiet) {
        o.globalAlpha = 0.9;
        drawScope(o, size.ow, size.oh, left, theme.accent, 1.25);
        o.globalAlpha = 0.6;
        drawScope(o, size.ow, size.oh, right, theme.select, 1.25);
        o.globalAlpha = 1;
      }
      // The readouts are only rewritten when their peak changes (a steady level builds no text).
      if (peakL.current && pl !== shownPeak[0]) {
        shownPeak[0] = pl;
        peakL.current.textContent = peakText(pl);
      }
      if (peakR.current && pr !== shownPeak[1]) {
        shownPeak[1] = pr;
        peakR.current.textContent = peakText(pr);
      }
    });
    return () => {
      stop();
      observer.disconnect();
    };
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
