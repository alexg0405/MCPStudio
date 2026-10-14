import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { OVERVIEW_BUCKET, peakOverview, type PluginUIProps } from '@agstudio/sdk';
import { noteName } from '@agstudio/sdk/notes';
import { ParamKnob, ParamSelect, ParamToggle, Section } from '@agstudio/sdk/ui';
import { demoLoop, DEMO_RATE } from './demo.kernel';
import { FIRST_KEY, MAX_SLICES, type SlicerParams } from './params';
import { computeSlices } from './slices.kernel';
import styles from './ui.module.css';

type Props = PluginUIProps<SlicerParams>;

/** Width of the waveform when its box can't be measured yet. */
const DEFAULT_W = 520;
const H = 120;
const LABEL_H = 14;

interface Audio {
  peaks: Float32Array;
  length: number;
  sampleRate: number;
}

let demoAudio: Audio | null = null;
function demo(): Audio {
  if (!demoAudio) {
    const data = demoLoop();
    demoAudio = { peaks: peakOverview([data], OVERVIEW_BUCKET), length: data.length, sampleRate: DEMO_RATE };
  }
  return demoAudio;
}

/** The waveform's outline (max above, min below), one point per pixel column. */
function outline(audio: Audio, W: number): string {
  const buckets = audio.peaks.length >> 1;
  const top: string[] = [];
  const bottom: string[] = [];
  const mid = LABEL_H + (H - LABEL_H) / 2;
  const scale = (H - LABEL_H) / 2 - 2;
  for (let x = 0; x < W; x++) {
    const b0 = Math.floor((x / W) * buckets);
    const b1 = Math.max(b0 + 1, Math.floor(((x + 1) / W) * buckets));
    let lo = 0;
    let hi = 0;
    for (let b = b0; b < Math.min(b1, buckets); b++) {
      lo = Math.min(lo, audio.peaks[b * 2] as number);
      hi = Math.max(hi, audio.peaks[b * 2 + 1] as number);
    }
    top.push(`${x} ${(mid - hi * scale).toFixed(1)}`);
    bottom.push(`${x} ${(mid - lo * scale).toFixed(1)}`);
  }
  return `M ${top.join(' L ')} L ${bottom.reverse().join(' L ')} Z`;
}

function Waveform({ ui, audio, slices, W }: { ui: Props; audio: Audio; slices: number[]; W: number }) {
  const path = useMemo(() => outline(audio, W), [audio, W]);
  const [lit, setLit] = useState(-1);
  const release = useRef<(() => void) | null>(null);
  const seconds = (frame: number) => (frame / audio.sampleRate).toFixed(2);
  const stop = () => {
    release.current?.();
    release.current = null;
    setLit(-1);
  };
  return (
    <svg className={styles.wave} width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Waveform">
      <path d={path} className={styles.peaks} />
      {slices.map((start, i) => {
        const end = slices[i + 1] ?? audio.length;
        const x0 = (start / audio.length) * W;
        const x1 = (end / audio.length) * W;
        const key = FIRST_KEY + i;
        return (
          <g key={i}>
            <rect
              x={x0}
              y={0}
              width={Math.max(1, x1 - x0)}
              height={H}
              className={`${styles.slice} ${i % 2 ? styles.odd : ''} ${lit === i ? styles.lit : ''}`}
              data-hint={`Slice ${i + 1} · ${noteName(key)} (key ${key}): ${seconds(start)}–${seconds(end)} s${
                ui.playNote ? '. Click to hear it' : ''
              }`}
              onPointerDown={(e) => {
                if (e.button !== 0 || !ui.playNote) return;
                e.preventDefault();
                stop();
                release.current = ui.playNote(key, 0.9);
                setLit(i);
              }}
              onPointerUp={stop}
              onPointerLeave={stop}
            />
            <line x1={x0} y1={0} x2={x0} y2={H} className={styles.marker} />
            {x1 - x0 > 20 && (
              <text x={x0 + 3} y={LABEL_H - 3} className={styles.label}>
                {noteName(key)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** The width of an element (follows resizes of the editor window). */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(DEFAULT_W);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setWidth(Math.max(120, Math.floor(el.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** The Slicer editor: the sample and its slices, then how it slices and plays. */
export function SlicerUI(ui: Props) {
  const [over, setOver] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const samples = ui.samples;
  const name = samples?.name('main') ?? null;
  const overview = name ? (samples?.waveform('main') ?? null) : null;
  const audio: Audio | null = useMemo(() => {
    if (!name) return demo();
    if (!overview) return null;
    return {
      peaks: overview.peaks,
      length: Math.round(overview.duration * overview.sampleRate),
      sampleRate: overview.sampleRate,
    };
  }, [name, overview]);
  const v = ui.values;
  const grid = v.mode === 'grid';
  const slices = useMemo(() => {
    if (!audio) return [];
    const out = new Int32Array(MAX_SLICES);
    const n = computeSlices(
      audio.peaks,
      audio.peaks.length >> 1,
      audio.length,
      audio.sampleRate,
      { mode: grid ? 1 : 0, sensitivity: v.sensitivity, gridSlices: v.gridSlices, minSlice: v.minSlice },
      out,
    );
    return Array.from(out.subarray(0, n));
  }, [audio, grid, v.sensitivity, v.gridSlices, v.minSlice]);
  const lastKey = FIRST_KEY + slices.length - 1;

  return (
    <div className={styles.root}>
      <Section title="Sample" hint="The sample being sliced: drop a file on the waveform, or choose one" wide>
        <div className={styles.sampleBar}>
          {name ? (
            <span className={styles.sampleName} data-hint={`Slicing “${name}”`}>
              {name}
            </span>
          ) : (
            <button
              type="button"
              tabIndex={-1}
              className={styles.empty}
              onClick={() => samples?.choose('main')}
              data-hint="No sample yet: this is the built-in demo loop. Drop a sample here or click to choose one"
            >
              Demo loop — drop a sample here or click to choose one
            </button>
          )}
          {samples && (
            <span className={styles.buttons}>
              <button
                type="button"
                tabIndex={-1}
                className={styles.button}
                onClick={() => samples.choose('main')}
                data-hint="Choose an audio file to slice (WAV, AIFF, FLAC, MP3, OGG)"
              >
                Choose file…
              </button>
              {name && (
                <button
                  type="button"
                  tabIndex={-1}
                  className={styles.button}
                  onClick={() => samples.clear('main')}
                  data-hint="Remove the sample (the demo loop plays again)"
                >
                  Remove
                </button>
              )}
            </span>
          )}
        </div>
        <div
          ref={box}
          className={`${styles.waveBox} ${over ? styles.over : ''}`}
          onDragOver={(e) => {
            if (!samples?.canDrop(e.dataTransfer)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            if (!over) setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            setOver(false);
            if (samples?.drop('main', e.dataTransfer)) e.preventDefault();
          }}
        >
          {audio ? (
            <Waveform ui={ui} audio={audio} slices={slices} W={width} />
          ) : (
            <div className={styles.loading} data-hint="The sample is still loading">
              Loading the sample…
            </div>
          )}
        </div>
        <div
          className={styles.summary}
          data-hint="Each slice plays on its own key, from C5 (key 60) up: draw notes on those keys to rearrange the loop"
        >
          {slices.length === 0
            ? 'No slices yet'
            : slices.length === 1
              ? `1 slice, on key ${noteName(FIRST_KEY)} (${FIRST_KEY}). Click it to hear it.`
              : `${slices.length} slices on keys ${noteName(FIRST_KEY)}–${noteName(lastKey)} (${FIRST_KEY}–${lastKey}). Click a slice to hear it.`}
        </div>
      </Section>
      <div className={styles.row}>
        <Section title="Slicing" hint="Where the sample is cut">
          <ParamSelect ui={ui} param="mode" />
          {grid ? <ParamKnob ui={ui} param="gridSlices" /> : <ParamKnob ui={ui} param="sensitivity" />}
          <ParamKnob ui={ui} param="minSlice" />
        </Section>
        <Section title="Playback" hint="How each slice plays">
          <ParamSelect ui={ui} param="playback" />
          <ParamKnob ui={ui} param="tune" />
          <ParamKnob ui={ui} param="attack" />
          <ParamKnob ui={ui} param="release" />
          <ParamKnob ui={ui} param="velocity" />
          <ParamKnob ui={ui} param="level" />
          <div className={styles.toggles}>
            <ParamToggle ui={ui} param="cut" />
            <ParamToggle ui={ui} param="reverse" />
          </div>
        </Section>
      </div>
    </div>
  );
}
