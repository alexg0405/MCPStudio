import { useRef, useState, type PointerEvent } from 'react';
import type { ParamValue, PluginUIProps } from '@agstudio/sdk';
import { noteName } from '@agstudio/sdk/notes';
import { formatPan, ParamKnob, ParamSelect, ParamToggle, Section } from '@agstudio/sdk/ui';
import { type drumPadsParams, FIRST_KEY, FULL_DECAY, padParam, padSlot, SOUND_LABELS, type SoundId } from './params';
import styles from './ui.module.css';

type Props = PluginUIProps<typeof drumPadsParams>;

/** FPC / MPC layout: pad 1 at the bottom left, pad 16 at the top right. */
const ROWS = [
  [13, 14, 15, 16],
  [9, 10, 11, 12],
  [5, 6, 7, 8],
  [1, 2, 3, 4],
];

const keyOf = (n: number) => FIRST_KEY + n - 1;
const decayText = (v: ParamValue) => (Number(v) >= FULL_DECAY * 0.999 ? 'Full' : `${Number(v).toFixed(2)} s`);
const chokeText = (v: ParamValue) => (Number(v) === 0 ? 'None' : `Group ${Number(v)}`);

/** What a pad plays: its sample's name, or the built-in sound. */
function padSound(ui: Props, n: number): { sample: string | null; builtin: string } {
  return {
    sample: ui.samples?.name(padSlot(n)) ?? null,
    builtin: SOUND_LABELS[ui.values[padParam(n).sound] as SoundId] ?? '',
  };
}

function Pad({ ui, n, selected, onSelect }: { ui: Props; n: number; selected: boolean; onSelect(n: number): void }) {
  const [over, setOver] = useState(false);
  const [lit, setLit] = useState(false);
  const release = useRef<(() => void) | null>(null);
  const key = keyOf(n);
  const { sample, builtin } = padSound(ui, n);
  const where = `Pad ${n} (${noteName(key)}, key ${key})`;
  const hint = sample
    ? `${where}: ${sample}. Click to play it (higher up is louder) and edit it below; drop another sample here to replace it`
    : `${where}: built-in ${builtin}. Click to play it and edit it below; drop a sample here to replace it`;
  const stop = () => {
    release.current?.();
    release.current = null;
    setLit(false);
  };
  const down = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    onSelect(n);
    if (!ui.playNote) return;
    stop();
    const r = e.currentTarget.getBoundingClientRect();
    const velocity = Math.max(0.2, Math.min(1, 1 - (e.clientY - r.top) / Math.max(1, r.height)) * 0.8 + 0.2);
    release.current = ui.playNote(key, velocity);
    setLit(true);
  };
  return (
    <button
      type="button"
      tabIndex={-1}
      className={`${styles.pad} ${selected ? styles.selected : ''} ${over ? styles.over : ''} ${lit ? styles.lit : ''}`}
      data-hint={hint}
      onPointerDown={down}
      onPointerUp={stop}
      onPointerLeave={stop}
      onDragOver={(e) => {
        if (!ui.samples?.canDrop(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!over) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (ui.samples?.drop(padSlot(n), e.dataTransfer)) {
          e.preventDefault();
          onSelect(n);
        }
      }}
    >
      <span className={styles.padTop}>
        <span className={styles.padNumber}>{n}</span>
        <span className={styles.padNote}>{noteName(key)}</span>
      </span>
      <span className={sample ? styles.padSample : styles.padBuiltin}>{sample ?? builtin}</span>
    </button>
  );
}

/** The selected pad's sample and settings. */
function PadEditor({ ui, n }: { ui: Props; n: number }) {
  const id = padParam(n);
  const slot = padSlot(n);
  const { sample, builtin } = padSound(ui, n);
  const samples = ui.samples;
  return (
    <Section title={`Pad ${n} · ${noteName(keyOf(n))} (key ${keyOf(n)})`} wide>
      <div className={styles.sampleRow}>
        <div
          className={styles.sampleName}
          data-hint={
            sample
              ? `Pad ${n} plays the sample “${sample}”`
              : `Pad ${n} has no sample: it plays the built-in ${builtin}`
          }
        >
          {sample ? (
            <>
              <span className={styles.dim}>Sample</span> {sample}
            </>
          ) : (
            <span className={styles.dim}>
              No sample: playing the built-in {builtin}. Drop a sample on the pad, or choose one here.
            </span>
          )}
        </div>
        {samples && (
          <div className={styles.sampleButtons}>
            <button
              type="button"
              tabIndex={-1}
              className={styles.button}
              onClick={() => samples.choose(slot)}
              data-hint={`Choose an audio file (WAV, AIFF, FLAC, MP3, OGG) for pad ${n}`}
            >
              Choose file…
            </button>
            <select
              className={styles.kitSelect}
              value=""
              onChange={(e) => e.target.value && samples.loadKit(slot, e.target.value)}
              data-hint={`Put one of the app’s kit sounds on pad ${n}`}
              aria-label="Kit sound"
            >
              <option value="" disabled>
                Kit sound…
              </option>
              {samples.kit.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
            {sample && (
              <button
                type="button"
                tabIndex={-1}
                className={styles.button}
                onClick={() => samples.clear(slot)}
                data-hint={`Remove the sample: pad ${n} plays its built-in sound again`}
              >
                Remove sample
              </button>
            )}
          </div>
        )}
      </div>
      <div className={styles.controls}>
        <ParamSelect ui={ui} param={id.sound} label="Built-in sound" />
        <ParamKnob ui={ui} param={id.tune} label="Tune" />
        <ParamKnob ui={ui} param={id.level} label="Level" />
        <ParamKnob ui={ui} param={id.pan} label="Pan" format={formatPan} />
        <ParamKnob ui={ui} param={id.decay} label="Decay" format={decayText} />
        <ParamKnob ui={ui} param={id.choke} label="Choke group" format={chokeText} />
        <div className={styles.toggle}>
          <ParamToggle ui={ui} param={id.reverse} label="Reverse" />
        </div>
      </div>
    </Section>
  );
}

/** Drum Pads: a 4×4 grid of pads that play when clicked and take dropped samples, and the selected pad's settings. */
export function DrumPadsUI(ui: Props) {
  const [selected, setSelected] = useState(1);
  return (
    <div className={styles.root}>
      <div className={styles.top}>
        <div className={styles.grid} data-hint="The pads: click one to play and edit it, drop samples on them">
          {ROWS.map((row) =>
            row.map((n) => <Pad key={n} ui={ui} n={n} selected={n === selected} onSelect={setSelected} />),
          )}
        </div>
        <Section title="Kit" hint="Settings for every pad">
          <div className={styles.kitKnobs}>
            <ParamKnob ui={ui} param="velocity" />
            <ParamKnob ui={ui} param="level" />
          </div>
        </Section>
      </div>
      <PadEditor ui={ui} n={selected} />
    </div>
  );
}
