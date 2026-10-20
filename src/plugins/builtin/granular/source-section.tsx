import { useMemo, useState } from 'react';
import { OVERVIEW_BUCKET, peakOverview, type PluginUIProps } from '@agstudio/sdk';
import { ParamSelect, Section } from '@agstudio/sdk/ui';
import { GrainDisplay } from './grain-display';
import type { Peaks } from './grain-paint';
import { TEXTURE_OPTIONS, type GranularParams } from './params';
import { textureChannels } from './textures';
import styles from './ui.module.css';

type Props = PluginUIProps<GranularParams, undefined>;

/** The waveform of the sound the grains are cut from: the loaded sample, or the built-in texture. */
function useSourcePeaks(ui: Props, hasSample: boolean): Peaks | null {
  const texture = String(ui.values.texture);
  const overview = hasSample ? (ui.samples?.waveform('main') ?? null) : null;
  return useMemo(() => {
    if (hasSample) return overview ? { peaks: overview.peaks } : null;
    return { peaks: peakOverview(textureChannels(texture), OVERVIEW_BUCKET) };
  }, [hasSample, overview, texture]);
}

/** The line above the waveform: what the grains come from, and the buttons to change it. */
function SampleBar({ ui, name }: { ui: Props; name: string | null }) {
  const samples = ui.samples;
  const textureName = TEXTURE_OPTIONS.find(([id]) => id === ui.values.texture)?.[1] ?? '';
  return (
    <div className={styles.sampleBar}>
      {name ? (
        <span className={styles.sampleName} data-hint={`Grains are cut from “${name}”`}>
          {name}
        </span>
      ) : (
        <span
          className={styles.builtIn}
          data-hint="No sample loaded: the grains come from this built-in sound. Drop a sample on the waveform to use your own"
        >
          Built-in sound ({textureName}): drop a sample here to use your own
        </span>
      )}
      <span className={styles.buttons}>
        {!name && <ParamSelect ui={ui} param="texture" label="Built-in sound" inline />}
        {samples && (
          <button
            type="button"
            className={styles.button}
            onClick={() => samples.choose('main')}
            data-hint="Choose an audio file to cut grains from (WAV, AIFF, FLAC, MP3, OGG)"
          >
            Choose file…
          </button>
        )}
        {samples && name && (
          <button
            type="button"
            className={styles.button}
            onClick={() => samples.clear('main')}
            data-hint="Remove the sample (the built-in sound plays again)"
          >
            Remove
          </button>
        )}
      </span>
    </div>
  );
}

/** The waveform with the grain display on it; a sample dropped on it becomes the source. */
function Waveform({ ui, peaks }: { ui: Props; peaks: Peaks | null }) {
  const [isDraggedOver, setDraggedOver] = useState(false);
  const samples = ui.samples;
  return (
    <div
      className={`${styles.waveBox} ${isDraggedOver ? styles.over : ''}`}
      onDragOver={(e) => {
        if (!samples?.canDrop(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!isDraggedOver) setDraggedOver(true);
      }}
      onDragLeave={() => setDraggedOver(false)}
      onDrop={(e) => {
        setDraggedOver(false);
        if (samples?.drop('main', e.dataTransfer)) e.preventDefault();
      }}
    >
      {peaks ? (
        <GrainDisplay
          peaks={peaks}
          position={Number(ui.values.position)}
          spray={Number(ui.values.spray)}
          tap={ui.tap}
          onBegin={(param) => ui.beginEdit(param)}
          onChange={(param, value) => ui.setParam(param, value)}
          onEnd={(param) => ui.endEdit(param)}
        />
      ) : (
        <div className={styles.loading} data-hint="The sample is still loading">
          Loading the sample…
        </div>
      )}
    </div>
  );
}

/** The editor's top section: the source of the grains, and its waveform. */
export function SourceSection({ ui }: { ui: Props }) {
  const name = ui.samples?.name('main') ?? null;
  const peaks = useSourcePeaks(ui, name !== null);
  return (
    <Section
      title="Source"
      hint="What the grains are cut from: drop a sample on the waveform, or use a built-in sound"
      wide
    >
      <SampleBar ui={ui} name={name} />
      <Waveform ui={ui} peaks={peaks} />
    </Section>
  );
}
