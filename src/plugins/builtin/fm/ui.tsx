import { FM_ALGORITHMS, type ParamValue, type PluginUIProps } from '@agstudio/sdk';
import { ParamKnob, ParamSelect, Section } from '@agstudio/sdk/ui';
import { type fmParams, opParam } from './params';
import styles from './ui.module.css';

type Props = PluginUIProps<typeof fmParams>;

/** Where each operator (index 0 = op 1) sits in the diagram of each algorithm: [column, row]. */
const LAYOUT: readonly (readonly [number, number][])[] = [
  [
    [0, 3],
    [0, 2],
    [0, 1],
    [0, 0],
  ],
  [
    [0.5, 2],
    [0.5, 1],
    [0, 0],
    [1, 0],
  ],
  [
    [0.5, 2],
    [0, 1],
    [0, 0],
    [1, 1],
  ],
  [
    [0.5, 2],
    [1, 1],
    [0, 1],
    [0, 0],
  ],
  [
    [0, 1],
    [0, 0],
    [1, 1],
    [1, 0],
  ],
  [
    [0, 1],
    [1, 1],
    [2, 1],
    [1, 0],
  ],
  [
    [0, 1],
    [1, 1],
    [2, 1],
    [2, 0],
  ],
  [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
  ],
];

const BOX_W = 34;
const BOX_H = 22;
const COL = 46;
const ROW = 36;

const ratioText = (v: ParamValue) => (Number(v) === 0 ? '×½' : `×${Number(v)}`);
const fineText = (v: ParamValue) => `+${Math.round(Number(v) * 100)}%`;

/** The algorithm's routing: boxes for the operators, arrows for modulation, a line out of each one you hear. */
function Diagram({ ui, algorithm }: { ui: Props; algorithm: number }) {
  const alg = FM_ALGORITHMS[algorithm] ?? FM_ALGORITHMS[0]!;
  const layout = LAYOUT[algorithm] ?? LAYOUT[0]!;
  const rows = Math.max(...layout.map(([, r]) => r)) + 1;
  const cols = Math.max(...layout.map(([c]) => c)) + 1;
  const width = cols * COL + 30;
  const height = rows * ROW + 18;
  const centre = (o: number) => {
    const [c, r] = layout[o]!;
    return { x: 6 + c * COL + BOX_W / 2, y: 4 + r * ROW + BOX_H / 2 };
  };
  const feedback = Number(ui.values.feedback) > 0;
  const heard = alg.carriers.map((c) => c + 1).join(', ');
  const mods = alg.modulators.flatMap((sources, t) => sources.map((s) => `${s + 1} modulates ${t + 1}`)).join(', ');
  const hint =
    `Algorithm ${algorithm + 1} (${alg.label}): you hear operator${alg.carriers.length > 1 ? 's' : ''} ${heard} (orange)` +
    (mods ? `; ${mods}` : '; nothing modulates') +
    '. Modulators make the operators they feed brighter. Operator 4 can feed back into itself.';
  return (
    <svg className={styles.diagram} width={width} height={height} data-hint={hint} role="img" aria-label={hint}>
      <defs>
        <marker id="fm-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L6,3 L0,6 z" className={styles.arrowHead} />
        </marker>
      </defs>
      {alg.modulators.map((sources, t) =>
        sources.map((s) => {
          const a = centre(s);
          const b = centre(t);
          return (
            <line
              key={`${s}-${t}`}
              x1={a.x}
              y1={a.y + BOX_H / 2}
              x2={b.x}
              y2={b.y - BOX_H / 2 - 1}
              className={styles.arrow}
              markerEnd="url(#fm-arrow)"
            />
          );
        }),
      )}
      {alg.carriers.map((c) => {
        const a = centre(c);
        return <line key={`out-${c}`} x1={a.x} y1={a.y + BOX_H / 2} x2={a.x} y2={height - 2} className={styles.out} />;
      })}
      {feedback && (
        <path
          d={(() => {
            const a = centre(3);
            const x = a.x + BOX_W / 2;
            return `M ${x} ${a.y - 5} C ${x + 14} ${a.y - 12}, ${x + 14} ${a.y + 12}, ${x} ${a.y + 5}`;
          })()}
          className={styles.arrow}
          markerEnd="url(#fm-arrow)"
        />
      )}
      {[0, 1, 2, 3].map((o) => {
        const a = centre(o);
        const carrier = alg.carriers.includes(o);
        const silent = Number(ui.values[opParam(o + 1).level]) === 0;
        return (
          <g key={o} className={`${carrier ? styles.carrier : styles.modulator} ${silent ? styles.silent : ''}`}>
            <rect x={a.x - BOX_W / 2} y={a.y - BOX_H / 2} width={BOX_W} height={BOX_H} rx={3} />
            <text x={a.x} y={a.y + 4} textAnchor="middle">
              {o + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** What an operator does in the current algorithm, in words. */
function role(algorithm: number, o: number): string {
  const alg = FM_ALGORITHMS[algorithm] ?? FM_ALGORITHMS[0]!;
  if (alg.carriers.includes(o)) return 'heard';
  const targets = alg.modulators.flatMap((sources, t) => (sources.includes(o) ? [t + 1] : []));
  return `→ ${targets.join(', ')}`;
}

function OperatorRow({ ui, n, algorithm }: { ui: Props; n: number; algorithm: number }) {
  const id = opParam(n);
  const ratio = Number(ui.values[id.ratio]);
  const multiple = (ratio === 0 ? 0.5 : ratio) * (1 + Number(ui.values[id.fine]));
  const what = role(algorithm, n - 1);
  const heard = what === 'heard';
  return (
    <div
      className={styles.row}
      data-hint={
        heard
          ? `Operator ${n} is heard: its level is its loudness`
          : `Operator ${n} modulates operator ${what.slice(2)}: its level sets how bright that one sounds`
      }
    >
      <div className={`${styles.opLabel} ${heard ? styles.opHeard : ''}`}>
        <span className={styles.opName}>Op {n}</span>
        <span className={styles.opRole}>{heard ? 'heard' : `modulates ${what.slice(2)}`}</span>
        <span className={styles.opRatio}>×{multiple.toFixed(multiple % 1 ? 2 : 0)}</span>
      </div>
      <div className={styles.knobs}>
        <ParamKnob ui={ui} param={id.ratio} label="Ratio" size={26} format={ratioText} />
        <ParamKnob ui={ui} param={id.fine} label="Fine" size={26} format={fineText} />
        <ParamKnob ui={ui} param={id.level} label="Level" size={26} />
        <ParamKnob ui={ui} param={id.attack} label="Attack" size={26} />
        <ParamKnob ui={ui} param={id.decay} label="Decay" size={26} />
        <ParamKnob ui={ui} param={id.sustain} label="Sustain" size={26} />
        <ParamKnob ui={ui} param={id.release} label="Release" size={26} />
        <ParamKnob ui={ui} param={id.velocity} label="Velocity" size={26} />
      </div>
    </div>
  );
}

/** The FM editor: the algorithm (with a diagram), the four operators, and the output. */
export function FmUI(ui: Props) {
  const algorithm = Math.max(0, Number(ui.values.algorithm) - 1);
  return (
    <div className={styles.root}>
      <div className={styles.top}>
        <Section
          title="Algorithm"
          hint="How the operators connect: arrows mean “modulates”; orange operators are the ones you hear"
        >
          <div className={styles.algorithmControls}>
            <ParamSelect ui={ui} param="algorithm" label="Algorithm (arrows: modulates)" />
            <div className={styles.algorithm}>
              <Diagram ui={ui} algorithm={algorithm} />
              <ParamKnob ui={ui} param="feedback" size={28} />
            </div>
          </div>
        </Section>
        <Section title="Output" hint="Tone filter, vibrato, the mod wheel and the volume">
          <div className={styles.output}>
            <ParamKnob ui={ui} param="cutoff" size={26} />
            <ParamKnob ui={ui} param="resonance" size={26} />
            <ParamKnob ui={ui} param="level" size={26} />
            <ParamKnob ui={ui} param="vibratoDepth" size={26} />
            <ParamKnob ui={ui} param="vibratoRate" size={26} />
            <ParamSelect ui={ui} param="wheel" />
          </div>
        </Section>
      </div>
      {[1, 2, 3, 4].map((n) => (
        <OperatorRow key={n} ui={ui} n={n} algorithm={algorithm} />
      ))}
    </div>
  );
}
