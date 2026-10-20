import { useStore } from 'zustand';
import { UI_SCALE_MAX, UI_SCALE_MIN, type AccessChoice } from '@app/stores/prefs';
import { useServices } from '../../services-context';
import { Row, Section, Switch } from '../settings/parts';
import styles from '../settings/Settings.module.css';

/** The three ways a setting that follows the system can be set, as the dropdowns word them. */
const CHOICES: readonly { value: AccessChoice; label: string }[] = [
  { value: 'auto', label: 'Follow the system' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

/** A dropdown for a follow-the-system setting; picking runs the command, so menu, AI and window agree. */
function ChoiceSelect({ command, value, label }: { command: string; value: AccessChoice; label: string }) {
  const services = useServices();
  return (
    <select
      className={styles.select}
      value={value}
      onChange={(e) => services.commands.run(command, e.target.value)}
      aria-label={label}
      data-hint={`${label}: follow the system's own setting, or turn it on or off here`}
    >
      {CHOICES.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </select>
  );
}

/** Settings → Accessibility: interface size, contrast, motion, colour-blind safe colours and the keyboard help. */
export function AccessibilitySection() {
  const services = useServices();
  const scale = useStore(services.prefs, (p) => p.uiScale);
  const contrast = useStore(services.prefs, (p) => p.highContrast);
  const motion = useStore(services.prefs, (p) => p.reduceMotion);
  const colorSafe = useStore(services.prefs, (p) => p.colorSafe);
  return (
    <Section title="Accessibility">
      <Row label="Interface size" hint="Makes the text and the editors’ labels bigger or smaller (90 to 150 percent). Windows and buttons keep their layout.">
        <input
          type="range"
          min={UI_SCALE_MIN}
          max={UI_SCALE_MAX}
          step={5}
          value={scale}
          onChange={(e) => services.commands.run('options.uiScale', Number(e.target.value))}
          aria-label="Interface size"
          aria-valuetext={`${scale} percent`}
          data-hint="Interface size in percent of the normal size (90 to 150)"
        />
        <span className={styles.value}>{scale}%</span>
        <button className={styles.small} onClick={() => services.commands.run('options.uiScale', 'reset')} disabled={scale === 100} data-hint="Back to the normal size (100 percent)">
          Normal
        </button>
      </Row>
      <Row label="High contrast" hint="Stronger text, lines and focus rings on your theme. For the strongest contrast pick the High contrast themes under Theme.">
        <ChoiceSelect command="options.highContrast" value={contrast} label="High contrast" />
      </Row>
      <Row label="Less motion" hint="No gliding or smooth scrolling. While playing, the editors jump a page when the playhead reaches the edge.">
        <ChoiceSelect command="options.reduceMotion" value={motion} label="Less motion" />
      </Row>
      <Row label="Colour-blind safe colours" hint="Blue and orange instead of green and red for meters, notes and lights. Clips, chords and lyrics also get patterns and shapes, so colour is never the only clue.">
        <Switch checked={colorSafe} onChange={() => services.commands.run('options.colorSafe')} label="Use colour-blind safe colours" />
      </Row>
      <Row label="Keyboard and screen reader" hint="Every key for using AGstudio without a mouse, and what a screen reader says.">
        <button className={styles.button} onClick={() => services.commands.run('help.keyboard')}>
          Keyboard navigation
        </button>
      </Row>
    </Section>
  );
}
