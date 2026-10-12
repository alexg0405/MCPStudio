import { useStore } from 'zustand';
import { useServices } from '../../services-context';
import { CommandButton } from '../../shell/Toolbar';
import styles from './InputButtons.module.css';

export function InputButtons() {
  const services = useServices();
  const octave = useStore(services.prefs, (s) => s.pianoOctave);
  const on = useStore(services.prefs, (s) => s.typingPiano);
  return (
    <div className={styles.group}>
      <CommandButton command="options.typingPiano" icon="keyboard">
        {on && <span className={styles.octave}>C{octave}</span>}
      </CommandButton>
      <CommandButton command="options.midiInput" icon="midi" />
    </div>
  );
}
