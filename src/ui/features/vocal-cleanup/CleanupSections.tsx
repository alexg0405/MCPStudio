import { useStore } from 'zustand';
import { changeCleanup, learnNoiseAutomatically, loopRegionInSample, toggleBreath } from '@app/actions/cleanup';
import { cleanupState } from '@app/cleanup/state';
import { BREATH_REMOVE_DB, DEFAULT_BREATHS, DEFAULT_CLICKS, DEFAULT_NOISE, DENOISE_MAX_DB } from '@core/audio/cleanup-edit';
import { tempoMapOf } from '@core/automation/tempo';
import { playbackMode, tickAtSourceSeconds } from '@core/audio/playback';
import { audioClipOf } from '@app/actions/pitch-clip';
import type { ClipId, VocalCleanup } from '@core/model/types';
import { ticksPerBar } from '@core/time/ppq';
import { useServices } from '../../services-context';
import { Section, SliderRow, ToolButton } from './CleanupControls';
import styles from './CleanupWindow.module.css';

const percent = (v: number) => `${Math.round(v * 100)} %`;
const dbText = (v: number) => `${Math.round(v * 10) / 10} dB`;

/** The props every section takes: the clip and its settings. */
interface SectionProps {
  clipId: ClipId;
  cleanup: VocalCleanup | undefined;
}

/** Noise reduction: how much, how firmly, and where the noise is learned from. */
export function NoiseSection({ clipId, cleanup }: SectionProps) {
  const services = useServices();
  const noise = cleanup?.noise;
  const problem = useStore(cleanupState, (st) => st.problems[clipId]);
  const hasStretch = noise?.from !== undefined && noise?.to !== undefined;
  const change = (request: Parameters<typeof changeCleanup>[2], label: string, key?: string) => changeCleanup(services, clipId, request, label, key);
  const learnFromLoop = () => services.commands.run('cleanup.learnNoise', { clip: clipId, source: 'loop' });
  const hasLoop = !!loopRegionInSample(services, clipId);
  return (
    <Section
      title="Noise reduction"
      isOn={!!noise}
      onToggle={(on) => change({ noiseDb: on ? DEFAULT_NOISE.amountDb : 0 }, on ? 'Reduce noise' : 'Noise reduction off')}
      hint="Turns steady background noise (hiss, hum, fan, room tone) down. It learns what the noise looks like from a quiet part of the clip, then lowers everything that sounds like it"
      intro="Takes out hiss, hum and room sound between and under the words. It learns the noise from a stretch with no singing."
    >
      <SliderRow
        label="Reduction"
        value={noise?.amountDb ?? DEFAULT_NOISE.amountDb}
        min={1}
        max={DENOISE_MAX_DB}
        step={0.5}
        text={dbText(noise?.amountDb ?? DEFAULT_NOISE.amountDb)}
        hint="How far the noise goes down, in dB. 6 to 12 dB is natural; more takes out more but can make the voice sound thin or watery"
        onChange={(v) => change({ noiseDb: v }, 'Noise reduction', `cleanup-noise:${clipId}`)}
      />
      <SliderRow
        label="Sensitivity"
        value={Math.round((noise?.sensitivity ?? DEFAULT_NOISE.sensitivity) * 100)}
        min={0}
        max={100}
        step={1}
        text={percent(noise?.sensitivity ?? DEFAULT_NOISE.sensitivity)}
        hint="How far above the noise a sound must rise to count as voice, in %. Higher cuts more noise between words but can dull soft consonants and quiet endings"
        onChange={(v) => change({ noiseSensitivity: v }, 'Noise sensitivity', `cleanup-noise-sens:${clipId}`)}
      />
      <div className={styles.line}>
        <span className={styles.note}>
          {hasStretch
            ? `Noise learned from ${noise!.from!.toFixed(2)} to ${noise!.to!.toFixed(2)} s (the blue part of the strip).`
            : 'Noise is learned from the quietest half second of the clip (it is shown in blue once the cleaned sound is made).'}
        </span>
        <ToolButton
          label="Quietest part"
          hint="Finds the quietest half second of the clip by itself and learns the noise from it"
          isDisabled={!hasStretch}
          onClick={() => learnNoiseAutomatically(services, clipId)}
        />
        <ToolButton
          label="Loop region"
          hint="Learns the noise from the part of the clip inside the song's loop region (drag in the playlist's ruler over a stretch with only the room sound)"
          isDisabled={!hasLoop}
          onClick={learnFromLoop}
        />
      </div>
      {problem ? <p className={styles.problem}>{problem}</p> : null}
    </Section>
  );
}

/** Where a breath is in the song, as the bar number it starts in. */
function useBarOf(clipId: ClipId): (seconds: number) => number {
  const services = useServices();
  return (seconds) => {
    const p = services.doc.getState().project;
    const found = audioClipOf(p, clipId);
    if (!found) return 1;
    return tickAtSourceSeconds(found.clip, playbackMode(found.channel), tempoMapOf(p, 'song'), seconds) / ticksPerBar(p.transport.timeSig) + 1;
  };
}

/** Breath control: how far breaths go down, how many are found, and the list of those found. */
export function BreathSection({ clipId, cleanup }: SectionProps) {
  const services = useServices();
  const breaths = cleanup?.breaths;
  const barOf = useBarOf(clipId);
  const change = (request: Parameters<typeof changeCleanup>[2], label: string, key?: string) => changeCleanup(services, clipId, request, label, key);
  const reduce = breaths?.reduceDb ?? DEFAULT_BREATHS.reduceDb;
  const spans = breaths?.spans;
  return (
    <Section
      title="Breaths"
      isOn={!!breaths}
      onToggle={(on) => change({ breathsDb: on ? DEFAULT_BREATHS.reduceDb : 0 }, on ? 'Tone down breaths' : 'Breath control off')}
      hint="Finds the breaths between phrases (noisy, unpitched and much quieter than the singing) and turns them down with short fades, so nothing clicks"
      intro="Finds the breaths between phrases and turns them down. They show as orange boxes on the strip."
    >
      <SliderRow
        label="Reduction"
        value={reduce}
        min={1}
        max={BREATH_REMOVE_DB}
        step={1}
        text={reduce >= BREATH_REMOVE_DB ? 'Remove' : dbText(reduce)}
        hint="How far each breath goes down, in dB. 6 to 12 dB keeps it natural; at the far end (Remove) the breath is taken out completely, which can sound odd between phrases"
        onChange={(v) => change({ breathsDb: v }, 'Breath reduction', `cleanup-breath:${clipId}`)}
      />
      <SliderRow
        label="Sensitivity"
        value={Math.round((breaths?.sensitivity ?? DEFAULT_BREATHS.sensitivity) * 100)}
        min={0}
        max={100}
        step={1}
        text={percent(breaths?.sensitivity ?? DEFAULT_BREATHS.sensitivity)}
        hint="How many breaths are found, in %. Higher also finds shorter and louder ones; lower finds only the clear ones (an “s” or “f” is never taken for a breath at the default)"
        onChange={(v) => change({ breathSensitivity: v }, 'Breath sensitivity', `cleanup-breath-sens:${clipId}`)}
      />
      {spans === undefined ? (
        <p className={styles.note}>The breaths are found when the cleaned sound is made (a moment after a change).</p>
      ) : spans.length === 0 ? (
        <p className={styles.note}>No breaths found. Raise the sensitivity to look for shorter and louder ones.</p>
      ) : (
        <ul className={styles.list} aria-label="Breaths found">
          {spans.map((b, i) => (
            <li key={`${b.from}-${i}`}>
              <label data-hint={`Breath ${i + 1}, from ${b.from.toFixed(2)} to ${b.to.toFixed(2)} s. Untick to leave this one as it was recorded`}>
                <input type="checkbox" checked={!b.off} onChange={() => toggleBreath(services, clipId, i)} />
                Breath {i + 1}: bar {barOf(b.from).toFixed(1)}, {(b.to - b.from).toFixed(2)} s
              </label>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Mouth-click removal. */
export function ClickSection({ clipId, cleanup }: SectionProps) {
  const services = useServices();
  const clicks = cleanup?.clicks;
  const repaired = useStore(cleanupState, (st) => st.clicks[clipId]);
  const change = (request: Parameters<typeof changeCleanup>[2], label: string, key?: string) => changeCleanup(services, clipId, request, label, key);
  return (
    <Section
      title="Mouth clicks"
      isOn={!!clicks}
      onToggle={(on) => change({ clicks: on }, on ? 'Remove mouth clicks' : 'Mouth clicks left in')}
      hint="Finds the wet clicks and lip smacks (very short, sharp sounds) and repairs them from the sound around them. Consonants and a voice's own pulses are left alone"
      intro="Repairs lip smacks and tongue clicks without touching consonants."
    >
      <SliderRow
        label="Sensitivity"
        value={Math.round((clicks?.sensitivity ?? DEFAULT_CLICKS.sensitivity) * 100)}
        min={0}
        max={100}
        step={1}
        text={percent(clicks?.sensitivity ?? DEFAULT_CLICKS.sensitivity)}
        hint="How small a click still counts, in %. Higher finds quieter clicks (and may touch sharp consonants); lower fixes only the loud ones"
        onChange={(v) => change({ clickSensitivity: v }, 'Click sensitivity', `cleanup-click-sens:${clipId}`)}
      />
      <p className={styles.note}>
        {repaired === undefined ? 'The number of clicks repaired shows here once the cleaned sound is made.' : repaired === 0 ? 'No clicks found in this clip.' : `${repaired} click${repaired === 1 ? '' : 's'} repaired.`}
      </p>
    </Section>
  );
}
