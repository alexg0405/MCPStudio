import { useStore } from 'zustand';
import type { Services } from '@app/services';
import type { MenuEntry } from '../../controls/ContextMenu';
import { showContextMenu } from '../../controls/ContextMenu';
import { useServices } from '../../services-context';
import { Icon } from '../../controls/Icon';
import styles from './Recording.module.css';

/** What record mode will record, in a few words: "Notes", "Audio", "Notes + audio", "Nothing". */
export function recordSourceLabel(notes: boolean, audio: boolean): string {
  if (notes && audio) return 'Notes + audio';
  if (audio) return 'Audio';
  if (notes) return 'Notes';
  return 'Nothing';
}

/** The record-source menu (also used by the Options menu entries). */
export function recordSourceMenu(s: Services): MenuEntry[] {
  const p = s.prefs.getState();
  const input = s.audioInput.store.getState();
  return [
    { kind: 'label', label: 'Record mode records' },
    {
      label: 'Notes and knob moves',
      checked: p.recordNotes,
      hint: 'Notes you play (MIDI, typing keyboard, on-screen piano) and knobs you move',
      onSelect: () => void s.commands.run('transport.recordNotes'),
    },
    {
      label: `Audio${input.status === 'on' ? ` from ${input.label}` : ' from the input'}`,
      checked: p.recordAudio,
      hint: 'Your microphone or audio interface, into the playlist where you played it',
      onSelect: () => void s.commands.run('transport.recordAudio'),
    },
    { kind: 'separator' },
    {
      label: 'Hear the input (monitoring)',
      checked: p.audioMonitor,
      hint: 'Play the input through its mixer track; use headphones (speakers feed back into the mic)',
      onSelect: () => void s.commands.run('audio.monitor'),
    },
    { label: 'Audio input…', hint: 'Choose the input, mono or stereo, see its level', onSelect: () => void s.commands.run('options.audioInput') },
    { label: 'Calibrate latency…', hint: 'Measure the delay so recordings land on the beat', onSelect: () => void s.commands.run('audio.calibrateLatency') },
  ];
}

/** Next to the record button: what will be recorded, and whether the input is monitored. */
export function RecordSource() {
  const services = useServices();
  const notes = useStore(services.prefs, (p) => p.recordNotes);
  const audio = useStore(services.prefs, (p) => p.recordAudio);
  const monitor = useStore(services.prefs, (p) => p.audioMonitor);
  const armed = useStore(services.recording.store, (r) => r.armed);
  const recording = useStore(services.recording.store, (r) => r.recording);
  const status = useStore(services.audioInput.store, (st) => st.status);
  const label = recordSourceLabel(notes, audio);
  const hint = `Record mode records: ${label.toLowerCase()}${audio ? (status === 'on' ? ' (input open)' : ' (the input opens when you arm)') : ''}${
    monitor && status === 'on' ? ' · monitoring is on' : ''
  } · click to change`;
  return (
    <button
      className={`${styles.source} ${armed ? styles.sourceArmed : ''}`}
      tabIndex={-1}
      onPointerDown={(e) => e.preventDefault()}
      onClick={(e) => showContextMenu(e, recordSourceMenu(services))}
      data-hint={hint}
      aria-label={`Record: ${label}`}
    >
      <span className={recording ? styles.recording : ''}>{recording ? '● ' : ''}</span>
      {label}
      {monitor && status === 'on' && <span className={styles.mon}>MON</span>}
      <Icon name="chevronDown" size={10} className={styles.caret} />
    </button>
  );
}
