import { useStore } from 'zustand';
import { formatChord } from '@core/commands/keymap';
import { useServices } from '../../services-context';
import { Row, Section, Switch } from './parts';
import styles from './Settings.module.css';

const QUANTIZE: readonly (readonly [label: string, ticks: number])[] = [
  ['Off (as played)', 0],
  ['1/4 note', 960],
  ['1/8 note', 480],
  ['1/16 note', 240],
  ['1/32 note', 120],
  ['1/8 triplet', 320],
  ['1/16 triplet', 160],
];
const COUNT_IN = [0, 1, 2, 4];

/** Recording: what record mode captures, the audio input and its delay, the metronome, count-in, snapping and what happens over old notes. */
export function RecordingSection() {
  const s = useServices();
  const metronome = useStore(s.prefs, (p) => p.metronome);
  const countIn = useStore(s.prefs, (p) => p.countInBars);
  const quantize = useStore(s.prefs, (p) => p.recordQuantize);
  const mode = useStore(s.prefs, (p) => p.recordMode);
  const notes = useStore(s.prefs, (p) => p.recordNotes);
  const audio = useStore(s.prefs, (p) => p.recordAudio);
  const device = useStore(s.prefs, (p) => p.audioInputDevice);
  const channels = useStore(s.prefs, (p) => p.audioInputChannels);
  const latency = useStore(s.prefs, (p) => p.recordLatencyMs);
  const offset = useStore(s.prefs, (p) => p.recordLatencyOffsetMs);
  const record = formatChord(s.keymap.chordsFor('transport.record')[0] ?? 'R', s.platform);
  return (
    <Section
      title="Recording"
      intro={`Press ${record} (or the record button) to arm recording, then play: notes go into the pattern, audio onto the playlist.`}
    >
      <Row label="Records" hint="What record mode captures when you play.">
        <Switch checked={notes} onChange={() => s.commands.run('transport.recordNotes')} label="Notes and knob moves" />
        <Switch checked={audio} onChange={() => s.commands.run('transport.recordAudio')} label="Audio from the input" />
      </Row>
      <Row
        label="Audio input"
        hint="The microphone or audio interface you record from, its level, and monitoring (use headphones when monitoring)."
      >
        <span className={styles.value}>
          {device ? 'Chosen device' : 'System default'} · {channels === 'stereo' ? 'stereo' : 'mono'}
        </span>
        <button className={styles.button} onClick={() => s.commands.run('options.audioInput')}>
          Audio input…
        </button>
      </Row>
      <Row
        label="Delay"
        hint="Recordings are moved back by the time sound takes to go out and come back in, so they land on the beat."
      >
        <span className={styles.value}>
          {latency >= 0 ? `${Math.round(latency)} ms measured` : 'the browser’s estimate'}
          {offset ? ` ${offset > 0 ? '+' : '−'} ${Math.abs(offset)} ms` : ''}
        </span>
        <button className={styles.button} onClick={() => s.commands.run('audio.calibrateLatency')}>
          Calibrate…
        </button>
      </Row>
      <Row label="Metronome" hint="A click on every beat while playing (never in exports).">
        <Switch checked={metronome} onChange={() => s.commands.run('transport.metronome')} label="Click while playing" />
      </Row>
      <Row label="Count-in" hint="Clicks before recording starts, so you come in on time.">
        <select
          className={styles.select}
          value={countIn}
          onChange={(e) => s.commands.run('transport.countIn', Number(e.target.value))}
        >
          {COUNT_IN.map((bars) => (
            <option key={bars} value={bars}>
              {bars ? `${bars} bar${bars > 1 ? 's' : ''}` : 'Off'}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Snap notes to" hint="Recorded notes start exactly on this grid (Off keeps your timing).">
        <select
          className={styles.select}
          value={quantize}
          onChange={(e) => s.commands.run('transport.recordQuantize', Number(e.target.value))}
        >
          {QUANTIZE.map(([label, ticks]) => (
            <option key={ticks} value={ticks}>
              {label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Over old notes" hint="Add to the notes already there, or replace what the recording passes over.">
        <select
          className={styles.select}
          value={mode}
          onChange={(e) => s.commands.run('transport.recordMode', e.target.value)}
        >
          <option value="overdub">Keep them (overdub)</option>
          <option value="replace">Replace them</option>
        </select>
      </Row>
    </Section>
  );
}
