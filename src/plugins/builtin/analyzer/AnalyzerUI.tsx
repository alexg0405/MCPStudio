import { useRef } from 'react';
import type { AudioTap, PluginUIProps } from '@agstudio/sdk';
import { Select, themeColors, useFrame } from '@agstudio/sdk/ui';
import type { analyzerParams } from './params';
import styles from './analyzer.module.css';

type Props = PluginUIProps<typeof analyzerParams>;

const F_MIN = 20;
const F_MAX = 20000;
const FLOOR_DB = -96;
const SCOPE_FRAMES = 2048;
/** True peaks above this get the warning colour (streaming services ask for −1 dBTP). */
const PEAK_WARN = -1;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const freqAt = (n: number) => F_MIN * Math.pow(F_MAX / F_MIN, n);

/** Sizes a canvas's backing store to its CSS box; returns its context in CSS pixels. */
function prepare(c: HTMLCanvasElement | null): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const ctx = c?.getContext('2d');
  if (!c || !ctx) return null;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, c.clientWidth);
  const h = Math.max(1, c.clientHeight);
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

const signed = (v: number) => `${v > 0.05 ? '+' : ''}${v.toFixed(1)}`;
const lufs = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? '– LUFS' : `${signed(v)} LUFS`);
const dbtp = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? '– dBTP' : `${signed(v)} dBTP`);

/** Spectrum, oscilloscope, loudness, true peak and correlation, all painted on the frame loop. */
export function AnalyzerUI({ specs, values, setParam, tap }: Props) {
  const spectrumRef = useRef<HTMLCanvasElement>(null);
  const scopeRef = useRef<HTMLCanvasElement>(null);
  const momentaryRef = useRef<HTMLSpanElement>(null);
  const shortTermRef = useRef<HTMLSpanElement>(null);
  const integratedRef = useRef<HTMLSpanElement>(null);
  const truePeakRef = useRef<HTMLSpanElement>(null);
  const correlationRef = useRef<HTMLSpanElement>(null);
  const barL = useRef<HTMLDivElement>(null);
  const barR = useRef<HTMLDivElement>(null);
  const corrMark = useRef<HTMLDivElement>(null);
  const buffers = useRef<{
    bins: Float32Array<ArrayBuffer>;
    left: Float32Array<ArrayBuffer>;
    right: Float32Array<ArrayBuffer>;
  } | null>(null);

  useFrame(() => {
    const t: AudioTap | undefined = tap;
    const active = !!t?.active && t.fftSize > 0;
    let b = buffers.current;
    if (active && (!b || b.bins.length !== t.fftSize / 2)) {
      b = buffers.current = {
        bins: new Float32Array(t.fftSize / 2),
        left: new Float32Array(Math.min(SCOPE_FRAMES, t.fftSize)),
        right: new Float32Array(Math.min(SCOPE_FRAMES, t.fftSize)),
      };
    }
    drawSpectrum(spectrumRef.current, active ? t : undefined, b?.bins);
    drawScope(scopeRef.current, active ? t : undefined, b?.left, b?.right);
    const read = (name: string) => (active ? t.reading(name) : undefined);
    const set = (ref: { current: HTMLSpanElement | null }, s: string) => {
      if (ref.current && ref.current.textContent !== s) ref.current.textContent = s;
    };
    set(momentaryRef, lufs(read('momentary')));
    set(shortTermRef, lufs(read('shortTerm')));
    set(integratedRef, lufs(read('integrated')));
    const tp = read('truePeak');
    set(truePeakRef, dbtp(tp));
    truePeakRef.current?.classList.toggle(styles.over as string, tp !== undefined && tp > PEAK_WARN);
    const corr = read('correlation') ?? 0;
    set(correlationRef, `${corr > 0 ? '+' : ''}${corr.toFixed(2)}`);
    if (corrMark.current) corrMark.current.style.left = `${((clamp(corr, -1, 1) + 1) / 2) * 100}%`;
    for (const [ref, name] of [
      [barL, 'peakL'],
      [barR, 'peakR'],
    ] as const) {
      const db = read(name);
      const el = ref.current;
      if (!el) continue;
      const fraction = db === undefined || !Number.isFinite(db) ? 0 : clamp((db + 60) / 60, 0, 1);
      el.style.width = `${(fraction * 100).toFixed(1)}%`;
      el.style.background =
        db !== undefined && db > PEAK_WARN
          ? 'var(--ag-meter-hi)'
          : db !== undefined && db > -6
            ? 'var(--ag-meter-mid)'
            : '';
    }
  });

  return (
    <div className={styles.root}>
      <div
        className={`${styles.panel} ${styles.spectrum}`}
        data-hint="Spectrum: how loud each frequency is (20 Hz on the left to 20 kHz on the right, 0 dB at the top)"
      >
        <canvas ref={spectrumRef} />
        <span className={styles.caption}>Spectrum</span>
      </div>
      <div className={styles.row}>
        <div
          className={`${styles.panel} ${styles.scope}`}
          data-hint="Oscilloscope: the waveform of the last 40 ms (gold = left, blue = right)"
        >
          <canvas ref={scopeRef} />
          <span className={styles.caption}>Scope</span>
        </div>
        <div className={`${styles.panel} ${styles.meters}`}>
          <span className={styles.name} data-hint="Momentary loudness: the last 0.4 seconds, in LUFS">
            Momentary
          </span>
          <span className={styles.number} ref={momentaryRef} data-hint="Momentary loudness (LUFS)">
            –
          </span>
          <span className={styles.name} data-hint="Short-term loudness: the last 3 seconds, in LUFS">
            Short-term
          </span>
          <span className={styles.number} ref={shortTermRef} data-hint="Short-term loudness (LUFS)">
            –
          </span>
          <span
            className={styles.name}
            data-hint="Integrated loudness: the whole playback so far (silence left out), in LUFS. Streaming services aim for about −14"
          >
            Integrated
          </span>
          <span className={`${styles.number} ${styles.big}`} ref={integratedRef} data-hint="Integrated loudness (LUFS)">
            –
          </span>
          <span
            className={styles.name}
            data-hint="True peak: the highest level reached between samples since the song started, in dBTP (keep it under −1)"
          >
            True peak
          </span>
          <span className={styles.number} ref={truePeakRef} data-hint="True peak since playback started (dBTP)">
            –
          </span>
          <div className={styles.bars} data-hint="Peak level of the left and right channel (−60 to 0 dB)">
            <div className={styles.bar}>
              <div className={styles.barFill} ref={barL} />
            </div>
            <div className={styles.bar}>
              <div className={styles.barFill} ref={barR} />
            </div>
          </div>
          <span
            className={styles.name}
            data-hint="Correlation: +1 is mono, 0 is wide, below 0 means the sides cancel each other in mono"
          >
            Correlation
          </span>
          <span className={styles.number} ref={correlationRef} data-hint="Stereo correlation (−1 to +1)">
            –
          </span>
          <div className={styles.bars} data-hint="Correlation: right is mono-safe, left of the middle cancels in mono">
            <div className={styles.corr}>
              <div className={styles.corrMark} ref={corrMark} />
            </div>
            <div className={styles.corrScale}>
              <span>−1</span>
              <span>0</span>
              <span>+1</span>
            </div>
          </div>
        </div>
      </div>
      <div className={styles.footer}>
        <Select
          spec={specs.listen}
          value={values.listen}
          label="Listen"
          param="listen"
          onCommit={(v) => setParam('listen', v)}
        />
        <span className={styles.note}>
          Integrated loudness and the true-peak hold restart each time the song plays.
        </span>
      </div>
    </div>
  );
}

function drawSpectrum(
  c: HTMLCanvasElement | null,
  tap: AudioTap | undefined,
  bins: Float32Array<ArrayBuffer> | undefined,
) {
  const p = prepare(c);
  if (!p) return;
  const { ctx, w, h } = p;
  const theme = themeColors();
  // Grid: octaves and 12 dB steps.
  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = Math.round((Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * w) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let db = -12; db > FLOOR_DB; db -= 12) {
    const y = Math.round((db / FLOOR_DB) * h) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
  if (!tap || !bins || !tap.spectrum(bins)) return;
  const binHz = tap.sampleRate / tap.fftSize;
  const columns = Math.max(2, Math.round(w / 2));
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let i = 0; i <= columns; i++) {
    const lo = clamp(Math.floor(freqAt((i - 0.5) / columns) / binHz), 1, bins.length - 1);
    const hi = clamp(Math.ceil(freqAt((i + 0.5) / columns) / binHz), lo + 1, bins.length);
    let peak = -Infinity;
    for (let k = lo; k < hi; k++) if ((bins[k] as number) > peak) peak = bins[k] as number;
    ctx.lineTo((i / columns) * w, (clamp(peak, FLOOR_DB, 0) / FLOOR_DB) * h);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  // The accent as a wash that fades towards the floor, under a bright edge.
  const wash = ctx.createLinearGradient(0, 0, 0, h);
  wash.addColorStop(0, theme.accent);
  wash.addColorStop(1, 'transparent');
  ctx.fillStyle = wash;
  ctx.globalAlpha = 0.5;
  ctx.fill();
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = theme.accent;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawScope(
  c: HTMLCanvasElement | null,
  tap: AudioTap | undefined,
  left: Float32Array<ArrayBuffer> | undefined,
  right: Float32Array<ArrayBuffer> | undefined,
) {
  const p = prepare(c);
  if (!p) return;
  const { ctx, w, h } = p;
  const theme = themeColors();
  ctx.strokeStyle = theme.lineStrong;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2 + 0.5);
  ctx.lineTo(w, h / 2 + 0.5);
  ctx.stroke();
  if (!tap || !left || !right || !tap.waveform(left, 0) || !tap.waveform(right, 1)) return;
  // Start at a rising zero crossing of the left channel so the picture stands still.
  const shown = Math.floor(left.length / 2);
  let start = 0;
  for (let i = 1; i < left.length - shown; i++) {
    if ((left[i - 1] as number) < 0 && (left[i] as number) >= 0) {
      start = i;
      break;
    }
  }
  const trace = (data: Float32Array, colour: string) => {
    ctx.strokeStyle = colour;
    ctx.beginPath();
    for (let x = 0; x <= w; x++) {
      const v = data[start + Math.floor((x / w) * (shown - 1))] as number;
      const y = h / 2 - clamp(v, -1, 1) * (h / 2 - 2);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  ctx.globalAlpha = 0.8;
  trace(right, theme.select);
  ctx.globalAlpha = 0.95;
  trace(left, theme.accent);
  ctx.globalAlpha = 1;
}
