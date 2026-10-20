import { useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import { clearClipCleanup, defaultCleanupClip, stopHearingRemoved } from '@app/actions/cleanup';
import { audioClipOf } from '@app/actions/pitch-clip';
import { cleanupState } from '@app/cleanup/state';
import { isNeutralCleanup, isRenderCurrent } from '@core/audio/cleanup-edit';
import { clipSourceRange, playbackMode } from '@core/audio/playback';
import { tempoMapOf } from '@core/automation/tempo';
import type { ClipId, Project, VocalCleanup } from '@core/model/types';
import { Icon } from '../../controls/Icon';
import { useDoc, useEngineStatus, useServices } from '../../services-context';
import { ToolButton } from './CleanupControls';
import { BreathSection, ClickSection, NoiseSection } from './CleanupSections';
import { WaveStrip } from './WaveStrip';
import styles from './CleanupWindow.module.css';

/** The part of the recording the clip plays, as "from|to" seconds (a string, so a selector can compare it). */
function playedKey(p: Project, clipId: ClipId | null): string {
  const found = clipId ? audioClipOf(p, clipId) : null;
  if (!found) return '0|0';
  const ref = p.samples[found.channel.sampleId];
  const duration = ref?.durationSec ?? 0;
  const range = clipSourceRange(found.clip, playbackMode(found.channel), tempoMapOf(p, 'song'), duration);
  return `${range.from}|${range.to}`;
}

/** What the status line says about the clip: nothing on yet, rendering, ready, hearing the recording, or not made yet. */
function statusText(input: {
  cleanup: VocalCleanup | undefined;
  isRendering: boolean;
  fraction: number;
  isHearingOriginal: boolean;
  isHearingRemoved: boolean;
}): string {
  const { cleanup, isRendering, fraction, isHearingOriginal, isHearingRemoved } = input;
  if (isHearingRemoved) return 'Playing only what was removed (the noise, breaths and clicks): no voice should be in it';
  if (!cleanup || isNeutralCleanup(cleanup)) return 'Switch a section on to start: nothing is changed yet';
  if (isHearingOriginal) return 'Hearing your recording as recorded (switch to Cleaned to hear the cleanup)';
  if (isRendering) return `Making the cleaned sound ${Math.round(fraction * 100)} %…`;
  if (isRenderCurrent(cleanup)) return 'Cleaned sound ready: the clip plays it. Your recording is untouched';
  return 'The cleaned sound is being made (it follows every change a moment after you stop)';
}

/** The Clean up vocal window: noise, breaths and clicks of one audio clip, with a before/after listen. */
export function CleanupWindow() {
  const services = useServices();
  const clipId = useStore(cleanupState, (st) => st.clipId);
  const rendering = useStore(cleanupState, (st) => st.rendering);
  const isHearingRemoved = useStore(cleanupState, (st) => st.hearingRemoved);
  const isHearingOriginal = useStore(services.editor, (e) => !!clipId && e.cleanupOriginal.includes(clipId));
  const { playing } = useEngineStatus();
  const cleanup = useDoc((p) => (clipId ? audioClipOf(p, clipId)?.clip.cleanup : undefined));
  const hasPitch = useDoc((p) => (clipId ? !!audioClipOf(p, clipId)?.clip.pitchEdit?.renderedSampleId : false));
  const name = useDoc((p) => (clipId ? (audioClipOf(p, clipId)?.channel.name ?? null) : null));
  const clipStart = useDoc((p) => (clipId ? (audioClipOf(p, clipId)?.clip.start ?? 0) : 0));
  const sample = useDoc((p) => {
    const found = clipId ? audioClipOf(p, clipId) : null;
    return found ? p.samples[found.channel.sampleId] : undefined;
  });
  const range = useDoc((p) => playedKey(p, clipId));
  const played = useMemo(() => {
    const [from, to] = range.split('|').map(Number);
    return { from: from ?? 0, to: to ?? 0 };
  }, [range]);

  // Opens on the selected audio clip when nothing was chosen yet; a clip that is gone leaves the window empty.
  useEffect(() => {
    if (!cleanupState.getState().clipId) {
      const id = defaultCleanupClip(services);
      if (id) cleanupState.setState({ clipId: id });
    }
  }, [services]);
  useEffect(() => {
    if (clipId && !name) cleanupState.setState({ clipId: null });
  }, [clipId, name]);
  // Closing the window puts every clip back on its cleaned sound and stops the "what was removed" sound.
  useEffect(
    () => () => {
      services.editor.getState().clearCleanupOriginal();
      if (cleanupState.getState().hearingRemoved) stopHearingRemoved(services);
    },
    [services],
  );

  if (!clipId || !name) return <EmptyWindow />;
  const isCurrent = !!cleanup && isRenderCurrent(cleanup);
  const hasCleanup = !!cleanup && !isNeutralCleanup(cleanup);
  const status = statusText({ cleanup, isRendering: rendering?.clipId === clipId, fraction: rendering?.fraction ?? 0, isHearingOriginal, isHearingRemoved });
  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <strong data-hint="The audio clip being cleaned up">{name}</strong>
        <span className={styles.status} aria-live="polite">
          {status}
        </span>
      </header>
      <div className={styles.body}>
        <WaveStrip clipId={clipId} sample={sample} cleanup={cleanup} played={played} isCurrent={isCurrent} />
        <NoiseSection clipId={clipId} cleanup={cleanup} />
        <BreathSection clipId={clipId} cleanup={cleanup} />
        <ClickSection clipId={clipId} cleanup={cleanup} />
        {hasPitch ? (
          <p className={styles.note}>
            This clip also has pitch correction. It is applied after the cleanup, so the Pitch editor works on the cleaned sound and the correction is made again after each cleanup change.
          </p>
        ) : null}
      </div>
      <footer className={styles.footer}>
        <button
          type="button"
          className={`${styles.tool} ${styles.play} ${playing ? styles.toolOn : ''}`}
          onClick={() => services.commands.run(playing ? 'transport.stop' : 'transport.playFrom', { tick: clipStart })}
          data-hint={playing ? 'Stop playing' : 'Play the song from the start of this clip to hear the cleanup'}
          aria-label={playing ? 'Stop' : 'Play'}
        >
          <Icon name={playing ? 'stop' : 'play'} size={14} />
        </button>
        <div className={styles.group} role="group" aria-label="Hear">
          <ToolButton
            label="Cleaned"
            isOn={!isHearingOriginal}
            isDisabled={!hasCleanup}
            hint="A: hear the cleaned sound (what the clip plays). Switch between A and B to compare; nothing in the project changes"
            onClick={() => services.commands.run('cleanup.toggleOriginal', { clip: clipId, original: false })}
          />
          <ToolButton
            label="Original"
            isOn={isHearingOriginal}
            isDisabled={!hasCleanup}
            hint="B: hear your recording as recorded, without the cleanup (or the pitch correction made from it). Nothing in the project changes; it goes back to cleaned when the window is closed"
            onClick={() => services.commands.run('cleanup.toggleOriginal', { clip: clipId, original: true })}
          />
        </div>
        <ToolButton
          label={isHearingRemoved ? 'Stop' : 'Hear what was removed'}
          isOn={isHearingRemoved}
          isDisabled={!isCurrent}
          hint="Plays only what the cleanup took out of the clip (noise, breaths, clicks), so you can check that no voice went with it. Needs the cleaned sound to be ready"
          onClick={() => services.commands.run('cleanup.hearRemoved', { clip: clipId, on: !isHearingRemoved })}
        />
        <span className={styles.spacer} />
        <ToolButton
          label="Make it now"
          isDisabled={!hasCleanup || isCurrent || rendering?.clipId === clipId}
          hint="Makes the cleaned sound right away (it normally starts a moment after the last change)"
          onClick={() => services.commands.run('cleanup.renderNow', { clip: clipId })}
        />
        <ToolButton
          label="Remove cleanup"
          isDisabled={!cleanup}
          hint="Takes the whole cleanup off this clip: it plays your recording again (one undo step)"
          onClick={() => clearClipCleanup(services, clipId)}
        />
      </footer>
    </div>
  );
}

/** What the window says before a clip is chosen. */
function EmptyWindow() {
  return (
    <div className={styles.root}>
      <p className={styles.empty}>
        No clip chosen yet. Select an audio clip in the playlist (a recorded vocal), then right-click it and choose “Clean up vocal…” (or use the
        action search, Ctrl+K / ⌘K, and type “clean up”).
      </p>
    </div>
  );
}
