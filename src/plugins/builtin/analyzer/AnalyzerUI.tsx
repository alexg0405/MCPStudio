import { useRef, type RefObject } from 'react';
import type { AudioTap, PluginUIProps } from '@agstudio/sdk';
import { Select, useFrame } from '@agstudio/sdk/ui';
import { clamp, drawScope, drawSpectrum, SCOPE_FRAMES } from './analyzer-canvas';
import type { analyzerParams } from './params';
import styles from './analyzer.module.css';

type Props = PluginUIProps<typeof analyzerParams>;

/** True peaks above this get the warning colour (streaming services ask for −1 dBTP). */
const PEAK_WARN_DB = -1;
/** A channel's peak bar turns to the "loud" colour above this. */
const PEAK_LOUD_DB = -6;
/** The channel peak bars span from this level up to 0 dB. */
const BAR_FLOOR_DB = -60;

const signed = (value: number) => `${value > 0.05 ? '+' : ''}${value.toFixed(1)}`;
const lufs = (value: number | undefined) =>
  value === undefined || !Number.isFinite(value) ? '– LUFS' : `${signed(value)} LUFS`;
const dbtp = (value: number | undefined) =>
  value === undefined || !Number.isFinite(value) ? '– dBTP' : `${signed(value)} dBTP`;

/** The tap when it is running and has an FFT to read, else undefined. */
const activeTap = (tap: AudioTap | undefined) => (tap?.active && tap.fftSize > 0 ? tap : undefined);

/** Writes text into an element only when it changed (no layout work on a frame where nothing moved). */
function setText(ref: RefObject<HTMLSpanElement | null>, text: string) {
  if (ref.current && ref.current.textContent !== text) ref.current.textContent = text;
}

/** Spectrum, oscilloscope, loudness, true peak and correlation, all painted on the frame loop. */
export function AnalyzerUI({ specs, values, setParam, tap }: Props) {
  return (
    <div className={styles.root}>
      <SpectrumPanel tap={tap} />
      <div className={styles.row}>
        <ScopePanel tap={tap} />
        <MeterPanel tap={tap} />
      </div>
      <div className={styles.footer}>
        <Select
          spec={specs.listen}
          value={values.listen}
          label="Listen"
          param="listen"
          onCommit={(value) => setParam('listen', value)}
        />
        <span className={styles.note}>
          Integrated loudness and the true-peak hold restart each time the song plays.
        </span>
      </div>
    </div>
  );
}

function SpectrumPanel({ tap }: { tap: AudioTap | undefined }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const bins = useRef<Float32Array<ArrayBuffer> | null>(null);
  useFrame(() => {
    const running = activeTap(tap);
    if (running && bins.current?.length !== running.fftSize / 2) bins.current = new Float32Array(running.fftSize / 2);
    drawSpectrum(canvas.current, running, bins.current ?? undefined);
  });
  return (
    <div
      className={`${styles.panel} ${styles.spectrum}`}
      data-hint="Spectrum: how loud each frequency is (20 Hz on the left to 20 kHz on the right, 0 dB at the top)"
    >
      <canvas ref={canvas} />
      <span className={styles.caption}>Spectrum</span>
    </div>
  );
}

function ScopePanel({ tap }: { tap: AudioTap | undefined }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const channels = useRef<{
    left: Float32Array<ArrayBuffer>;
    right: Float32Array<ArrayBuffer>;
    fftSize: number;
  } | null>(null);
  useFrame(() => {
    const running = activeTap(tap);
    if (running && channels.current?.fftSize !== running.fftSize) {
      const frames = Math.min(SCOPE_FRAMES, running.fftSize);
      channels.current = { left: new Float32Array(frames), right: new Float32Array(frames), fftSize: running.fftSize };
    }
    drawScope(canvas.current, running, channels.current?.left, channels.current?.right);
  });
  return (
    <div
      className={`${styles.panel} ${styles.scope}`}
      data-hint="Oscilloscope: the waveform of the last 40 ms (gold = left, blue = right)"
    >
      <canvas ref={canvas} />
      <span className={styles.caption}>Scope</span>
    </div>
  );
}

/** The loudness and true-peak numbers, the channel peak bars and the correlation meter. */
function MeterPanel({ tap }: { tap: AudioTap | undefined }) {
  const momentary = useRef<HTMLSpanElement>(null);
  const shortTerm = useRef<HTMLSpanElement>(null);
  const integrated = useRef<HTMLSpanElement>(null);
  const truePeak = useRef<HTMLSpanElement>(null);
  const correlation = useRef<HTMLSpanElement>(null);
  const leftBar = useRef<HTMLDivElement>(null);
  const rightBar = useRef<HTMLDivElement>(null);
  const correlationMark = useRef<HTMLDivElement>(null);

  useFrame(() => {
    const running = activeTap(tap);
    const read = (name: string) => running?.reading(name);
    setText(momentary, lufs(read('momentary')));
    setText(shortTerm, lufs(read('shortTerm')));
    setText(integrated, lufs(read('integrated')));
    const truePeakDb = read('truePeak');
    setText(truePeak, dbtp(truePeakDb));
    truePeak.current?.classList.toggle(styles.over as string, truePeakDb !== undefined && truePeakDb > PEAK_WARN_DB);
    const correlationValue = read('correlation') ?? 0;
    setText(correlation, `${correlationValue > 0 ? '+' : ''}${correlationValue.toFixed(2)}`);
    if (correlationMark.current) {
      correlationMark.current.style.left = `${((clamp(correlationValue, -1, 1) + 1) / 2) * 100}%`;
    }
    for (const [bar, reading] of [
      [leftBar, 'peakL'],
      [rightBar, 'peakR'],
    ] as const) {
      const db = read(reading);
      const element = bar.current;
      if (!element) continue;
      const fraction = db === undefined || !Number.isFinite(db) ? 0 : clamp((db - BAR_FLOOR_DB) / -BAR_FLOOR_DB, 0, 1);
      element.style.width = `${(fraction * 100).toFixed(1)}%`;
      element.style.background = peakBarColor(db);
    }
  });

  return (
    <div className={`${styles.panel} ${styles.meters}`}>
      <span className={styles.name} data-hint="Momentary loudness: the last 0.4 seconds, in LUFS">
        Momentary
      </span>
      <span className={styles.number} ref={momentary} data-hint="Momentary loudness (LUFS)">
        –
      </span>
      <span className={styles.name} data-hint="Short-term loudness: the last 3 seconds, in LUFS">
        Short-term
      </span>
      <span className={styles.number} ref={shortTerm} data-hint="Short-term loudness (LUFS)">
        –
      </span>
      <span
        className={styles.name}
        data-hint="Integrated loudness: the whole playback so far (silence left out), in LUFS. Streaming services aim for about −14"
      >
        Integrated
      </span>
      <span className={`${styles.number} ${styles.big}`} ref={integrated} data-hint="Integrated loudness (LUFS)">
        –
      </span>
      <span
        className={styles.name}
        data-hint="True peak: the highest level reached between samples since the song started, in dBTP (keep it under −1)"
      >
        True peak
      </span>
      <span className={styles.number} ref={truePeak} data-hint="True peak since playback started (dBTP)">
        –
      </span>
      <div className={styles.bars} data-hint="Peak level of the left and right channel (−60 to 0 dB)">
        <div className={styles.bar}>
          <div className={styles.barFill} ref={leftBar} />
        </div>
        <div className={styles.bar}>
          <div className={styles.barFill} ref={rightBar} />
        </div>
      </div>
      <span
        className={styles.name}
        data-hint="Correlation: +1 is mono, 0 is wide, below 0 means the sides cancel each other in mono"
      >
        Correlation
      </span>
      <span className={styles.number} ref={correlation} data-hint="Stereo correlation (−1 to +1)">
        –
      </span>
      <div className={styles.bars} data-hint="Correlation: right is mono-safe, left of the middle cancels in mono">
        <div className={styles.corr}>
          <div className={styles.corrMark} ref={correlationMark} />
        </div>
        <div className={styles.corrScale}>
          <span>−1</span>
          <span>0</span>
          <span>+1</span>
        </div>
      </div>
    </div>
  );
}

/** The colour of a channel's peak bar: red above the warning level, orange when loud, else the stylesheet's. */
function peakBarColor(db: number | undefined): string {
  if (db !== undefined && db > PEAK_WARN_DB) return 'var(--ag-meter-hi)';
  if (db !== undefined && db > PEAK_LOUD_DB) return 'var(--ag-meter-mid)';
  return '';
}
