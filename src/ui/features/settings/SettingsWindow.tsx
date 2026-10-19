import { useCallback, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { useServices } from '../../services-context';
import { ACCENTS, effectiveAccent, findTheme, THEMES } from '../../theme/apply';
import { McpSettings } from '../mcp/McpSettings';
import { Row, Section, Switch } from './parts';
import { StorageSection } from './StorageSection';
import styles from './Settings.module.css';
import { RecordingSection } from './RecordingSection';
import { SoundOutputSection } from './SoundOutputSection';

/** What the MIDI input row says: how to turn it on, that nothing is connected yet, or how to link a knob. */
function midiHint(isEnabled: boolean, deviceCount: number): string {
  if (!isEnabled) return 'Turn this on to play the selected sound from a MIDI keyboard. Chrome asks once for permission.';
  if (deviceCount === 0) return 'Nothing connected yet. Plug a keyboard in; it shows up here by itself.';
  return 'To move a knob from your controller: right-click the knob → Link to controller…, then turn a knob on the controller.';
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
        hint={midiHint(enabled, names.length)}
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

function Interface() {
  const s = useServices();
  const tooltips = useStore(s.prefs, (p) => p.tooltips);
  const touchLayout = useStore(s.prefs, (p) => p.touchLayout);
  const theme = findTheme(useStore(s.prefs, (p) => p.theme)) ?? 'marble';
  const accent = useStore(s.prefs, (p) => effectiveAccent(p.theme, p.accent, p.accentPicked));
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
      <Row
        label="Touch layout"
        hint="Bigger buttons, handles and step squares for fingers. Auto turns it on for tablets; on a laptop with a touchscreen, choose On."
      >
        <select
          className={styles.select}
          value={touchLayout}
          onChange={(e) => s.commands.run('options.touchLayout', e.target.value)}
          aria-label="Touch layout"
          data-hint="Touch layout: Auto follows the device, On gives fingers bigger targets, Off keeps the compact mouse layout"
        >
          <option value="auto">Auto (follow the device)</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      </Row>
      <Row label="Getting started" hint="Open the welcome screen, the guided tour or the list of keyboard shortcuts again.">
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
      <SoundOutputSection />
      <Midi />
      <ComputerKeyboard />
      <RecordingSection />
      <Interface />
      <McpSettings />
      <StorageSection />
      <p className={styles.footer}>Settings are remembered in this browser. They aren’t saved in your projects.</p>
    </div>
  );
}
