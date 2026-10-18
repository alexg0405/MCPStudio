import { useMemo, useState } from 'react';
import { OVERVIEW_BUCKET, peakOverview, type PluginUIProps } from '@agstudio/sdk';
import { ParamKnob, ParamSelect, ParamToggle, Section } from '@agstudio/sdk/ui';
import { GrainDisplay, type Peaks } from './grain-display';
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

/** The Granular editor: the sample with its grain window and live grains, then the controls in groups. */
export function GranularUI(ui: Props) {
  const [over, setOver] = useState(false);
  const samples = ui.samples;
  const name = samples?.name('main') ?? null;
  const peaks = useSourcePeaks(ui, name !== null);
  const textureName = TEXTURE_OPTIONS.find(([id]) => id === ui.values.texture)?.[1] ?? '';

  return (
    <div className={styles.root}>
      <Section title="Source" hint="What the grains are cut from: drop a sample on the waveform, or use a built-in sound" wide>
        <div className={styles.sampleBar}>
          {name ? (
            <span className={styles.sampleName} data-hint={`Grains are cut from “${name}”`}>
              {name}
            </span>
          ) : (
            <span className={styles.builtIn} data-hint="No sample loaded: the grains come from this built-in sound. Drop a sample on the waveform to use your own">
              Built-in sound: {textureName}. Drop a sample on the waveform, or choose one.
            </span>
          )}
          <span className={styles.buttons}>
            {!name && <ParamSelect ui={ui} param="texture" label="Built-in sound" inline />}
            {samples && (
              <button
                type="button"
                tabIndex={-1}
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
                tabIndex={-1}
                className={styles.button}
                onClick={() => samples.clear('main')}
                data-hint="Remove the sample (the built-in sound plays again)"
              >
                Remove
              </button>
            )}
          </span>
        </div>
        <div
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
      </Section>
      <div className={styles.row}>
        <Section title="Grains" hint="Each note is a cloud of tiny grains: where they start, how long they last and how many there are">
          <ParamKnob ui={ui} param="position" />
          <ParamKnob ui={ui} param="spray" label="Spray" />
          <ParamKnob ui={ui} param="size" label="Size" />
          <ParamKnob ui={ui} param="density" />
          <ParamKnob ui={ui} param="jitter" label="Randomness" />
          <ParamKnob ui={ui} param="reverse" />
          <ParamSelect ui={ui} param="shape" label="Shape" />
        </Section>
        <Section title="Pitch" hint="How the grains are tuned">
          <ParamKnob ui={ui} param="pitch" />
          <ParamKnob ui={ui} param="fine" />
          <ParamKnob ui={ui} param="pitchSpray" label="Spray" />
          <ParamKnob ui={ui} param="keyTrack" label="Key track" />
        </Section>
        <Section title="Stereo" hint="Where the grains land between left and right">
          <ParamKnob ui={ui} param="spread" label="Spread" />
        </Section>
        <Section title="Scan" hint="Moves the position while a note plays, so the cloud travels through the sample">
          <ParamKnob ui={ui} param="scan" label="Speed" />
          <div className={styles.toggles}>
            <ParamToggle ui={ui} param="scanSync" label="Sync to tempo" />
            <ParamToggle ui={ui} param="freeze" label="Freeze" />
          </div>
          {ui.values.scanSync ? <ParamSelect ui={ui} param="scanLength" label="Length" /> : null}
        </Section>
      </div>
      <div className={styles.row}>
        <Section title="Filter" hint="Shapes the tone of every note">
          <ParamSelect ui={ui} param="filterType" label="Type" />
          <ParamKnob ui={ui} param="cutoff" />
          <ParamKnob ui={ui} param="resonance" />
        </Section>
        <Section title="Amp envelope" hint="How each note's volume starts, holds and ends">
          <ParamKnob ui={ui} param="ampAttack" label="Attack" />
          <ParamKnob ui={ui} param="ampDecay" label="Decay" />
          <ParamKnob ui={ui} param="ampSustain" label="Sustain" />
          <ParamKnob ui={ui} param="ampRelease" label="Release" />
          <ParamKnob ui={ui} param="velocity" />
        </Section>
        <Section title="Voice" hint="How many notes sound at once, the random seed and the volume">
          <ParamKnob ui={ui} param="voices" />
          <ParamKnob ui={ui} param="seed" />
          <ParamKnob ui={ui} param="level" />
        </Section>
      </div>
    </div>
  );
}
