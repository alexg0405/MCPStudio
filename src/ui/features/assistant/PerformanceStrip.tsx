import { useEffect, useRef, useState, type DragEvent, type RefObject } from 'react';
import type { PerformanceRole } from '@core/beat/local';
import type { AssistantApi } from '@app/assistant/api';
import type { AssistantState } from '@app/assistant/assistant';
import { Icon } from '../../controls/Icon';
import { onFrame } from '../../frame-loop';
import { useServices } from '../../services-context';
import { TakeView } from './TakeView';
import styles from './Assistant.module.css';

/** What the noises of a performance can stand for. */
const ROLES: { value: PerformanceRole; label: string }[] = [
  { value: 'auto', label: 'Figure it out' },
  { value: 'drums', label: 'Drums (beatbox)' },
  { value: '808', label: '808 line (hum)' },
  { value: 'melody', label: 'Melody (hum)' },
];

/** How long a recording can be, in bars. */
const BAR_CHOICES = [1, 2, 4];
/** The input meter is drawn this much hotter than the raw level, so a normal voice fills most of it. */
const METER_GAIN = 1.4;
/** Beats per bar the "Recording bar 2 of 4" line counts in (the performance grid is 4/4). */
const BEATS_PER_BAR = 4;
/** File types a dropped recording may have. */
const AUDIO_FILE_NAME = /\.(wav|aiff?|mp3|m4a|ogg|opus|flac|webm)$/i;

const NOISE_NAMES: Record<string, [singular: string, plural: string]> = {
  kick: ['kick', 'kicks'],
  snare: ['snare', 'snares'],
  hat: ['hat', 'hats'],
  tonal: ['note', 'notes'],
};

/** "3 kicks, 2 snares, 1 note": what the take holds. */
function summarizeTake(events: readonly { kind: string }[]): string {
  const countByKind: Record<string, number> = {};
  for (const event of events) countByKind[event.kind] = (countByKind[event.kind] ?? 0) + 1;
  return Object.entries(countByKind)
    .map(([kind, count]) => {
      const [singular, plural] = NOISE_NAMES[kind] ?? [kind, kind];
      return `${count} ${count === 1 ? singular : plural}`;
    })
    .join(', ');
}

/** The "Use a recording…" button: opens a file picker for a recording made elsewhere. */
function FileButton({ disabled, onFile }: { disabled: boolean; onFile(file: File): void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        className={styles.ghost}
        disabled={disabled}
        onClick={() => input.current?.click()}
        data-hint="Use a recording you already have (e.g. a voice memo); you can also drop it here"
      >
        Use a recording…
      </button>
      <input
        ref={input}
        type="file"
        accept="audio/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) onFile(file);
        }}
      />
    </>
  );
}

/** Draws the input level and the count-in on the frame loop while recording (no React renders). */
function useLiveRecordingDisplay(
  assistant: AssistantApi,
  isLive: boolean,
  totalBars: number,
  meter: RefObject<HTMLDivElement | null>,
  status: RefObject<HTMLSpanElement | null>,
): void {
  const services = useServices();
  useEffect(() => {
    if (!isLive) return;
    const bpm = services.doc.getState().project.transport.bpm;
    return onFrame(() => {
      const level = assistant.recordingLevel();
      if (meter.current) meter.current.style.transform = `scaleX(${Math.min(1, level * METER_GAIN)})`;
      const positionSec = assistant.recordingPosition();
      if (!status.current || positionSec === null) return;
      const beats = (positionSec * bpm) / 60;
      const bar = Math.min(totalBars, Math.floor(beats / BEATS_PER_BAR) + 1);
      status.current.textContent =
        positionSec < 0 ? `Count-in… ${Math.ceil(-beats)}` : `Recording bar ${bar} of ${totalBars}`;
    });
  }, [isLive, assistant, services, totalBars, meter, status]);
}

/** Record or Stop, plus (when not recording) how long and what the noises stand for. */
function RecordRow({ state, isLive, meter, status }: RecordRowProps) {
  const assistant = useServices().assistant;
  const isBusy = state.phase !== 'idle';
  return (
    <div className={styles.row}>
      {isLive ? (
        <button
          className={`${styles.record} ${styles.recording}`}
          onClick={() => assistant.stopRecording()}
          data-hint="Stop recording"
        >
          <Icon name="stop" size={12} /> Stop
        </button>
      ) : (
        <button
          className={styles.record}
          disabled={isBusy}
          onClick={() => void assistant.record()}
          data-hint={`Record ${state.bars} bar${state.bars === 1 ? '' : 's'} after a one-bar count-in (uses your microphone)`}
        >
          <Icon name="mic" size={14} /> Record
        </button>
      )}
      {isLive ? (
        <div className={styles.liveInfo}>
          <span ref={status}>Count-in…</span>
          <div className={styles.meter}>
            <div ref={meter} className={styles.meterFill} />
          </div>
        </div>
      ) : (
        <>
          <label className={styles.option} data-hint="How long to record">
            Bars
            <select
              value={state.bars}
              onChange={(event) => assistant.set({ bars: Number(event.target.value) })}
              disabled={isBusy}
            >
              {BAR_CHOICES.map((bars) => (
                <option key={bars} value={bars}>
                  {bars}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.option} data-hint="What your noises stand for">
            Noises are
            <select
              value={state.role}
              onChange={(event) => assistant.set({ role: event.target.value as PerformanceRole })}
              disabled={isBusy}
            >
              {ROLES.map((role) => (
                <option key={role.value} value={role.value}>
                  {role.label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </div>
  );
}

interface RecordRowProps {
  state: AssistantState;
  isLive: boolean;
  meter: RefObject<HTMLDivElement | null>;
  status: RefObject<HTMLSpanElement | null>;
}

/** The switches under the record button: click, play along, use my sounds, and importing a file. */
function RecordOptionsRow({ state }: { state: AssistantState }) {
  const assistant = useServices().assistant;
  return (
    <div className={styles.row}>
      <label className={styles.switch} data-hint="Hear a click while you record (the count-in always clicks)">
        <input
          type="checkbox"
          checked={state.click}
          onChange={(event) => assistant.set({ click: event.target.checked })}
        />
        Click
      </label>
      <label
        className={styles.switch}
        data-hint="Play the current pattern while you record (use headphones so the mic doesn't pick it up)"
      >
        <input
          type="checkbox"
          checked={state.playAlong}
          onChange={(event) => assistant.set({ playAlong: event.target.checked })}
        />
        Play my beat along
      </label>
      <label
        className={styles.switch}
        data-hint="Build the drums from your own beatboxed kick, snare and hat instead of the kit"
      >
        <input
          type="checkbox"
          checked={state.mySounds}
          onChange={(event) => assistant.set({ mySounds: event.target.checked })}
        />
        Use my sounds
      </label>
      <span className={styles.spacer} />
      <FileButton disabled={state.phase !== 'idle'} onFile={(file) => void assistant.importRecording(file)} />
    </div>
  );
}

/** The recorded take: its notes, what it holds, and Play take / Clear. */
function TakeRow({ take }: { take: NonNullable<AssistantState['take']> }) {
  const assistant = useServices().assistant;
  return (
    <>
      <TakeView take={take} />
      <div className={styles.row}>
        <span className={styles.dim}>{summarizeTake(take.events)}</span>
        <span className={styles.spacer} />
        <button
          className={styles.ghost}
          disabled={!take.audio}
          onClick={() => assistant.playTake()}
          data-hint={
            take.audio ? 'Play your take back' : 'The recording itself is gone after a reload (its notes are kept)'
          }
        >
          Play take
        </button>
        <button className={styles.ghost} onClick={() => assistant.clearTake()} data-hint="Forget this take">
          Clear
        </button>
      </div>
    </>
  );
}

/** The performance strip: record your voice (or import a recording), see the take, and send it with your request. */
export function PerformanceStrip({ state }: { state: AssistantState }) {
  const assistant = useServices().assistant;
  const meter = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLSpanElement>(null);
  const isLive = state.phase === 'counting-in' || state.phase === 'recording';
  const [isDragOver, setIsDragOver] = useState(false);
  useLiveRecordingDisplay(assistant, isLive, state.bars, meter, status);

  const onDragOver = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  };
  const onDrop = (event: DragEvent) => {
    setIsDragOver(false);
    const file = [...event.dataTransfer.files].find((candidate) => AUDIO_FILE_NAME.test(candidate.name));
    if (!file) return;
    event.preventDefault();
    void assistant.importRecording(file);
  };

  return (
    <div
      className={`${styles.performance} ${isDragOver ? styles.dragOver : ''}`}
      onDragOver={onDragOver}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={onDrop}
    >
      <RecordRow state={state} isLive={isLive} meter={meter} status={status} />
      {!isLive && <RecordOptionsRow state={state} />}
      {state.phase === 'analyzing' && <div className={styles.dim}>Listening back…</div>}
      {state.take && !isLive && <TakeRow take={state.take} />}
    </div>
  );
}
