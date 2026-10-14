import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { formatValue, type ParamValue, type PluginUIProps } from '@agstudio/sdk';
import { emitHint, Knob, Select, Toggle, useFrame } from '@agstudio/sdk/ui';
import { bandResponseDb, hasGain, sectionBuffer, type BandType } from './design.kernel';
import { BAND_COUNT, bandIds, TYPE_LABELS, type eqProParams } from './params';
import styles from './eq-pro.module.css';

type Props = PluginUIProps<typeof eqProParams>;

/** One colour per band (handles, tabs, the selected band's fill). */
const COLORS = ['#e5574d', '#ff9a3c', '#e3cf46', '#9fde5a', '#4fd1b5', '#5aa4e8', '#9b7cf0', '#e06cc0'];
const F_MIN = 20;
const F_MAX = 20000;
/** The curve's vertical range: ±24 dB (the gain range). */
const DB_RANGE = 24;
/** The spectrum's range: 0 dBFS at the top, this at the bottom. */
const SPECTRUM_FLOOR = -96;
const MARGIN = 10;
const GRID_FREQS = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const GRID_DB = [-18, -12, -6, 6, 12, 18];
const Q_STEP = 1.12;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const norm = (f: number) => Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN);
const freqAt = (n: number) => F_MIN * Math.pow(F_MAX / F_MIN, clamp(n, 0, 1));
const yOf = (db: number, h: number) => h / 2 - (db / DB_RANGE) * (h / 2 - MARGIN);
const dbAt = (y: number, h: number) => ((h / 2 - y) / (h / 2 - MARGIN)) * DB_RANGE;

interface BandView {
  b: number;
  on: boolean;
  type: BandType;
  freq: number;
  gain: number;
  q: number;
}

/** "Band 3 · Bell: 2.40 kHz, +3.5 dB, Q 1.20" (what a handle's hint and the readout say). */
function describe(band: BandView, specs: Props['specs']): string {
  const ids = bandIds(band.b);
  const s = specs as unknown as Record<string, Parameters<typeof formatValue>[0]>;
  const parts = [formatValue(s[ids.freq]!, band.freq)];
  if (hasGain(band.type)) parts.push(formatValue(s[ids.gain]!, band.gain));
  parts.push(`Q ${formatValue(s[ids.q]!, band.q)}`);
  return `Band ${band.b} · ${TYPE_LABELS[band.type]}${band.on ? '' : ' (off)'}: ${parts.join(', ')}`;
}

/** Bands a double-click on empty space may switch on, bells first. */
const FREE_ORDER = [3, 4, 5, 6, 2, 7, 1, 8];

export function EqProUI({ specs, values, beginEdit, setParam: setTyped, endEdit, openParamMenu, tap }: Props) {
  // Band params are addressed by id strings (b3Freq…).
  const v = values as unknown as Record<string, ParamValue>;
  const begin = beginEdit as (param: string) => void;
  const end = endEdit as (param: string) => void;
  const setParam = setTyped as (param: string, value: ParamValue) => void;
  const spec = specs as unknown as Record<string, Parameters<typeof formatValue>[0]>;
  const [selected, setSelected] = useState(3);
  const graph = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 480, h: 230 });
  const sizeRef = useRef(size);
  const drag = useRef<{ band: number; nx: number; ny: number; x: number; y: number } | null>(null);
  const sampleRate = tap?.sampleRate || 48000;
  const output = Number(v.output);

  const bands = useMemo<BandView[]>(
    () =>
      Array.from({ length: BAND_COUNT }, (_, i) => {
        const ids = bandIds(i + 1);
        return {
          b: i + 1,
          on: Boolean(v[ids.on]),
          type: v[ids.type] as BandType,
          freq: Number(v[ids.freq]),
          gain: Number(v[ids.gain]),
          q: Number(v[ids.q]),
        };
      }),
    [v],
  );

  useLayoutEffect(() => {
    const el = graph.current;
    if (!el) return;
    const measure = () => {
      const w = Math.max(100, Math.round(el.clientWidth));
      const h = Math.max(80, Math.round(el.clientHeight));
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    sizeRef.current = size;
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
  }, [size]);

  // The summed curve and the selected band's own response.
  const scratch = useMemo(() => sectionBuffer(), []);
  const { curve, fill } = useMemo(() => {
    const steps = Math.max(2, Math.round(size.w / 2));
    const active = bands.filter((b) => b.on && !(hasGain(b.type) && b.gain === 0));
    const sel = bands[selected - 1];
    let c = '';
    let f = '';
    for (let i = 0; i <= steps; i++) {
      const x = (i / steps) * size.w;
      const freq = freqAt(i / steps);
      let db = output;
      for (const b of active) db += bandResponseDb(b.type, b.freq, b.gain, b.q, freq, sampleRate, scratch);
      c += `${i ? 'L' : 'M'}${x.toFixed(1)},${clamp(yOf(db, size.h), -4, size.h + 4).toFixed(1)}`;
      if (sel?.on) {
        const own = bandResponseDb(sel.type, sel.freq, sel.gain, sel.q, freq, sampleRate, scratch);
        f += `${i ? 'L' : 'M'}${x.toFixed(1)},${clamp(yOf(own, size.h), -4, size.h + 4).toFixed(1)}`;
      }
    }
    const zero = yOf(0, size.h).toFixed(1);
    return { curve: c, fill: f ? `${f}L${size.w},${zero}L0,${zero}Z` : '' };
  }, [bands, selected, size, sampleRate, output, scratch]);

  // The live spectrum of the output, drawn on the frame loop (no React renders).
  const spectrum = useRef<{ bins: Float32Array<ArrayBuffer>; lo: Int32Array; hi: Int32Array; key: string } | null>(
    null,
  );
  useFrame(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const { w, h } = sizeRef.current;
    const dpr = c.width / w;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!tap?.active || tap.fftSize === 0) return;
    const columns = Math.max(2, Math.round(w / 2));
    const key = `${tap.fftSize}:${tap.sampleRate}:${columns}`;
    let s = spectrum.current;
    if (!s || s.key !== key) {
      // Which FFT bins each column of pixels covers (log frequency axis).
      const lo = new Int32Array(columns + 1);
      const hi = new Int32Array(columns + 1);
      const binHz = tap.sampleRate / tap.fftSize;
      for (let i = 0; i <= columns; i++) {
        const a = freqAt((i - 0.5) / columns) / binHz;
        const b = freqAt((i + 0.5) / columns) / binHz;
        lo[i] = clamp(Math.floor(a), 1, tap.fftSize / 2 - 1);
        hi[i] = clamp(Math.max(Math.floor(a) + 1, Math.ceil(b)), 2, tap.fftSize / 2);
      }
      s = spectrum.current = { bins: new Float32Array(tap.fftSize / 2), lo, hi, key };
    }
    if (!tap.spectrum(s.bins)) return;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i <= columns; i++) {
      let peak = -Infinity;
      for (let k = s.lo[i] as number; k < (s.hi[i] as number); k++)
        if ((s.bins[k] as number) > peak) peak = s.bins[k] as number;
      const y = (clamp(peak, SPECTRUM_FLOOR, 0) / SPECTRUM_FLOOR) * h;
      ctx.lineTo((i / columns) * w, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(90, 164, 232, 0.22)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(90, 164, 232, 0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
  });

  // Scroll on a handle changes its Q (a native listener: React's wheel events can't stop scrolling).
  const latest = useRef({ bands, setParam });
  useEffect(() => {
    latest.current = { bands, setParam };
  });
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const target = (e.target as Element | null)?.closest('[data-band]');
      if (!target) return;
      e.preventDefault();
      const band = latest.current.bands[Number(target.getAttribute('data-band')) - 1];
      if (!band) return;
      const step = e.shiftKey ? 1.03 : Q_STEP;
      const q = clamp(e.deltaY < 0 ? band.q * step : band.q / step, 0.1, 18);
      latest.current.setParam(bandIds(band.b).q, Math.round(q * 1000) / 1000);
      setSelected(band.b);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const pointerIn = (e: { clientX: number; clientY: number }) => {
    const rect = graph.current?.getBoundingClientRect();
    return rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : { x: 0, y: 0 };
  };

  const onHandleDown = (e: ReactPointerEvent<SVGGElement>, band: BandView) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setSelected(band.b);
    const ids = bandIds(band.b);
    begin(ids.freq);
    if (!band.on) setParam(ids.on, true);
    const at = pointerIn(e);
    drag.current = { band: band.b, nx: norm(band.freq), ny: band.gain, x: at.x, y: at.y };
  };

  const onHandleMove = (e: ReactPointerEvent<SVGGElement>, band: BandView) => {
    const d = drag.current;
    if (!d || d.band !== band.b) return;
    // The button was released somewhere we didn't hear about: the drag is over.
    if (e.buttons === 0) {
      onHandleUp(e, band);
      return;
    }
    const at = pointerIn(e);
    const fine = e.shiftKey ? 0.1 : 1;
    const ids = bandIds(band.b);
    const freq = Math.round(freqAt(d.nx + ((at.x - d.x) / size.w) * fine) * 10) / 10;
    const next = { ...band, freq, on: true };
    setParam(ids.freq, freq);
    if (hasGain(band.type)) {
      const pxPerDb = (size.h / 2 - MARGIN) / DB_RANGE;
      const gain = Math.round(clamp(d.ny + ((d.y - at.y) / pxPerDb) * fine, -DB_RANGE, DB_RANGE) * 10) / 10;
      setParam(ids.gain, gain);
      next.gain = gain;
    }
    emitHint(e.currentTarget, describe(next, specs));
  };

  function onHandleUp(e: ReactPointerEvent<SVGGElement>, band: BandView) {
    if (!drag.current || drag.current.band !== band.b) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    end(bandIds(band.b).freq);
  }

  /** Double-click on empty space: switch on a free band right there. */
  const onGraphDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('[data-band]')) return;
    const free = FREE_ORDER.map((b) => bands[b - 1]!).find((b) => !b.on);
    if (!free) return;
    const at = pointerIn(e);
    const ids = bandIds(free.b);
    begin(ids.freq);
    setParam(ids.on, true);
    setParam(ids.freq, Math.round(freqAt(at.x / size.w) * 10) / 10);
    if (hasGain(free.type)) setParam(ids.gain, Math.round(clamp(dbAt(at.y, size.h), -DB_RANGE, DB_RANGE) * 10) / 10);
    end(ids.freq);
    setSelected(free.b);
  };

  const sel = bands[selected - 1] ?? (bands[0] as BandView);
  const selIds = bandIds(sel.b);
  const knob = (id: string, label: string, disabled = false) => (
    <div className={styles.control} data-hint={`${spec[id]?.label}: ${spec[id]?.hint ?? ''}`}>
      <Knob
        spec={spec[id]!}
        value={v[id]!}
        param={id}
        size={34}
        disabled={disabled}
        bipolar={(spec[id] as { min?: number }).min! < 0}
        onBegin={() => begin(id)}
        onChange={(x) => setParam(id, x)}
        onEnd={() => end(id)}
        onCommit={(x) => setParam(id, x)}
      />
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{formatValue(spec[id]!, v[id]!)}</span>
    </div>
  );

  return (
    <div className={styles.root}>
      <div
        ref={graph}
        className={styles.graph}
        onDoubleClick={onGraphDoubleClick}
        data-hint="EQ curve: drag a numbered handle to move a band (sideways = frequency, up/down = gain), scroll on it for Q, double-click it to switch it on or off; double-click empty space to add a band there"
      >
        <canvas ref={canvas} style={{ width: '100%', height: '100%' }} />
        <svg ref={svg} width={size.w} height={size.h}>
          {GRID_FREQS.map((f) => {
            const x = norm(f) * size.w;
            return (
              <g key={f}>
                <line className={styles.gridLine} x1={x} x2={x} y1={0} y2={size.h} />
                <text className={styles.gridLabel} x={x + 2} y={size.h - 3}>
                  {f >= 1000 ? `${f / 1000}k` : f}
                </text>
              </g>
            );
          })}
          {GRID_DB.map((db) => (
            <g key={db}>
              <line className={styles.gridLine} x1={0} x2={size.w} y1={yOf(db, size.h)} y2={yOf(db, size.h)} />
              <text className={styles.gridLabel} x={3} y={yOf(db, size.h) - 2}>
                {db > 0 ? `+${db}` : db}
              </text>
            </g>
          ))}
          <line className={styles.gridZero} x1={0} x2={size.w} y1={yOf(0, size.h)} y2={yOf(0, size.h)} />
          {fill && <path className={styles.bandFill} d={fill} fill={COLORS[sel.b - 1]} />}
          <path className={styles.curve} d={curve} />
          {bands.map((band) => {
            const x = norm(clamp(band.freq, F_MIN, F_MAX)) * size.w;
            const y = yOf(hasGain(band.type) ? band.gain : 0, size.h);
            const cls = `${styles.handle} ${band.on ? '' : styles.handleOff} ${band.b === selected ? styles.handleSelected : ''}`;
            const ids = bandIds(band.b);
            return (
              <g
                key={band.b}
                className={cls}
                data-band={band.b}
                data-hint={`${describe(band, specs)} — drag to move, scroll for Q, double-click to switch ${band.on ? 'off' : 'on'}`}
                transform={`translate(${x.toFixed(1)},${y.toFixed(1)})`}
                onPointerDown={(e) => onHandleDown(e, band)}
                onPointerMove={(e) => onHandleMove(e, band)}
                onPointerUp={(e) => onHandleUp(e, band)}
                onPointerCancel={(e) => onHandleUp(e, band)}
                onLostPointerCapture={(e) => onHandleUp(e, band)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setParam(ids.on, !band.on);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSelected(band.b);
                  (openParamMenu as ((param: string, at: { clientX: number; clientY: number }) => void) | undefined)?.(
                    hasGain(band.type) ? ids.gain : ids.freq,
                    e,
                  );
                }}
              >
                <circle className={styles.handleDot} r={8} fill={band.on ? COLORS[band.b - 1] : undefined} />
                <text className={styles.handleNumber}>{band.b}</text>
              </g>
            );
          })}
        </svg>
        <div className={styles.readout}>{describe(sel, specs)}</div>
      </div>
      <div className={styles.strip}>
        <div className={styles.picker} role="tablist" aria-label="Bands">
          {bands.map((band) => (
            <button
              key={band.b}
              type="button"
              role="tab"
              aria-selected={band.b === selected}
              tabIndex={-1}
              className={`${styles.tab} ${band.b === selected ? styles.tabSelected : ''} ${band.on ? '' : styles.tabOff}`}
              style={{ borderColor: band.b === selected ? COLORS[band.b - 1] : undefined }}
              onClick={() => setSelected(band.b)}
              data-hint={`${describe(band, specs)} — click to edit this band below`}
            >
              <i className={styles.swatch} style={{ background: COLORS[band.b - 1] }} />
              {band.b}
            </button>
          ))}
        </div>
        <div className={styles.control}>
          <Toggle
            spec={specs[selIds.on as 'b1On']}
            value={Boolean(v[selIds.on])}
            label={`Band ${sel.b}`}
            param={selIds.on}
            onCommit={(x) => setParam(selIds.on, x)}
          />
        </div>
        <div className={styles.control} data-hint={`${spec[selIds.type]?.label}: ${spec[selIds.type]?.hint ?? ''}`}>
          <Select
            spec={specs[selIds.type as 'b1Type']}
            value={String(v[selIds.type])}
            label={`Band ${sel.b} type`}
            param={selIds.type}
            onCommit={(x) => setParam(selIds.type, x)}
          />
          <span className={styles.label}>Type</span>
        </div>
        {knob(selIds.freq, 'Frequency')}
        {knob(selIds.gain, 'Gain', !hasGain(sel.type))}
        {knob(selIds.q, 'Q')}
        <span className={styles.spacer} />
        {knob('output', 'Output')}
      </div>
    </div>
  );
}
