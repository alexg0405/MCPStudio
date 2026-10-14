import { useMemo } from 'react';
import { formatValue, type EnumSpec, type ParamSpec, type PluginUIProps } from '@agstudio/sdk';
import { formatPan, Knob, ParamKnob, ParamSelect, ParamToggle, Section, Select } from '@agstudio/sdk/ui';
import { lfoParam, MOD_SLOTS, modParam, oscParam, TABLE_OPTIONS, type wavetableParams } from './params';
import { factoryBank, TABLES } from './tables';
import styles from './ui.module.css';

type Props = PluginUIProps<typeof wavetableParams>;

const SHAPE_W = 96;
const SHAPE_H = 40;
const POINTS = 96;

/** One cycle of the oscillator's current shape. */
function ShapePreview({ table, position, off }: { table: number; position: number; off: boolean }) {
  const path = useMemo(() => {
    const pts = new Float32Array(POINTS);
    factoryBank().shape(table, position, pts, 3);
    let d = '';
    for (let i = 0; i < POINTS; i++) {
      const x = (i / (POINTS - 1)) * SHAPE_W;
      const y = SHAPE_H / 2 - (pts[i] as number) * (SHAPE_H / 2 - 3);
      d += `${i ? ' L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    return d;
  }, [table, position]);
  const t = TABLES[table];
  return (
    <svg
      className={`${styles.shape} ${off ? styles.off : ''}`}
      width={SHAPE_W}
      height={SHAPE_H}
      data-hint={`${t?.label ?? 'Table'} at ${Math.round(position * 100)}%: ${t?.hint ?? ''}`}
      role="img"
      aria-label={`Shape preview: ${t?.label ?? ''}`}
    >
      <line x1={0} y1={SHAPE_H / 2} x2={SHAPE_W} y2={SHAPE_H / 2} className={styles.axis} />
      <path d={path} className={styles.wave} />
    </svg>
  );
}

/** A small drawing of an ADSR envelope (times on a log scale). */
function EnvelopeCurve({ a, d, s, r }: { a: number; d: number; s: number; r: number }) {
  const w = (t: number) => 4 + 30 * Math.max(0, Math.min(1, Math.log(t / 0.001) / Math.log(10 / 0.001)));
  const H = 34;
  const x1 = w(a);
  const x2 = x1 + w(d);
  const x3 = x2 + 18;
  const x4 = x3 + w(r);
  const ys = 2 + (1 - s) * (H - 4);
  const path = `M 0 ${H - 2} L ${x1} 2 L ${x2} ${ys} L ${x3} ${ys} L ${x4} ${H - 2}`;
  return (
    <svg className={styles.envelope} width={x4 + 2} height={H} aria-hidden>
      <path d={path} className={styles.wave} />
    </svg>
  );
}

function Oscillator({ ui, n }: { ui: Props; n: number }) {
  const id = oscParam(n);
  const table = TABLE_OPTIONS.findIndex(([t]) => t === ui.values[id.table]);
  const off = Number(ui.values[id.level]) === 0;
  return (
    <Section
      title={`Oscillator ${n}${off ? ' (off: turn up its level)' : ''}`}
      hint={`Oscillator ${n}: pick a table, then move the position to morph through its shapes`}
    >
      <div className={styles.oscTop}>
        <ParamSelect ui={ui} param={id.table} label="Table" />
        <ShapePreview table={Math.max(0, table)} position={Number(ui.values[id.position])} off={off} />
      </div>
      <ParamKnob ui={ui} param={id.position} label="Position" />
      <ParamKnob ui={ui} param={id.coarse} label="Coarse" />
      <ParamKnob ui={ui} param={id.fine} label="Fine" />
      <ParamKnob ui={ui} param={id.level} label="Level" />
      <ParamKnob ui={ui} param={id.pan} label="Pan" format={formatPan} />
    </Section>
  );
}

function Lfo({ ui, n }: { ui: Props; n: number }) {
  const id = lfoParam(n);
  const synced = Boolean(ui.values[id.sync]);
  return (
    <Section title={`LFO ${n}`} hint={`LFO ${n}: a slow wobble; send it somewhere in the mod matrix`}>
      <ParamSelect ui={ui} param={id.shape} label="Shape" />
      {synced ? (
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

function ModRow({ ui, n }: { ui: Props; n: number }) {
  const id = modParam(n);
  const spec = (k: string) => ui.specs[k] as ParamSpec;
  const source = formatValue(spec(id.source), ui.values[id.source] as string);
  const target = formatValue(spec(id.target), ui.values[id.target] as string);
  const amountSpec = spec(id.amount);
  const amountValue = Number(ui.values[id.amount]);
  const amount = formatValue(amountSpec, amountValue);
  const on = ui.values[id.source] !== 'none';
  return (
    <div
      className={`${styles.modRow} ${on ? '' : styles.modOff}`}
      data-hint={
        on ? `Mod ${n}: ${source} moves ${target} by ${amount}` : `Mod ${n} is off: pick a source to move ${target}`
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
  const v = ui.values;
  return (
    <div className={styles.root}>
      <h2 className={styles.heading}>Oscillators</h2>
      <div className={styles.row}>
        <Oscillator ui={ui} n={1} />
        <Oscillator ui={ui} n={2} />
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
            a={Number(v.ampAttack)}
            d={Number(v.ampDecay)}
            s={Number(v.ampSustain)}
            r={Number(v.ampRelease)}
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
            a={Number(v.modAttack)}
            d={Number(v.modDecay)}
            s={Number(v.modSustain)}
            r={Number(v.modRelease)}
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
