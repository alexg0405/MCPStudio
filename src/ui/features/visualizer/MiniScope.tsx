import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { showContextMenu } from '../../controls/ContextMenu';
import { onFrame } from '../../frame-loop';
import { useServices } from '../../services-context';
import { fitCanvas, readTheme } from '../../timeline/canvas';
import { openWindow } from '../../workspace/registry';
import { DB_FLOOR, drawScope, drawSpectrum, peakOf } from './draw';
import styles from './Visualizer.module.css';

const W = 112;
const H = 30;

/**
 * FL's toolbar oscilloscope: the waveform (or spectrum) of what you hear. Click switches between
 * them, double-click opens the Visualizer. Drawn on the frame loop; while stopped it only looks for
 * sound (previews, the typing piano) a few times a second.
 */
export function MiniScope() {
  const s = useServices();
  const pref = useStore(s.prefs, (p) => p.scopeMode);
  const mode = pref === 'spectrum' ? 'spectrum' : 'scope';
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || pref === 'off') return;
    const g = fitCanvas(canvas, W, H);
    const tap = s.engine.outputTap();
    const wave = new Float32Array(1024);
    let bins = new Float32Array(0);
    let frame = 0;
    let quiet = false;
    const flat = () => {
      g.clearRect(0, 0, W, H);
      g.fillStyle = readTheme().textFaint;
      g.globalAlpha = 0.5;
      g.fillRect(0, Math.floor(mode === 'scope' ? H / 2 : H - 1), W, 1);
      g.globalAlpha = 1;
    };
    flat();
    return onFrame(() => {
      if (!s.engine.playing && ++frame % 6 !== 0) return;
      if (!tap.active) return;
      const theme = readTheme();
      if (mode === 'scope') {
        if (!tap.waveform(wave, 0)) return;
        if (peakOf(wave) < 1e-4) {
          if (!quiet) flat();
          quiet = true;
          return;
        }
        quiet = false;
        g.clearRect(0, 0, W, H);
        drawScope(g, W, H, wave, theme.accent);
        return;
      }
      if (bins.length !== tap.fftSize / 2) bins = new Float32Array(tap.fftSize / 2);
      if (!tap.spectrum(bins)) return;
      let loudest = -Infinity;
      for (let i = 0; i < bins.length; i++) if ((bins[i] as number) > loudest) loudest = bins[i] as number;
      if (loudest < DB_FLOOR) {
        if (!quiet) flat();
        quiet = true;
        return;
      }
      quiet = false;
      g.clearRect(0, 0, W, H);
      drawSpectrum(g, W, H, bins, tap.sampleRate, tap.fftSize, theme.accent, 0.35);
    });
  }, [mode, pref, s]);

  if (pref === 'off') return null;
  return (
    <div
      className={styles.mini}
      role="button"
      tabIndex={0}
      aria-label={`Output display, showing the ${mode === 'scope' ? 'waveform' : 'spectrum'}. Press to show the ${mode === 'scope' ? 'spectrum' : 'waveform'}; the menu key offers more`}
      onClick={() => s.prefs.getState().set({ scopeMode: mode === 'scope' ? 'spectrum' : 'scope' })}
      onKeyDown={(e) => {
        // A div is not a button: Enter and Space press it by hand (the menu key already opens its context menu).
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.currentTarget.click();
      }}
      onDoubleClick={() => openWindow(s, 'visualizer')}
      onContextMenu={(e) => {
        e.preventDefault();
        showContextMenu(e, [
          { label: 'Waveform', checked: mode === 'scope', onSelect: () => s.prefs.getState().set({ scopeMode: 'scope' }) },
          { label: 'Spectrum', checked: mode === 'spectrum', onSelect: () => s.prefs.getState().set({ scopeMode: 'spectrum' }) },
          { kind: 'separator' },
          { label: 'Open the Visualizer', onSelect: () => openWindow(s, 'visualizer') },
          { label: 'Hide this display', onSelect: () => s.prefs.getState().set({ scopeMode: 'off' }), hint: 'View → Toolbar scope brings it back' },
        ]);
      }}
      data-hint={`What you hear: its ${mode === 'scope' ? 'waveform' : 'spectrum (low notes left, highs right)'}. Click for the ${mode === 'scope' ? 'spectrum' : 'waveform'}; double-click opens the Visualizer`}
    >
      <canvas ref={ref} className={styles.miniCanvas} style={{ width: W, height: H }} aria-hidden />
    </div>
  );
}
