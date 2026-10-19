import { useMemo } from 'react';
import { formatValue, type EnumSpec, type ParamSpec, type PluginUIProps } from '@agstudio/sdk';
import {
  frameAt,
  framesOfState,
  frameToWave,
  normalizeFrame,
  type Frame,
  type UserTableState,
} from '@agstudio/sdk/dsp/wavetable-frames';
import { formatPan, Knob, ParamKnob, ParamSelect, ParamToggle, Section, Select } from '@agstudio/sdk/ui';
import { FACTORY_TABLES, lfoParam, MOD_SLOTS, modParam, oscParam, TABLE_OPTIONS, type wavetableParams } from './params';
import { TableEditor } from './table-editor';
import { factoryBank, TABLES } from './tables';
import styles from './ui.module.css';

type Props = PluginUIProps<typeof wavetableParams, UserTableState>;

const SHAPE_WIDTH = 96;
const SHAPE_HEIGHT = 40;
/** Space kept above and below the preview's wave, in pixels. */
const SHAPE_MARGIN = 3;
/** Points of the shape preview: a power of two, because a drawn table's cycle goes through an FFT. */
const POINTS = 128;

/** One cycle of the oscillator's current shape (a factory table's, or "My table" from its key frames). */
function ShapePreview({
  table,
  position,
  isOff,
  user,
}: {
  table: number;
  position: number;
  isOff: boolean;
  user: readonly Frame[];
}) {
  const isUser = table >= FACTORY_TABLES;
  const path = useMemo(() => {
    const wave = new Float32Array(POINTS);
    if (isUser) {
      const shown = normalizeFrame(frameAt(user, position));
      frameToWave(shown, wave);
    } else factoryBank().shape(table, position, wave, 3);
    let pathData = '';
    for (let i = 0; i < POINTS; i++) {
      const x = (i / (POINTS - 1)) * SHAPE_WIDTH;
      const y = SHAPE_HEIGHT / 2 - (wave[i] as number) * (SHAPE_HEIGHT / 2 - SHAPE_MARGIN);
      pathData += `${i ? ' L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    return pathData;
  }, [table, position, isUser, user]);
  const factoryTable = isUser ? null : TABLES[table];
  return (
    <svg
      className={`${styles.shape} ${isOff ? styles.off : ''}`}
      width={SHAPE_WIDTH}
      height={SHAPE_HEIGHT}
      data-hint={`${factoryTable?.label ?? 'My table'} at ${Math.round(position * 100)}%: ${factoryTable?.hint ?? 'the table you draw or import below'}`}
      role="img"
      aria-label={`Shape preview: ${factoryTable?.label ?? 'My table'}`}
    >
      <line x1={0} y1={SHAPE_HEIGHT / 2} x2={SHAPE_WIDTH} y2={SHAPE_HEIGHT / 2} className={styles.axis} />
      <path d={path} className={styles.wave} />
    </svg>
  );
}

const ENVELOPE_HEIGHT = 34;
/** The fastest and slowest envelope times (seconds) the drawing spans, on a log scale. */
const ENVELOPE_MIN_SEC = 0.001;
const ENVELOPE_MAX_SEC = 10;
/** Pixels of width a stage gets: a base, plus up to this much more for the slowest times. */
const STAGE_BASE_WIDTH = 4;
const STAGE_TIME_WIDTH = 30;
/** Width of the held (sustain) stretch, in pixels. */
const SUSTAIN_WIDTH = 18;

/** A small drawing of an ADSR envelope: stage times in seconds (on a log scale), sustain as a level from 0 to 1. */
function EnvelopeCurve({
  attack,
  decay,
  sustain,
  release,
}: {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}) {
  const stageWidth = (seconds: number) => {
    const share = Math.log(seconds / ENVELOPE_MIN_SEC) / Math.log(ENVELOPE_MAX_SEC / ENVELOPE_MIN_SEC);
    return STAGE_BASE_WIDTH + STAGE_TIME_WIDTH * Math.max(0, Math.min(1, share));
  };
  const height = ENVELOPE_HEIGHT;
  const attackEnd = stageWidth(attack);
  const decayEnd = attackEnd + stageWidth(decay);
  const sustainEnd = decayEnd + SUSTAIN_WIDTH;
  const releaseEnd = sustainEnd + stageWidth(release);
  const sustainY = 2 + (1 - sustain) * (height - 4);
  const path = `M 0 ${height - 2} L ${attackEnd} 2 L ${decayEnd} ${sustainY} L ${sustainEnd} ${sustainY} L ${releaseEnd} ${height - 2}`;
  return (
    <svg className={styles.envelope} width={releaseEnd + 2} height={height} aria-hidden>
      <path d={path} className={styles.wave} />
    </svg>
  );
}

/** One oscillator's section: table, position, tuning, level and pan. */
function Oscillator({ ui, n, user }: { ui: Props; n: number; user: readonly Frame[] }) {
  const id = oscParam(n);
  const table = TABLE_OPTIONS.findIndex(([t]) => t === ui.values[id.table]);
  const isOff = Number(ui.values[id.level]) === 0;
  return (
    <Section
      title={`Oscillator ${n}${isOff ? ' (off: turn up its level)' : ''}`}
      hint={`Oscillator ${n}: pick a table, then move the position to morph through its shapes`}
    >
      <div className={styles.oscTop}>
        <ParamSelect ui={ui} param={id.table} label="Table" />
        <ShapePreview table={Math.max(0, table)} position={Number(ui.values[id.position])} isOff={isOff} user={user} />
      </div>
      <ParamKnob ui={ui} param={id.position} label="Position" />
      <ParamKnob ui={ui} param={id.coarse} label="Coarse" />
      <ParamKnob ui={ui} param={id.fine} label="Fine" />
      <ParamKnob ui={ui} param={id.level} label="Level" />
      <ParamKnob ui={ui} param={id.pan} label="Pan" format={formatPan} />
    </Section>
  );
}

/** One LFO's section. */
function Lfo({ ui, n }: { ui: Props; n: number }) {
  const id = lfoParam(n);
  const isSynced = Boolean(ui.values[id.sync]);
  return (
    <Section title={`LFO ${n}`} hint={`LFO ${n}: a slow wobble; send it somewhere in the mod matrix`}>
      <ParamSelect ui={ui} param={id.shape} label="Shape" />
      {isSynced ? (
        <ParamSelect ui={ui} param={id.length} label="Length" />
      ) : (
        <ParamKnob ui={ui} param={id.rate} label="Speed" />
      )}
      <div className={styles.toggles}>
        <ParamToggle ui={ui} param={id.sync} label="Sync to tempo" />
        <ParamToggle ui={ui} param={id.retrigger} label="Restart each note" />
      </div>
    </Section>
  );
}

/** One row of the mod matrix: source, destination and amount. */
function ModRow({ ui, n }: { ui: Props; n: number }) {
  const id = modParam(n);
  const spec = (k: string) => ui.specs[k] as ParamSpec;
  const source = formatValue(spec(id.source), ui.values[id.source] as string);
  const target = formatValue(spec(id.target), ui.values[id.target] as string);
  const amountSpec = spec(id.amount);
  const amountValue = Number(ui.values[id.amount]);
  const amount = formatValue(amountSpec, amountValue);
  const isOn = ui.values[id.source] !== 'none';
  return (
    <div
      className={`${styles.modRow} ${isOn ? '' : styles.modOff}`}
      data-hint={
        isOn ? `Mod ${n}: ${source} moves ${target} by ${amount}` : `Mod ${n} is off: pick a source to move ${target}`
      }
    >
      <span className={styles.modIndex}>{n}</span>
      <Select
        spec={spec(id.source) as EnumSpec}
        value={String(ui.values[id.source])}
        label={`Mod ${n} source`}
        param={id.source}
        hint="What moves the destination"
        onCommit={(value) => ui.setParam(id.source, value)}
      />
      <span className={styles.modArrow}>→</span>
      <Select
        spec={spec(id.target) as EnumSpec}
        value={String(ui.values[id.target])}
        label={`Mod ${n} destination`}
        param={id.target}
        hint="What gets moved"
        onCommit={(value) => ui.setParam(id.target, value)}
      />
      <Knob
        spec={amountSpec}
        value={amountValue}
        label={`Mod ${n} amount`}
        size={22}
        bipolar
        param={id.amount}
        hint="How much, and which way (negative turns it around)"
        onBegin={() => ui.beginEdit(id.amount)}
        onChange={(value) => ui.setParam(id.amount, value)}
        onEnd={() => ui.endEdit(id.amount)}
        onCommit={(value) => ui.setParam(id.amount, value)}
      />
      <span className={styles.modAmount}>{amount}</span>
    </div>
  );
}

/** The Wavetable editor: oscillators, filter, envelopes, LFOs, the mod matrix and the voice settings. */
export function WavetableUI(ui: Props) {
  const values = ui.values;
  const userFrames = useMemo(() => framesOfState(ui.state), [ui.state]);
  return (
    <div className={styles.root}>
      <h2 className={styles.heading}>Oscillators</h2>
      <div className={styles.row}>
        <Oscillator ui={ui} n={1} user={userFrames} />
        <Oscillator ui={ui} n={2} user={userFrames} />
        <Section title="Unison" hint="Stacks detuned copies of both oscillators for a wide, thick sound">
          <ParamKnob ui={ui} param="unison" label="Voices" />
          <ParamKnob ui={ui} param="detune" label="Detune" />
          <ParamKnob ui={ui} param="spread" label="Spread" />
        </Section>
        <Section title="Sub & noise" hint="A sub oscillator below the note, and noise">
          <ParamKnob ui={ui} param="subLevel" label="Sub" />
          <ParamSelect ui={ui} param="subShape" label="Shape" />
          <ParamSelect ui={ui} param="subOctave" label="Octave" />
          <ParamKnob ui={ui} param="noiseLevel" label="Noise" />
          <ParamKnob ui={ui} param="noiseTone" label="Tone" />
        </Section>
      </div>

      <h2 className={styles.heading}>Your own table</h2>
      <div className={styles.row}>
        <TableEditor ui={ui} />
      </div>

      <h2 className={styles.heading}>Filter</h2>
      <div className={styles.row}>
        <Section
          title="Filter"
          hint="Shapes the tone: low-pass darkens, high-pass thins, band-pass and notch focus"
          wide
        >
          <ParamSelect ui={ui} param="filterType" label="Type" />
          <ParamKnob ui={ui} param="cutoff" />
          <ParamKnob ui={ui} param="resonance" />
          <ParamKnob ui={ui} param="drive" />
          <ParamKnob ui={ui} param="keyTrack" label="Key track" />
          <ParamKnob ui={ui} param="envAmount" label="Env amount" />
        </Section>
      </div>

      <h2 className={styles.heading}>Envelopes</h2>
      <div className={styles.row}>
        <Section title="Amp envelope" hint="How each note's volume starts, holds and ends">
          <EnvelopeCurve
            attack={Number(values.ampAttack)}
            decay={Number(values.ampDecay)}
            sustain={Number(values.ampSustain)}
            release={Number(values.ampRelease)}
          />
          <ParamKnob ui={ui} param="ampAttack" label="Attack" />
          <ParamKnob ui={ui} param="ampDecay" label="Decay" />
          <ParamKnob ui={ui} param="ampSustain" label="Sustain" />
          <ParamKnob ui={ui} param="ampRelease" label="Release" />
          <ParamKnob ui={ui} param="velocity" />
        </Section>
        <Section
          title="Mod envelope"
          hint="A second envelope: moves the filter (Env amount) or anything in the mod matrix"
        >
          <EnvelopeCurve
            attack={Number(values.modAttack)}
            decay={Number(values.modDecay)}
            sustain={Number(values.modSustain)}
            release={Number(values.modRelease)}
          />
          <ParamKnob ui={ui} param="modAttack" label="Attack" />
          <ParamKnob ui={ui} param="modDecay" label="Decay" />
          <ParamKnob ui={ui} param="modSustain" label="Sustain" />
          <ParamKnob ui={ui} param="modRelease" label="Release" />
        </Section>
      </div>

      <h2 className={styles.heading}>LFOs</h2>
      <div className={styles.row}>
        <Lfo ui={ui} n={1} />
        <Lfo ui={ui} n={2} />
      </div>

      <h2 className={styles.heading}>Mod matrix</h2>
      <Section
        title="Routes: source → destination"
        hint="Each row moves a destination with a source: pick both, then set how much (negative turns it around)"
        wide
      >
        <div className={styles.matrix}>
          <div className={styles.modHeader} aria-hidden>
            <span className={styles.modIndex} />
            <span>Source</span>
            <span className={styles.modArrow}>→</span>
            <span>Destination</span>
            <span>Amount</span>
          </div>
          {Array.from({ length: MOD_SLOTS }, (_, i) => (
            <ModRow key={i} ui={ui} n={i + 1} />
          ))}
        </div>
      </Section>

      <h2 className={styles.heading}>Voice</h2>
      <div className={styles.row}>
        <Section title="Voice" hint="Chords or one note at a time, sliding pitch, and the volume" wide>
          <ParamSelect ui={ui} param="voiceMode" label="Mode" />
          <ParamKnob ui={ui} param="glide" />
          <ParamKnob ui={ui} param="level" />
        </Section>
      </div>
    </div>
  );
}
