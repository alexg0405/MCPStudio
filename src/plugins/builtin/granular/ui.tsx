import type { PluginUIProps } from '@agstudio/sdk';
import { ParamKnob, ParamSelect, ParamToggle, Section } from '@agstudio/sdk/ui';
import type { GranularParams } from './params';
import { SourceSection } from './source-section';
import styles from './ui.module.css';

type Props = PluginUIProps<GranularParams, undefined>;

/** The knobs that shape the grain cloud: where, how long, how many, and how they are tuned and spread. */
function CloudRow({ ui }: { ui: Props }) {
  return (
    <div className={styles.row}>
      <Section
        title="Grains"
        hint="Each note is a cloud of tiny grains: where they start, how long they last and how many there are"
      >
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
  );
}

/** The knobs that shape each note: the filter, the amp envelope and the voices. */
function VoiceRow({ ui }: { ui: Props }) {
  return (
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
  );
}

/** The Granular editor: the sample with its grain window and live grains, then the controls in groups. */
export function GranularUI(ui: Props) {
  return (
    <div className={styles.root}>
      <SourceSection ui={ui} />
      <CloudRow ui={ui} />
      <VoiceRow ui={ui} />
    </div>
  );
}
