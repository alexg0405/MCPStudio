import { useMemo, useRef, useState } from 'react';
import type { PluginUIProps } from '@agstudio/sdk';
import { noteName } from '@agstudio/sdk/notes';
import { ParamKnob, ParamSelect, ParamToggle, Section } from '@agstudio/sdk/ui';
import { FIRST_KEY, MAX_SLICES, type SlicerParams } from './params';
import { computeSlices } from './slices.kernel';
import { demoSliceAudio, type SliceAudio } from './slice-audio';
import styles from './ui.module.css';
import { useWidth, Waveform } from './waveform';

type Props = PluginUIProps<SlicerParams>;
type Samples = NonNullable<Props['samples']>;

/** The audio to slice and draw: the loaded sample's overview, the demo loop while none is loaded, null while loading. */
function useSliceAudio(samples: Props['samples']): { name: string | null; audio: SliceAudio | null } {
  const name = samples?.name('main') ?? null;
  const overview = name ? (samples?.waveform('main') ?? null) : null;
  const audio = useMemo((): SliceAudio | null => {
    if (!name) return demoSliceAudio();
    if (!overview) return null;
    return {
      peaks: overview.peaks,
      length: Math.round(overview.duration * overview.sampleRate),
      sampleRate: overview.sampleRate,
    };
  }, [name, overview]);
  return { name, audio };
}

/** The start frame of every slice, from the audio and the slicing params (the kernel's own computation). */
function useSlices(audio: SliceAudio | null, values: Props['values']): number[] {
  const isGrid = values.mode === 'grid';
  return useMemo(() => {
    if (!audio) return [];
    const starts = new Int32Array(MAX_SLICES);
    const count = computeSlices(
      audio.peaks,
      audio.peaks.length >> 1,
      audio.length,
      audio.sampleRate,
      {
        mode: isGrid ? 1 : 0,
        sensitivity: values.sensitivity,
        gridSlices: values.gridSlices,
        minSlice: values.minSlice,
      },
      starts,
    );
    return Array.from(starts.subarray(0, count));
  }, [audio, isGrid, values.sensitivity, values.gridSlices, values.minSlice]);
}

/** The sample's name (or a prompt to load one) and the Choose and Remove buttons. */
function SampleBar({ name, samples }: { name: string | null; samples: Samples | undefined }) {
  return (
    <div className={styles.sampleBar}>
      {name ? (
        <span className={styles.sampleName} data-hint={`Slicing “${name}”`}>
          {name}
        </span>
      ) : (
        <button
          type="button"
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
            className={styles.button}
            onClick={() => samples.choose('main')}
            data-hint="Choose an audio file to slice (WAV, AIFF, FLAC, MP3, OGG)"
          >
            Choose file…
          </button>
          {name && (
            <button
              type="button"
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
  );
}

/** One line under the waveform: how many slices there are and which keys play them. */
function SliceSummary({ sliceCount }: { sliceCount: number }) {
  const lastKey = FIRST_KEY + sliceCount - 1;
  let text: string;
  if (sliceCount === 0) text = 'No slices yet';
  else if (sliceCount === 1) text = `1 slice, on key ${noteName(FIRST_KEY)} (${FIRST_KEY}). Click it to hear it.`;
  else {
    const keys = `${noteName(FIRST_KEY)}–${noteName(lastKey)} (${FIRST_KEY}–${lastKey})`;
    text = `${sliceCount} slices on keys ${keys}. Click a slice to hear it.`;
  }
  return (
    <div
      className={styles.summary}
      data-hint="Each slice plays on its own key, from C5 (key 60) up: draw notes on those keys to rearrange the loop"
    >
      {text}
    </div>
  );
}

/** The Slicer editor: the sample and its slices, then how it slices and plays. */
export function SlicerUI(ui: Props) {
  const [isDragOver, setIsDragOver] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const samples = ui.samples;
  const { name, audio } = useSliceAudio(samples);
  const slices = useSlices(audio, ui.values);
  const isGrid = ui.values.mode === 'grid';

  return (
    <div className={styles.root}>
      <Section title="Sample" hint="The sample being sliced: drop a file on the waveform, or choose one" wide>
        <SampleBar name={name} samples={samples} />
        <div
          ref={box}
          className={`${styles.waveBox} ${isDragOver ? styles.over : ''}`}
          onDragOver={(e) => {
            if (!samples?.canDrop(e.dataTransfer)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            if (!isDragOver) setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={(e) => {
            setIsDragOver(false);
            if (samples?.drop('main', e.dataTransfer)) e.preventDefault();
          }}
        >
          {audio ? (
            <Waveform ui={ui} audio={audio} slices={slices} width={width} />
          ) : (
            <div className={styles.loading} data-hint="The sample is still loading">
              Loading the sample…
            </div>
          )}
        </div>
        <SliceSummary sliceCount={slices.length} />
      </Section>
      <div className={styles.row}>
        <Section title="Slicing" hint="Where the sample is cut">
          <ParamSelect ui={ui} param="mode" />
          {isGrid ? <ParamKnob ui={ui} param="gridSlices" /> : <ParamKnob ui={ui} param="sensitivity" />}
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
