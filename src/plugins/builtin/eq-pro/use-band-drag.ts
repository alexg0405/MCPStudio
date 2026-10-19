// Moving the EQ Pro bands with the mouse: drag a handle (sideways = frequency, up and down = gain), or
// double-click empty space to switch on a free band right there.
import {
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import type { ParamValue } from '@agstudio/sdk';
import { emitHint } from '@agstudio/sdk/ui';
import { hasGain } from './design.kernel';
import { describeBand, type BandView, type EqProProps } from './eq-bands';
import { clamp, DB_RANGE, dbAtY, FREE_BAND_ORDER, frequencyAtPosition, MARGIN, positionOfFrequency } from './eq-graph';
import { bandIds } from './params';
import type { GraphSize } from './use-eq-graph';

/** The ways to change a param as undoable edits (a drag is one undo step), with ids given as strings. */
export interface ParamEditing {
  begin(param: string): void;
  end(param: string): void;
  set(param: string, value: ParamValue): void;
}

/** What a drag started from: the band, its position and gain then, and where the pointer was. */
interface DragStart {
  band: number;
  position: number;
  gainDb: number;
  pointerX: number;
  pointerY: number;
}

/** Rounds to one decimal place, so dragged values stay tidy. */
const tenths = (value: number) => Math.round(value * 10) / 10;

/** The pointer handlers of the graph. `selectBand` makes a band the one edited in the strip below. */
export function useBandDrag(
  graph: RefObject<HTMLDivElement | null>,
  size: GraphSize,
  bands: BandView[],
  specs: EqProProps['specs'],
  editing: ParamEditing,
  selectBand: (band: number) => void,
) {
  const drag = useRef<DragStart | null>(null);

  /** Where a pointer event is within the graph, in pixels. */
  const pointerIn = (event: { clientX: number; clientY: number }) => {
    const rect = graph.current?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: 0, y: 0 };
  };

  const onHandleDown = (event: ReactPointerEvent<SVGGElement>, band: BandView) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectBand(band.number);
    const ids = bandIds(band.number);
    editing.begin(ids.freq);
    if (!band.isOn) editing.set(ids.on, true);
    const pointer = pointerIn(event);
    drag.current = {
      band: band.number,
      position: positionOfFrequency(band.frequencyHz),
      gainDb: band.gainDb,
      pointerX: pointer.x,
      pointerY: pointer.y,
    };
  };

  const onHandleMove = (event: ReactPointerEvent<SVGGElement>, band: BandView) => {
    const start = drag.current;
    if (!start || start.band !== band.number) return;
    // The button was released somewhere we didn't hear about: the drag is over.
    if (event.buttons === 0) {
      onHandleUp(event, band);
      return;
    }
    const pointer = pointerIn(event);
    // Shift drags ten times finer.
    const precision = event.shiftKey ? 0.1 : 1;
    const ids = bandIds(band.number);
    const frequencyHz = tenths(
      frequencyAtPosition(start.position + ((pointer.x - start.pointerX) / size.width) * precision),
    );
    const moved = { ...band, frequencyHz, isOn: true };
    editing.set(ids.freq, frequencyHz);
    if (hasGain(band.type)) {
      const pixelsPerDb = (size.height / 2 - MARGIN) / DB_RANGE;
      const rawGainDb = start.gainDb + ((start.pointerY - pointer.y) / pixelsPerDb) * precision;
      const gainDb = tenths(clamp(rawGainDb, -DB_RANGE, DB_RANGE));
      editing.set(ids.gain, gainDb);
      moved.gainDb = gainDb;
    }
    emitHint(event.currentTarget, describeBand(moved, specs));
  };

  function onHandleUp(event: ReactPointerEvent<SVGGElement>, band: BandView) {
    if (!drag.current || drag.current.band !== band.number) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    editing.end(bandIds(band.number).freq);
  }

  /** Double-click on empty space: switch on a free band right there. */
  const onGraphDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('[data-band]')) return;
    const free = FREE_BAND_ORDER.map((number) => bands[number - 1]!).find((band) => !band.isOn);
    if (!free) return;
    const pointer = pointerIn(event);
    const ids = bandIds(free.number);
    editing.begin(ids.freq);
    editing.set(ids.on, true);
    editing.set(ids.freq, tenths(frequencyAtPosition(pointer.x / size.width)));
    if (hasGain(free.type)) {
      editing.set(ids.gain, tenths(clamp(dbAtY(pointer.y, size.height), -DB_RANGE, DB_RANGE)));
    }
    editing.end(ids.freq);
    selectBand(free.number);
  };

  return { onHandleDown, onHandleMove, onHandleUp, onGraphDoubleClick };
}
