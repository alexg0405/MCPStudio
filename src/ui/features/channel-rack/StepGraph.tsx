import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from 'zustand';
import { STEP_LANES, type StepLane } from '@app/stores/editor';
import type { Services } from '@app/services';
import type { Gesture } from '@core/history/history';
import type { ChannelId, PatternId } from '@core/model/types';
import { editNotes, type NoteEdit } from '@core/ops/notes';
import { stepView } from '@core/query/queries';
import { useDoc, useServices } from '../../services-context';
import { useThemeVersion } from '../../theme/use-theme';
import { stepAtX, stepsWidth } from './layout';
import { drawStepGraph, GRAPH_H } from './step-graph-draw';
import { formatStepValue, STEP_LANE_INFO, stepEdit, stepReset } from './steps';
import styles from './ChannelRack.module.css';

/** A value this close to the middle of a two-way graph (pan, fine pitch) snaps to exactly zero. */
const GRAPH_ZERO_SNAP = 0.04;
/** The empty margin above and below the bars, in px (the drag maps this span to the value range). */
const GRAPH_MARGIN = 3;

/** The channel's notes in this pattern, as the graph sees them (one per step or none). */
const stepNotesOf = (services: Services, patternId: PatternId, channelId: ChannelId, stepCount: number) =>
  stepView(services.doc.getState().project.patterns[patternId]?.notes[channelId], stepCount).notes;

/**
 * FL's graph editor: a row under a channel's steps showing one property per step as bars. Drag to
 * draw values (one undo step per drag), right-drag to reset them. Drawn imperatively from the
 * document so drags don't re-render React.
 */
export function StepGraph({ channelId, patternId, stepCount }: { channelId: ChannelId; patternId: PatternId; stepCount: number }) {
  const services = useServices();
  const lane = useStore(services.editor, (s) => s.stepGraph.lane);
  const rootKey = useDoc((p) => {
    const ch = p.channels[channelId];
    return ch?.kind === 'instrument' ? ch.rootKey : 60;
  });
  const isSteps = useDoc((p) => stepView(p.patterns[patternId]?.notes[channelId], stepCount).isSteps);
  const name = useDoc((p) => p.channels[channelId]?.name ?? '');
  const isInstrument = useDoc((p) => p.channels[channelId]?.kind === 'instrument');
  const canvas = useRef<HTMLCanvasElement>(null);
  const readout = useRef<HTMLSpanElement>(null);
  const width = stepsWidth(stepCount);
  const info = STEP_LANE_INFO[lane];

  // Redraw whenever this channel's notes change.
  const themed = useThemeVersion();
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let lastNotes: unknown = null;
    const draw = () => {
      const notes = services.doc.getState().project.patterns[patternId]?.notes[channelId];
      if (notes === lastNotes) return;
      lastNotes = notes;
      drawStepGraph(el, stepView(notes, stepCount).notes, { width, stepCount, lane, rootKey });
    };
    draw();
    return services.doc.subscribe(draw);
  }, [services, channelId, patternId, stepCount, width, lane, rootKey, info.bipolar, isSteps, isInstrument, themed]);

  const showReadout = (text: string) => {
    if (readout.current) readout.current.textContent = text;
  };
  const drag = useStepGraphDrag({ services, channelId, patternId, stepCount, lane, rootKey, name, showReadout });

  if (!isInstrument) return null;
  return (
    <div className={styles.graphRow}>
      <div className={styles.graphControls}>
        <select
          value={lane}
          onChange={(e) => services.editor.getState().setStepGraph({ lane: e.target.value as StepLane })}
          data-hint="What the graph editor shows and edits for each step"
          aria-label="Graph editor lane"
        >
          {STEP_LANES.map((l) => (
            <option key={l} value={l}>
              Graph: {STEP_LANE_INFO[l].label}
            </option>
          ))}
        </select>
        <button
          className={styles.graphClose}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => services.editor.getState().setStepGraph({ channelId: null })}
          data-hint="Close the graph editor"
          aria-label="Close the graph editor"
        >
          ×
        </button>
      </div>
      {isSteps ? (
        <canvas
          ref={canvas}
          className={styles.graph}
          style={{ width, height: GRAPH_H }}
          data-hint={`Graph editor for ${name}: ${info.label} — ${info.hint}. Drag up or down over the steps, right-drag to reset`}
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={drag.onPointerDown}
          onPointerMove={drag.apply}
          onPointerUp={drag.onPointerUp}
          onPointerCancel={drag.onPointerCancel}
        />
      ) : (
        <div className={styles.graphEmpty} style={{ width }}>
          These notes are longer than a step or overlap, so they don’t show as steps. Edit them in the piano roll (F7).
        </div>
      )}
      {/* The value being drawn, in its unit (written while dragging). */}
      <span ref={readout} className={styles.graphValue} />
    </div>
  );
}

/** What dragging over the graph needs to know. */
interface StepGraphDragInput {
  services: Services;
  channelId: ChannelId;
  patternId: PatternId;
  stepCount: number;
  lane: StepLane;
  rootKey: number;
  /** The channel's name, for the undo label. */
  name: string;
  /** Shows the value being drawn, in its unit, while dragging (empty text clears it). */
  showReadout(text: string): void;
}

/** Drawing values on the graph: press and drag to set the steps passed over (one undo step per drag), right-drag to reset them. */
function useStepGraphDrag({ services, channelId, patternId, stepCount, lane, rootKey, name, showReadout }: StepGraphDragInput) {
  const info = STEP_LANE_INFO[lane];
  const drag = useRef<{ gesture: Gesture; last: number; reset: boolean } | null>(null);

  /** The value for a height in the graph (0 to 1, or -1 to 1 for two-way lanes, with the middle snapped to zero). */
  const valueAt = (y: number) => {
    const fraction = Math.max(0, Math.min(1, 1 - (y - GRAPH_MARGIN) / (GRAPH_H - 2 * GRAPH_MARGIN)));
    if (!info.bipolar) return fraction;
    const value = fraction * 2 - 1;
    return Math.abs(value) < GRAPH_ZERO_SNAP ? 0 : value;
  };

  /** Sets the steps from the last one touched to the one under the pointer. */
  const apply = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = drag.current;
    if (!current) return;
    const box = e.currentTarget.getBoundingClientRect();
    const step = stepAtX(e.clientX - box.left, stepCount);
    if (step < 0) return;
    const value = current.reset ? stepReset(lane) : valueAt(e.clientY - box.top);
    const notes = stepNotesOf(services, patternId, channelId, stepCount);
    const from = current.last < 0 ? step : Math.min(current.last, step);
    const to = current.last < 0 ? step : Math.max(current.last, step);
    current.last = step;
    const edits: NoteEdit[] = [];
    for (let i = from; i <= to; i++) {
      const note = notes[i];
      if (note) edits.push(stepEdit(note.id, lane, value, rootKey));
    }
    const valueText = formatStepValue(lane, value, rootKey);
    showReadout(valueText);
    const hint = notes[step] ? `Step ${step + 1}: ${info.label} ${valueText}` : `Step ${step + 1} is off: turn it on to give it a value`;
    services.session.getState().setHint(hint);
    if (edits.length) current.gesture.update((draft) => editNotes(draft, patternId, channelId, edits));
  };

  const end = (commit: boolean) => {
    const current = drag.current;
    drag.current = null;
    showReadout('');
    if (commit) current?.gesture.commit();
    else current?.gesture.cancel();
  };

  return {
    apply,
    onPointerDown: (e: ReactPointerEvent<HTMLCanvasElement>) => {
      if (e.button !== 0 && e.button !== 2) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { gesture: services.history.gesture(`${info.label} (${name})`), last: -1, reset: e.button === 2 };
      apply(e);
    },
    onPointerUp: (e: ReactPointerEvent<HTMLCanvasElement>) => {
      apply(e);
      e.currentTarget.releasePointerCapture(e.pointerId);
      end(true);
    },
    onPointerCancel: () => end(false),
  };
}
