/**
 * Rounds the starts and ends of notes to places a score can write. The chosen grid (1/8, 1/16 or 1/32) is the finest
 * straight value; on top of that, each beat is looked at on its own and, when its note starts sit on triplet places
 * (a third or a sixth of the beat) better than on the grid, that beat is written as a triplet.
 */
import type { Tick } from '../model/types';
import type { Meter } from './meter';
import type { NotationGrid, NotationNote } from './types';

/** A note with its start and end rounded. `end` is always after `start`. */
export interface QuantizedNote {
  note: NotationNote;
  start: Tick;
  end: Tick;
}

/** What `quantizeNotes` found. */
export interface Quantized {
  notes: QuantizedNote[];
  /** Triplet windows by index (window n starts at n * windowTicks): the length of one slot in ticks. */
  tripletUnits: ReadonlyMap<number, Tick>;
  windowTicks: Tick;
  gridTicks: Tick;
}

/** Ticks of each grid choice. */
export const GRID_TICKS: Readonly<Record<NotationGrid, Tick>> = { '1/8': 480, '1/16': 240, '1/32': 120 };

/** A start this close (ticks) to a triplet place counts as on it: about a 48th of a beat, less than the grid steps. */
const TRIPLET_TOLERANCE_DIVISOR = 48;

const distanceToLattice = (tick: number, unit: number): number => {
  const rest = tick % unit;
  return Math.min(rest, unit - rest);
}

/** Rounds `tick` to the nearest multiple of `unit` counted from `origin`. */
const snapTo = (tick: number, unit: number, origin = 0): number => origin + Math.round((tick - origin) / unit) * unit;

/** The note starts and ends that fall strictly inside each window (a window's own edges are on every grid), by window index. */
interface WindowPoints {
  starts: Map<number, number[]>;
  ends: Map<number, number[]>;
}

function pointsByWindow(notes: readonly NotationNote[], windowTicks: Tick): WindowPoints {
  const starts = new Map<number, number[]>();
  const ends = new Map<number, number[]>();
  const add = (map: Map<number, number[]>, tick: number): void => {
    const index = Math.floor(tick / windowTicks);
    if (tick === index * windowTicks) return;
    const list = map.get(index);
    if (list) list.push(tick);
    else map.set(index, [tick]);
  };
  for (const note of notes) {
    add(starts, note.tick);
    add(ends, note.tick + note.length);
  }
  return { starts, ends };
}

/**
 * The places inside a window that decide whether it is a triplet: the note starts. A short staccato note's end says
 * nothing about the rhythm, so ends only count when no note starts inside the window (a note that fills a triplet beat and
 * is followed by a rest).
 */
function interiorPoints(points: WindowPoints, index: number, useEnds: boolean): readonly number[] {
  const starts = points.starts.get(index) ?? [];
  return starts.length > 0 || !useEnds ? starts : (points.ends.get(index) ?? []);
}

/**
 * The triplet slot length for a window, or null when it is straight. A window is a triplet when its points fit the
 * triplet places better than the grid and at least one of them is clearly off the grid.
 */
function tripletUnitFor(points: readonly number[], windowStart: Tick, windowTicks: Tick, gridTicks: Tick): Tick | null {
  if (points.length === 0) return null;
  const sixth = windowTicks / 6;
  const third = windowTicks / 3;
  const tolerance = windowTicks / TRIPLET_TOLERANCE_DIVISOR;
  const straightUnit = Math.min(gridTicks, 240);
  let straightError = 0;
  let tripletError = 0;
  let isClearlyOffGrid = false;
  for (const point of points) {
    const local = point - windowStart;
    const toGrid = distanceToLattice(point, straightUnit);
    straightError += toGrid;
    tripletError += distanceToLattice(local, sixth);
    if (toGrid > tolerance) isClearlyOffGrid = true;
  }
  if (!isClearlyOffGrid || tripletError >= straightError) return null;
  const fitsThirds = points.every((point) => distanceToLattice(point - windowStart, third) <= tolerance);
  return fitsThirds ? third : sixth;
}

/** Rounds every note; see the file comment. Drum parts pass `useEnds: false`: how long a hit rings is not written. */
export function quantizeNotes(notes: readonly NotationNote[], meter: Meter, grid: NotationGrid, options: { useEnds?: boolean } = {}): Quantized {
  const gridTicks = GRID_TICKS[grid];
  const windowTicks = meter.tripletWindowTicks;
  const lastEnd = notes.reduce((end, note) => Math.max(end, note.tick + note.length), 0);
  const tripletUnits = new Map<number, Tick>();
  const points = pointsByWindow(notes, windowTicks);
  for (let index = 0; index * windowTicks < lastEnd; index++) {
    const start = index * windowTicks;
    const unit = tripletUnitFor(interiorPoints(points, index, options.useEnds !== false), start, windowTicks, gridTicks);
    if (unit !== null) tripletUnits.set(index, unit);
  }
  const snap = (tick: number): number => {
    const index = Math.floor(tick / windowTicks);
    const unit = tripletUnits.get(index);
    return unit === undefined ? snapTo(tick, gridTicks) : snapTo(tick, unit, index * windowTicks);
  };
  const out: QuantizedNote[] = notes.map((note) => {
    const start = snap(note.tick);
    let end = snap(note.tick + note.length);
    if (end <= start) end = start + (tripletUnits.get(Math.floor(start / windowTicks)) ?? gridTicks);
    return { note, start, end };
  });
  out.sort((a, b) => a.start - b.start || a.note.key - b.note.key);
  return { notes: out, tripletUnits, windowTicks, gridTicks };
}
