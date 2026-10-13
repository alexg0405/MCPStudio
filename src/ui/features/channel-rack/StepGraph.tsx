import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { STEP_LANES, type StepLane } from '@app/stores/editor';
import type { Gesture } from '@core/history/history';
import type { ChannelId, PatternId } from '@core/model/types';
import { editNotes, type NoteEdit } from '@core/ops/notes';
import { stepView } from '@core/query/queries';
import { useDoc, useServices } from '../../services-context';
import { fitCanvas, readTheme } from '../../timeline/canvas';
import { STEP_W, stepAtX, stepsWidth, stepX } from './layout';
import { formatStepValue, STEP_LANE_INFO, stepEdit, stepReset, stepValue } from './steps';
import styles from './ChannelRack.module.css';

const GRAPH_H = 56;

/**
 * FL's graph editor: a row under a channel's steps showing one property per step as bars. Drag to
 * draw values (one undo step per drag), right-drag to reset them. Drawn imperatively from the
 * document so drags don't re-render React.
 */
export function StepGraph({
  channelId,
  patternId,
  stepCount,
}: {
  channelId: ChannelId;
  patternId: PatternId;
  stepCount: number;
}) {
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
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let last: unknown = null;
    const draw = () => {
      const notes = services.doc.getState().project.patterns[patternId]?.notes[channelId];
      if (notes === last) return;
      last = notes;
      const ctx = fitCanvas(el, width, GRAPH_H);
      const theme = readTheme();
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, width, GRAPH_H);
      const usable = GRAPH_H - 6;
      const mid = 3 + usable / 2;
      if (info.bipolar) {
        ctx.fillStyle = theme.step;
        ctx.fillRect(0, Math.round(mid), width, 1);
      }
      const view = stepView(notes, stepCount);
      for (let i = 0; i < stepCount; i++) {
        const x = stepX(i);
        // Every other group of four is shaded, like the step buttons.
        if (Math.floor(i / 4) % 2) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.025)';
          ctx.fillRect(x, 0, STEP_W, GRAPH_H);
        }
        const n = view.notes[i];
        if (!n) {
          ctx.fillStyle = theme.step;
          ctx.fillRect(x + STEP_W / 2 - 1, GRAPH_H - 4, 2, 2);
          continue;
        }
        const v = stepValue(n, lane, rootKey);
        ctx.fillStyle = theme.note;
        if (info.bipolar) {
          const h = Math.max(2, (Math.abs(v) * usable) / 2);
          ctx.fillRect(x + 2, v >= 0 ? mid - h : mid, STEP_W - 4, h);
        } else {
          const h = Math.max(2, v * usable);
          ctx.fillRect(x + 2, GRAPH_H - 3 - h, STEP_W - 4, h);
        }
      }
    };
    draw();
    return services.doc.subscribe(draw);
  }, [services, channelId, patternId, stepCount, width, lane, rootKey, info.bipolar, isSteps, isInstrument]);

  // ---- drawing values (imperative; one gesture per drag) ----
  const drag = useRef<{ gesture: Gesture; last: number; reset: boolean } | null>(null);
  const valueAt = (y: number) => {
    const t = Math.max(0, Math.min(1, 1 - (y - 3) / (GRAPH_H - 6)));
    if (!info.bipolar) return t;
    const v = t * 2 - 1;
    return Math.abs(v) < 0.04 ? 0 : v;
  };
  const apply = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const step = stepAtX(x, stepCount);
    if (step < 0) return;
    const value = d.reset ? stepReset(lane) : valueAt(e.clientY - r.top);
    const notes = stepView(services.doc.getState().project.patterns[patternId]?.notes[channelId], stepCount).notes;
    const from = d.last < 0 ? step : Math.min(d.last, step);
    const to = d.last < 0 ? step : Math.max(d.last, step);
    d.last = step;
    const edits: NoteEdit[] = [];
    for (let i = from; i <= to; i++) {
      const n = notes[i];
      if (n) edits.push(stepEdit(n.id, lane, value, rootKey));
    }
    const text = `Step ${step + 1}: ${info.label} ${formatStepValue(lane, value, rootKey)}`;
    if (readout.current) readout.current.textContent = formatStepValue(lane, value, rootKey);
    services.session.getState().setHint(notes[step] ? text : `Step ${step + 1} is off: turn it on to give it a value`);
    if (edits.length) d.gesture.update((draft) => editNotes(draft, patternId, channelId, edits));
  };
  const end = (commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (readout.current) readout.current.textContent = '';
    if (commit) d?.gesture.commit();
    else d?.gesture.cancel();
  };

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
          tabIndex={-1}
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
          onPointerDown={(e) => {
            if (e.button !== 0 && e.button !== 2) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = {
              gesture: services.history.gesture(`${info.label} (${name})`),
              last: -1,
              reset: e.button === 2,
            };
            apply(e);
          }}
          onPointerMove={apply}
          onPointerUp={(e) => {
            apply(e);
            e.currentTarget.releasePointerCapture(e.pointerId);
            end(true);
          }}
          onPointerCancel={() => end(false)}
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
