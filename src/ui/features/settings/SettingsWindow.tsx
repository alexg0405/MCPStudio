import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { canChooseOutput, listOutputs, onDevicesChange, revealDevices, type AudioOutput } from '@app/audio-devices';
import { formatChord } from '@core/commands/keymap';
import { useServices } from '../../services-context';
import { ACCENTS, findAccent, findTheme, THEMES } from '../../theme/apply';
import { testSoundWav } from './test-sound';
import styles from './Settings.module.css';

export const QUANTIZE: readonly (readonly [label: string, ticks: number])[] = [
  ['Off (as played)', 0],
  ['1/4 note', 960],
  ['1/8 note', 480],
  ['1/16 note', 240],
  ['1/32 note', 120],
  ['1/8 triplet', 320],
  ['1/16 triplet', 160],
];
const COUNT_IN = [0, 1, 2, 4];

function Section({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.heading}>{title}</h3>
      {intro && <p className={styles.intro}>{intro}</p>}
      {children}
    </section>
  );
}

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <div className={styles.label}>{label}</div>
      <div className={styles.control}>
        <div className={styles.inline}>{children}</div>
        {hint && <div className={styles.hint}>{hint}</div>}
      </div>
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange(): void; label: string }) {
  return (
    <label className={styles.switch}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}

/** Where the sound plays: the output device, a test sound, and the rate and delay the browser reports. */
function SoundOutput() {
  const s = useServices();
  const chosen = useStore(s.prefs, (p) => p.outputDevice);
  const [list, setList] = useState<{ outputs: AudioOutput[]; complete: boolean } | null>(null);
  const refresh = useCallback(() => void listOutputs().then(setList), []);
  useEffect(() => {
    refresh();
    return onDevicesChange(refresh);
  }, [refresh]);
  const subscribe = useCallback(
    (fn: () => void) => {
      const id = window.setInterval(fn, 1000);
      const off = s.engine.subscribe(fn);
      return () => {
        window.clearInterval(id);
        off();
      };
    },
    [s],
  );
  const info = useSyncExternalStore(subscribe, () => {
    const st = s.engine.stats();
    const rate = `${(st.sampleRate / 1000).toFixed(st.sampleRate % 1000 ? 1 : 0)} kHz`;
    if (st.state !== 'running') return `${rate} · sound starts after your first click or key press`;
    return `${rate} · about ${Math.round((st.baseLatency + st.outputLatency) * 1000)} ms from AGstudio to your ears`;
  });

  const supported = canChooseOutput();
  const outputs = list?.outputs ?? [{ id: '', label: 'System default' }];
  // A saved device that isn't plugged in stays listed, so the choice doesn't change behind your back.
  const missing = !!chosen && !!list && !outputs.some((o) => o.id === chosen);
  const showAll = async () => {
    if (await revealDevices()) refresh();
    else s.session.getState().toast('The browser didn’t allow it, so only the system default is listed.', 'error');
  };
  const test = () => {
    void s.engine.resume().then(() => s.engine.previewAudio(testSoundWav(s.engine.sampleRate).slice().buffer));
  };

  return (
    <Section title="Sound output" intro="Where AGstudio plays: your speakers, headphones or audio interface.">
      <Row
        label="Play through"
        hint={
          !supported
            ? 'This browser always plays through the system output; choose it in your computer’s sound settings (Chrome and Edge can choose here).'
            : missing
              ? 'That device isn’t connected right now, so the system default plays. Plug it in, or pick another one.'
              : null
        }
      >
        <select
          className={styles.select}
          value={chosen}
          disabled={!supported}
          onChange={(e) => s.prefs.getState().set({ outputDevice: e.target.value })}
          data-hint="The device AGstudio plays through (remembered in this browser)"
        >
          {outputs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
          {missing && <option value={chosen}>The device you chose before (not connected)</option>}
        </select>
        <button className={styles.button} onClick={test} data-hint="A chime in the left speaker, then the right">
          ▶ Test sound
        </button>
      </Row>
      {supported && list && !list.complete && (
        <Row
          label=""
          hint="Browsers list your other speakers and headphones only after a site may use the microphone. AGstudio turns it off again right away and records nothing."
        >
          <button className={styles.button} onClick={() => void showAll()}>
            Show all my devices…
          </button>
        </Row>
      )}
      <Row label="Status" hint="Bluetooth headphones add a lot of delay; wired ones are best for recording and playing live.">
        <span className={styles.value}>{info}</span>
      </Row>
    </Section>
  );
}

/** MIDI keyboards and controllers: on or off, and what's connected. */
function Midi() {
  const s = useServices();
  const subscribe = useCallback((fn: () => void) => s.midi.subscribe(fn), [s]);
  const snap = useSyncExternalStore(subscribe, () => JSON.stringify([s.midi.enabled, s.midi.inputNames()]));
  const [enabled, names] = JSON.parse(snap) as [boolean, string[]];
  return (
    <Section title="MIDI keyboards and controllers">
      <Row
        label="MIDI input"
        hint={
          !enabled
            ? 'Turn this on to play the selected sound from a MIDI keyboard. Chrome asks once for permission.'
            : names.length === 0
              ? 'Nothing connected yet. Plug a keyboard in; it shows up here by itself.'
              : 'To move a knob from your controller: right-click the knob → Link to controller…, then turn a knob on the controller.'
        }
      >
        <Switch checked={enabled} onChange={() => s.commands.run('options.midiInput')} label="Listen to MIDI devices" />
      </Row>
      {enabled && names.length > 0 && (
        <Row label="Connected">
          <span className={styles.chips}>
            {names.map((n, i) => (
              <span key={`${n}-${i}`} className={styles.chip}>
                {n}
              </span>
            ))}
          </span>
        </Row>
      )}
    </Section>
  );
}

function ComputerKeyboard() {
  const s = useServices();
  const on = useStore(s.prefs, (p) => p.typingPiano);
  const octave = useStore(s.prefs, (p) => p.pianoOctave);
  const alt = s.platform === 'mac' ? '⌥' : 'Alt';
  return (
    <Section title="Computer keyboard">
      <Row
        label="Typing piano"
        hint="Play the selected sound with your letter keys: Z X C V B N M are the white keys (S D G H J the black ones), and Q W E R T Y U an octave higher."
      >
        <Switch checked={on} onChange={() => s.commands.run('options.typingPiano')} label="Letter keys play notes" />
      </Row>
      <Row label="Octave" hint={`Z plays C${octave}. ${alt}+↓ and ${alt}+↑ change it while you play.`}>
        <button className={styles.small} onClick={() => s.commands.run('options.octaveDown')} aria-label="Octave down">
          −
        </button>
        <span className={styles.value}>C{octave}</span>
        <button className={styles.small} onClick={() => s.commands.run('options.octaveUp')} aria-label="Octave up">
          +
        </button>
      </Row>
    </Section>
  );
}

function Recording() {
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

function Interface() {
  const s = useServices();
  const tooltips = useStore(s.prefs, (p) => p.tooltips);
  const theme = findTheme(useStore(s.prefs, (p) => p.theme)) ?? 'dark';
  const accent = findAccent(useStore(s.prefs, (p) => p.accent)) ?? 'orange';
  return (
    <Section title="Look, help and interface">
      <Row label="Theme" hint={THEMES.find((t) => t.id === theme)?.hint}>
        <select
          className={styles.select}
          value={theme}
          onChange={(e) => s.commands.run('options.theme', e.target.value)}
          data-hint="How AGstudio looks (remembered in this browser)"
        >
          {THEMES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Accent color" hint="Buttons, the playhead, the loop and selections take this color.">
        <span className={styles.swatches} role="radiogroup" aria-label="Accent color">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              role="radio"
              aria-checked={accent === a.id}
              aria-label={a.label}
              className={`${styles.swatch} ${accent === a.id ? styles.swatchOn : ''}`}
              style={{ background: a.color }}
              onClick={() => s.commands.run('options.accent', a.id)}
              data-hint={`Accent color: ${a.label}`}
            />
          ))}
        </span>
      </Row>
      <Row label="Tooltips" hint="The bar at the bottom of the screen explains whatever you point at either way.">
        <Switch checked={tooltips} onChange={() => s.commands.run('options.tooltips')} label="Explain controls in a bubble" />
      </Row>
      <Row label="Getting started">
        <button className={styles.button} onClick={() => s.commands.run('help.welcome')}>
          Welcome screen
        </button>
        <button className={styles.button} onClick={() => s.commands.run('help.tour')}>
          Take the tour
        </button>
        <button className={styles.button} onClick={() => s.commands.run('help.shortcuts')}>
          Keyboard shortcuts
        </button>
      </Row>
    </Section>
  );
}

/** Every per-browser setting in one place, in plain words (they're remembered in this browser, not in projects). */
export function SettingsWindow() {
  return (
    <div className={styles.wrap}>
      <SoundOutput />
      <Midi />
      <ComputerKeyboard />
      <Recording />
      <Interface />
      <p className={styles.footer}>Settings are remembered in this browser. They aren’t saved in your projects.</p>
    </div>
  );
}
