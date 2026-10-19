import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { PluginUIProps } from '@agstudio/sdk';
import { noteName } from '@agstudio/sdk/notes';
import { FIRST_KEY, type SlicerParams } from './params';
import type { SliceAudio } from './slice-audio';
import styles from './ui.module.css';

/** Width of the waveform when its box can't be measured yet. */
const DEFAULT_WIDTH = 520;
const WAVE_HEIGHT = 120;
/** The strip at the top of the waveform that holds the slices' note names. */
const LABEL_HEIGHT = 14;
/** The velocity of a slice played by clicking it. */
const PREVIEW_VELOCITY = 0.9;

/** The waveform's outline (max above, min below), one point per pixel column. */
function outline(audio: SliceAudio, width: number): string {
  const buckets = audio.peaks.length >> 1;
  const top: string[] = [];
  const bottom: string[] = [];
  const middle = LABEL_HEIGHT + (WAVE_HEIGHT - LABEL_HEIGHT) / 2;
  const scale = (WAVE_HEIGHT - LABEL_HEIGHT) / 2 - 2;
  for (let x = 0; x < width; x++) {
    const firstBucket = Math.floor((x / width) * buckets);
    const endBucket = Math.max(firstBucket + 1, Math.floor(((x + 1) / width) * buckets));
    let lowest = 0;
    let highest = 0;
    for (let bucket = firstBucket; bucket < Math.min(endBucket, buckets); bucket++) {
      lowest = Math.min(lowest, audio.peaks[bucket * 2] as number);
      highest = Math.max(highest, audio.peaks[bucket * 2 + 1] as number);
    }
    top.push(`${x} ${(middle - highest * scale).toFixed(1)}`);
    bottom.push(`${x} ${(middle - lowest * scale).toFixed(1)}`);
  }
  return `M ${top.join(' L ')} L ${bottom.reverse().join(' L ')} Z`;
}

/** The sample's waveform with the slice markers; pressing a slice plays it while the pointer is held. */
export function Waveform({
  ui,
  audio,
  slices,
  width,
}: {
  ui: PluginUIProps<SlicerParams>;
  audio: SliceAudio;
  /** The start frame of each slice. */
  slices: number[];
  width: number;
}) {
  const path = useMemo(() => outline(audio, width), [audio, width]);
  const [litSlice, setLitSlice] = useState(-1);
  const release = useRef<(() => void) | null>(null);
  const seconds = (frame: number) => (frame / audio.sampleRate).toFixed(2);
  const stopPreview = () => {
    release.current?.();
    release.current = null;
    setLitSlice(-1);
  };
  return (
    <svg
      className={styles.wave}
      width={width}
      height={WAVE_HEIGHT}
      viewBox={`0 0 ${width} ${WAVE_HEIGHT}`}
      role="img"
      aria-label="Waveform"
    >
      <path d={path} className={styles.peaks} />
      {slices.map((start, i) => {
        const end = slices[i + 1] ?? audio.length;
        const startX = (start / audio.length) * width;
        const endX = (end / audio.length) * width;
        const key = FIRST_KEY + i;
        return (
          <g key={i}>
            <rect
              x={startX}
              y={0}
              width={Math.max(1, endX - startX)}
              height={WAVE_HEIGHT}
              className={`${styles.slice} ${i % 2 ? styles.odd : ''} ${litSlice === i ? styles.lit : ''}`}
              data-hint={`Slice ${i + 1} · ${noteName(key)} (key ${key}): ${seconds(start)}–${seconds(end)} s${
                ui.playNote ? '. Click to hear it' : ''
              }`}
              onPointerDown={(e) => {
                if (e.button !== 0 || !ui.playNote) return;
                e.preventDefault();
                stopPreview();
                release.current = ui.playNote(key, PREVIEW_VELOCITY);
                setLitSlice(i);
              }}
              onPointerUp={stopPreview}
              onPointerLeave={stopPreview}
            />
            <line x1={startX} y1={0} x2={startX} y2={WAVE_HEIGHT} className={styles.marker} />
            {endX - startX > 20 && (
              <text x={startX + 3} y={LABEL_HEIGHT - 3} className={styles.label}>
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
export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = () => setWidth(Math.max(120, Math.floor(element.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
