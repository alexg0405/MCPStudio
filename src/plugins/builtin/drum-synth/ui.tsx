import { useRef } from 'react';
import type { PluginUIProps } from '@agstudio/sdk';
import { noteName } from '@agstudio/sdk/notes';
import { formatPan, ParamKnob, ParamToggle } from '@agstudio/sdk/ui';
import { DRUMS, type DrumId, type DrumSynthParams } from './params';
import styles from './ui.module.css';

type Props = PluginUIProps<DrumSynthParams>;
type Param = keyof DrumSynthParams & string;

/** The knobs of each drum, left to right (level and pan last). */
const KNOBS: Record<DrumId, Param[]> = {
  kick: ['kickPitch', 'kickSweep', 'kickSweepTime', 'kickDecay', 'kickClick', 'kickDrive', 'kickLevel', 'kickPan'],
  perc: ['percPitch', 'percRing', 'percDecay', 'percNoise', 'percLevel', 'percPan'],
  snare: ['snareTone', 'snareSnappy', 'snareDecay', 'snareBright', 'snareLevel', 'snarePan'],
  clap: ['clapTone', 'clapDecay', 'clapSpread', 'clapLevel', 'clapPan'],
  chat: ['chatDecay', 'chatTone', 'chatLevel', 'chatPan'],
  tom: ['tomPitch', 'tomSweep', 'tomDecay', 'tomLevel', 'tomPan'],
  ohat: ['ohatDecay', 'ohatTone', 'ohatLevel', 'ohatPan'],
};

/** A pad that plays the drum while pressed. */
function Pad({ ui, name, keys }: { ui: Props; name: string; keys: readonly number[] }) {
  const release = useRef<(() => void) | null>(null);
  const key = keys.includes(36) ? 36 : (keys.find((k) => k === 45) ?? (keys[0] as number));
  const others = keys.filter((k) => k !== key);
  const hint =
    `${name}: plays on ${noteName(key)} (key ${key})` +
    (others.length ? `, also ${others.map((k) => `${noteName(k)} (${k})`).join(', ')}` : '') +
    (ui.playNote ? '. Click to hear it' : '');
  const stop = () => {
    release.current?.();
    release.current = null;
  };
  return (
    <button
      type="button"
      tabIndex={-1}
      className={styles.pad}
      data-hint={hint}
      disabled={!ui.playNote}
      onPointerDown={(e) => {
        if (e.button !== 0 || !ui.playNote) return;
        e.preventDefault();
        stop();
        release.current = ui.playNote(key, 0.9);
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
    >
      <span className={styles.padName}>{name}</span>
      <span className={styles.padKey}>{noteName(key)}</span>
    </button>
  );
}

/** The Drum Synth editor: one row per drum (a pad to play it, then its knobs). */
export function DrumSynthUI(ui: Props) {
  return (
    <div className={styles.root}>
      {DRUMS.map((d) => (
        <div key={d.id} className={styles.row} data-hint={`${d.name}: shape this drum with the knobs on the right`}>
          <Pad ui={ui} name={d.name} keys={d.keys} />
          <div className={styles.knobs}>
            {KNOBS[d.id].map((id) => (
              <ParamKnob key={id} ui={ui} param={id} size={26} {...(id.endsWith('Pan') ? { format: formatPan } : {})} />
            ))}
            {d.id === 'ohat' && (
              <div className={styles.toggle}>
                <ParamToggle ui={ui} param="hatChoke" />
              </div>
            )}
          </div>
        </div>
      ))}
      <div className={styles.row} data-hint="Output: velocity response and the overall volume">
        <div className={styles.label}>Output</div>
        <div className={styles.knobs}>
          <ParamKnob ui={ui} param="velocity" size={26} />
          <ParamKnob ui={ui} param="level" size={26} />
        </div>
      </div>
    </div>
  );
}
