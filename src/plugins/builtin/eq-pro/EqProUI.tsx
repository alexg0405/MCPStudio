import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { formatValue, type ParamValue } from '@agstudio/sdk';
import { Knob, Select, Toggle } from '@agstudio/sdk/ui';
import { hasGain } from './design.kernel';
import { describeBand, readBands, type BandView, type EqProProps } from './eq-bands';
import {
  BAND_COLORS,
  clamp,
  GRID_DB,
  GRID_FREQS,
  MAX_FREQ_HZ,
  MIN_FREQ_HZ,
  positionOfFrequency,
  yOfDb,
} from './eq-graph';
import { bandIds } from './params';
import { useBandDrag, type ParamEditing } from './use-band-drag';
import { useCurvePaths, useGraphSize, useScrollForQ, useSpectrumCanvas, type GraphSize } from './use-eq-graph';
import styles from './eq-pro.module.css';

type Spec = Parameters<typeof formatValue>[0];

/** The EQ Pro editor: the curve graph with a handle per band, the band picker, and the selected band's controls. */
export function EqProUI({ specs, values, beginEdit, setParam: setTyped, endEdit, openParamMenu, tap }: EqProProps) {
  // Band params are addressed by id strings (b3Freq…).
  const paramValues = values as unknown as Record<string, ParamValue>;
  const editing: ParamEditing = {
    begin: beginEdit as (param: string) => void,
    end: endEdit as (param: string) => void,
    set: setTyped as (param: string, value: ParamValue) => void,
  };
  const [selected, setSelected] = useState(3);
  const graph = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const size = useGraphSize(graph);
  const sampleRate = tap?.sampleRate || 48000;
  const outputDb = Number(paramValues.output);

  const bands = useMemo<BandView[]>(() => readBands(paramValues), [paramValues]);
  const { curve, area, fill } = useCurvePaths(bands, selected, size, sampleRate, outputDb);
  const canvas = useSpectrumCanvas(tap, size);
  useScrollForQ(svg, bands, editing.set, setSelected);
  const drag = useBandDrag(graph, size, bands, specs, editing, setSelected);

  const selectedBand = bands[selected - 1] ?? (bands[0] as BandView);
  return (
    <div className={styles.root}>
      <div
        ref={graph}
        className={styles.graph}
        onDoubleClick={drag.onGraphDoubleClick}
        data-hint="EQ curve: drag a numbered handle to move a band (sideways = frequency, up/down = gain), scroll on it for Q, double-click it to switch it on or off; double-click empty space to add a band there"
      >
        <canvas ref={canvas} style={{ width: '100%', height: '100%' }} />
        <svg ref={svg} width={size.width} height={size.height}>
          <GraphGrid size={size} />
          <path className={styles.curveFill} d={area} />
          {fill && <path className={styles.bandFill} d={fill} style={{ fill: BAND_COLORS[selectedBand.number - 1] }} />}
          <path className={styles.curve} d={curve} />
          {bands.map((band) => (
            <BandHandle
              key={band.number}
              band={band}
              isSelected={band.number === selected}
              size={size}
              specs={specs}
              editing={editing}
              drag={drag}
              onSelect={setSelected}
              openParamMenu={openParamMenu as ParamMenuOpener | undefined}
            />
          ))}
        </svg>
        <div className={styles.readout}>{describeBand(selectedBand, specs)}</div>
      </div>
      <BandStrip
        bands={bands}
        selected={selectedBand}
        specs={specs}
        paramValues={paramValues}
        editing={editing}
        onSelect={setSelected}
      />
    </div>
  );
}

type ParamMenuOpener = (param: string, at: { clientX: number; clientY: number }) => void;

/** The frequency and gain grid with its labels. */
function GraphGrid({ size }: { size: GraphSize }) {
  return (
    <>
      {GRID_FREQS.map((frequencyHz) => {
        const x = positionOfFrequency(frequencyHz) * size.width;
        return (
          <g key={frequencyHz}>
            <line className={styles.gridLine} x1={x} x2={x} y1={0} y2={size.height} />
            <text className={styles.gridLabel} x={x + 2} y={size.height - 3}>
              {frequencyHz >= 1000 ? `${frequencyHz / 1000}k` : frequencyHz}
            </text>
          </g>
        );
      })}
      {GRID_DB.map((db) => (
        <g key={db}>
          <line
            className={styles.gridLine}
            x1={0}
            x2={size.width}
            y1={yOfDb(db, size.height)}
            y2={yOfDb(db, size.height)}
          />
          <text className={styles.gridLabel} x={3} y={yOfDb(db, size.height) - 2}>
            {db > 0 ? `+${db}` : db}
          </text>
        </g>
      ))}
      <line className={styles.gridZero} x1={0} x2={size.width} y1={yOfDb(0, size.height)} y2={yOfDb(0, size.height)} />
    </>
  );
}

/** One band's numbered handle on the graph: drag, scroll for Q, double-click to switch it, right-click for the menu. */
function BandHandle({
  band,
  isSelected,
  size,
  specs,
  editing,
  drag,
  onSelect,
  openParamMenu,
}: {
  band: BandView;
  isSelected: boolean;
  size: GraphSize;
  specs: EqProProps['specs'];
  editing: ParamEditing;
  drag: ReturnType<typeof useBandDrag>;
  onSelect(band: number): void;
  openParamMenu: ParamMenuOpener | undefined;
}) {
  const x = positionOfFrequency(clamp(band.frequencyHz, MIN_FREQ_HZ, MAX_FREQ_HZ)) * size.width;
  const y = yOfDb(hasGain(band.type) ? band.gainDb : 0, size.height);
  const className = `${styles.handle} ${band.isOn ? '' : styles.handleOff} ${isSelected ? styles.handleSelected : ''}`;
  const ids = bandIds(band.number);
  const color = BAND_COLORS[band.number - 1];
  return (
    <g
      className={className}
      data-band={band.number}
      data-hint={`${describeBand(band, specs)} — drag to move, scroll for Q, double-click to switch ${band.isOn ? 'off' : 'on'}`}
      transform={`translate(${x.toFixed(1)},${y.toFixed(1)})`}
      onPointerDown={(e: ReactPointerEvent<SVGGElement>) => drag.onHandleDown(e, band)}
      onPointerMove={(e) => drag.onHandleMove(e, band)}
      onPointerUp={(e) => drag.onHandleUp(e, band)}
      onPointerCancel={(e) => drag.onHandleUp(e, band)}
      onLostPointerCapture={(e) => drag.onHandleUp(e, band)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        editing.set(ids.on, !band.isOn);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onSelect(band.number);
        openParamMenu?.(hasGain(band.type) ? ids.gain : ids.freq, e);
      }}
    >
      {isSelected && band.isOn && <circle className={styles.handleHalo} r={13} style={{ fill: color }} />}
      <circle className={styles.handleDot} r={8} style={band.isOn ? { fill: color } : undefined} />
      <text className={styles.handleNumber}>{band.number}</text>
    </g>
  );
}

/** Below the graph: the band picker, then the selected band's on switch, type, frequency, gain and Q, and the output. */
function BandStrip({
  bands,
  selected,
  specs,
  paramValues,
  editing,
  onSelect,
}: {
  bands: BandView[];
  selected: BandView;
  specs: EqProProps['specs'];
  paramValues: Record<string, ParamValue>;
  editing: ParamEditing;
  onSelect(band: number): void;
}) {
  const spec = specs as unknown as Record<string, Spec>;
  const ids = bandIds(selected.number);
  const knob = (id: string, label: string, isDisabled = false) => (
    <div className={styles.control} data-hint={`${spec[id]?.label}: ${spec[id]?.hint ?? ''}`}>
      <Knob
        spec={spec[id]!}
        value={paramValues[id]!}
        param={id}
        size={34}
        disabled={isDisabled}
        bipolar={(spec[id] as { min?: number }).min! < 0}
        onBegin={() => editing.begin(id)}
        onChange={(value) => editing.set(id, value)}
        onEnd={() => editing.end(id)}
        onCommit={(value) => editing.set(id, value)}
      />
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{formatValue(spec[id]!, paramValues[id]!)}</span>
    </div>
  );
  return (
    <div className={styles.strip}>
      <div className={styles.picker} role="tablist" aria-label="Bands">
        {bands.map((band) => {
          const isSelected = band.number === selected.number;
          return (
            <button
              key={band.number}
              type="button"
              role="tab"
              aria-selected={isSelected}
              tabIndex={-1}
              className={`${styles.tab} ${isSelected ? styles.tabSelected : ''} ${band.isOn ? '' : styles.tabOff}`}
              style={{ borderColor: isSelected ? BAND_COLORS[band.number - 1] : undefined }}
              onClick={() => onSelect(band.number)}
              data-hint={`${describeBand(band, specs)} — click to edit this band below`}
            >
              <i className={styles.swatch} style={{ background: BAND_COLORS[band.number - 1] }} />
              {band.number}
            </button>
          );
        })}
      </div>
      <div className={styles.control}>
        <Toggle
          spec={specs[ids.on as 'b1On']}
          value={Boolean(paramValues[ids.on])}
          label={`Band ${selected.number}`}
          param={ids.on}
          onCommit={(value) => editing.set(ids.on, value)}
        />
      </div>
      <div className={styles.control} data-hint={`${spec[ids.type]?.label}: ${spec[ids.type]?.hint ?? ''}`}>
        <Select
          spec={specs[ids.type as 'b1Type']}
          value={String(paramValues[ids.type])}
          label={`Band ${selected.number} type`}
          param={ids.type}
          onCommit={(value) => editing.set(ids.type, value)}
        />
        <span className={styles.label}>Type</span>
      </div>
      {knob(ids.freq, 'Frequency')}
      {knob(ids.gain, 'Gain', !hasGain(selected.type))}
      {knob(ids.q, 'Q')}
      <span className={styles.spacer} />
      {knob('output', 'Output')}
    </div>
  );
}
