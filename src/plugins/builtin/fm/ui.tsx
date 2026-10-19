import { FM_ALGORITHMS, type ParamValue, type PluginUIProps } from '@agstudio/sdk';
import { ParamKnob, ParamSelect, Section } from '@agstudio/sdk/ui';
import { type fmParams, opParam } from './params';
import styles from './ui.module.css';

type Props = PluginUIProps<typeof fmParams>;

/** Where each operator (index 0 = op 1) sits in the diagram of each algorithm: [column, row]. */
const OPERATOR_LAYOUT: readonly (readonly [number, number][])[] = [
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

/** Size of an operator's box in the diagram, and the space one column and one row take, in pixels. */
const BOX_WIDTH = 34;
const BOX_HEIGHT = 22;
const COLUMN_WIDTH = 46;
const ROW_HEIGHT = 36;

const ratioText = (value: ParamValue) => (Number(value) === 0 ? '×½' : `×${Number(value)}`);
const fineText = (value: ParamValue) => `+${Math.round(Number(value) * 100)}%`;

type Algorithm = (typeof FM_ALGORITHMS)[number];
type Point = { x: number; y: number };

/** The sentence a hover on the diagram shows: which operators you hear and which modulates which. */
function describeAlgorithm(algorithm: Algorithm, algorithmIndex: number): string {
  const heard = algorithm.carriers.map((carrier) => carrier + 1).join(', ');
  const modulations = algorithm.modulators
    .flatMap((sources, target) => sources.map((source) => `${source + 1} modulates ${target + 1}`))
    .join(', ');
  return (
    `Algorithm ${algorithmIndex + 1} (${algorithm.label}): you hear operator${algorithm.carriers.length > 1 ? 's' : ''} ${heard} (orange)` +
    (modulations ? `; ${modulations}` : '; nothing modulates') +
    '. Modulators make the operators they feed brighter. Operator 4 can feed back into itself.'
  );
}

/** The curl that shows operator 4 feeding back into itself, on the right side of its box. */
function feedbackPath(operator4: Point): string {
  const x = operator4.x + BOX_WIDTH / 2;
  return `M ${x} ${operator4.y - 5} C ${x + 14} ${operator4.y - 12}, ${x + 14} ${operator4.y + 12}, ${x} ${operator4.y + 5}`;
}

/** The algorithm's routing: boxes for the operators, arrows for modulation, a line out of each one you hear. */
function Diagram({ ui, algorithmIndex }: { ui: Props; algorithmIndex: number }) {
  const algorithm = FM_ALGORITHMS[algorithmIndex] ?? FM_ALGORITHMS[0]!;
  const layout = OPERATOR_LAYOUT[algorithmIndex] ?? OPERATOR_LAYOUT[0]!;
  const rows = Math.max(...layout.map(([, row]) => row)) + 1;
  const columns = Math.max(...layout.map(([column]) => column)) + 1;
  const width = columns * COLUMN_WIDTH + 30;
  const height = rows * ROW_HEIGHT + 18;
  /** Where the middle of an operator's box is. */
  const centreOf = (operator: number): Point => {
    const [column, row] = layout[operator]!;
    return { x: 6 + column * COLUMN_WIDTH + BOX_WIDTH / 2, y: 4 + row * ROW_HEIGHT + BOX_HEIGHT / 2 };
  };
  const hasFeedback = Number(ui.values.feedback) > 0;
  const hint = describeAlgorithm(algorithm, algorithmIndex);
  return (
    <svg className={styles.diagram} width={width} height={height} data-hint={hint} role="img" aria-label={hint}>
      <defs>
        <marker id="fm-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L6,3 L0,6 z" className={styles.arrowHead} />
        </marker>
      </defs>
      {algorithm.modulators.map((sources, target) =>
        sources.map((source) => {
          const from = centreOf(source);
          const to = centreOf(target);
          return (
            <line
              key={`${source}-${target}`}
              x1={from.x}
              y1={from.y + BOX_HEIGHT / 2}
              x2={to.x}
              y2={to.y - BOX_HEIGHT / 2 - 1}
              className={styles.arrow}
              markerEnd="url(#fm-arrow)"
            />
          );
        }),
      )}
      {algorithm.carriers.map((carrier) => {
        const from = centreOf(carrier);
        return (
          <line
            key={`out-${carrier}`}
            x1={from.x}
            y1={from.y + BOX_HEIGHT / 2}
            x2={from.x}
            y2={height - 2}
            className={styles.out}
          />
        );
      })}
      {hasFeedback && <path d={feedbackPath(centreOf(3))} className={styles.arrow} markerEnd="url(#fm-arrow)" />}
      {[0, 1, 2, 3].map((operator) => {
        const centre = centreOf(operator);
        const isCarrier = algorithm.carriers.includes(operator);
        const isSilent = Number(ui.values[opParam(operator + 1).level]) === 0;
        return (
          <g
            key={operator}
            className={`${isCarrier ? styles.carrier : styles.modulator} ${isSilent ? styles.silent : ''}`}
          >
            <rect
              x={centre.x - BOX_WIDTH / 2}
              y={centre.y - BOX_HEIGHT / 2}
              width={BOX_WIDTH}
              height={BOX_HEIGHT}
              rx={3}
            />
            <text x={centre.x} y={centre.y + 4} textAnchor="middle">
              {operator + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** The numbers (1–4) of the operators that this operator modulates in the algorithm: none for one you hear. */
function modulatedOperators(algorithm: Algorithm, operator: number): number[] {
  if (algorithm.carriers.includes(operator)) return [];
  return algorithm.modulators.flatMap((sources, target) => (sources.includes(operator) ? [target + 1] : []));
}

/** One operator's row: its place in the algorithm, its ratio as a multiple of the note, and its knobs. */
function OperatorRow({
  ui,
  operatorNumber,
  algorithmIndex,
}: {
  ui: Props;
  operatorNumber: number;
  algorithmIndex: number;
}) {
  const paramIds = opParam(operatorNumber);
  const algorithm = FM_ALGORITHMS[algorithmIndex] ?? FM_ALGORITHMS[0]!;
  const ratio = Number(ui.values[paramIds.ratio]);
  const multiple = (ratio === 0 ? 0.5 : ratio) * (1 + Number(ui.values[paramIds.fine]));
  const isHeard = algorithm.carriers.includes(operatorNumber - 1);
  const modulated = modulatedOperators(algorithm, operatorNumber - 1).join(', ');
  return (
    <div
      className={styles.row}
      data-hint={
        isHeard
          ? `Operator ${operatorNumber} is heard: its level is its loudness`
          : `Operator ${operatorNumber} modulates operator ${modulated}: its level sets how bright that one sounds`
      }
    >
      <div className={`${styles.opLabel} ${isHeard ? styles.opHeard : ''}`}>
        <span className={styles.opName}>Op {operatorNumber}</span>
        <span className={styles.opRole}>{isHeard ? 'heard' : `modulates ${modulated}`}</span>
        <span className={styles.opRatio}>×{multiple.toFixed(multiple % 1 ? 2 : 0)}</span>
      </div>
      <div className={styles.knobs}>
        <ParamKnob ui={ui} param={paramIds.ratio} label="Ratio" size={26} format={ratioText} />
        <ParamKnob ui={ui} param={paramIds.fine} label="Fine" size={26} format={fineText} />
        <ParamKnob ui={ui} param={paramIds.level} label="Level" size={26} />
        <ParamKnob ui={ui} param={paramIds.attack} label="Attack" size={26} />
        <ParamKnob ui={ui} param={paramIds.decay} label="Decay" size={26} />
        <ParamKnob ui={ui} param={paramIds.sustain} label="Sustain" size={26} />
        <ParamKnob ui={ui} param={paramIds.release} label="Release" size={26} />
        <ParamKnob ui={ui} param={paramIds.velocity} label="Velocity" size={26} />
      </div>
    </div>
  );
}

/** The FM editor: the algorithm (with a diagram), the four operators, and the output. */
export function FmUI(ui: Props) {
  const algorithmIndex = Math.max(0, Number(ui.values.algorithm) - 1);
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
              <Diagram ui={ui} algorithmIndex={algorithmIndex} />
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
        <OperatorRow key={n} ui={ui} operatorNumber={n} algorithmIndex={algorithmIndex} />
      ))}
    </div>
  );
}
