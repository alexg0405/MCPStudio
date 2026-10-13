/**
 * The piano roll's event lanes: how each note property maps to a bar in the lane under the grid
 * and back. Velocity and release go up from the bottom (0–1); pan and fine pitch go both ways from
 * the centre line (−1…1).
 */
import type { NoteLane } from '@app/stores/editor';
import type { Note, NoteId } from '@core/model/types';
import type { NoteEdit } from '@core/ops/notes';

export interface LaneInfo {
  label: string;
  /** Bars grow from the centre line instead of the bottom. */
  bipolar: boolean;
  /** The value a reset (right-drag) writes, in lane units (0–1, or −1…1 when bipolar). */
  reset: number;
}

export const LANES: Record<NoteLane, LaneInfo> = {
  velocity: { label: 'Velocity', bipolar: false, reset: 100 / 128 },
  pan: { label: 'Pan', bipolar: true, reset: 0 },
  release: { label: 'Release', bipolar: false, reset: 0.5 },
  fine: { label: 'Fine pitch', bipolar: true, reset: 0 },
};

/** A note's value in lane units: 0–1, or −1…1 for bipolar lanes. */
export function laneValue(n: Note, lane: NoteLane): number {
  switch (lane) {
    case 'velocity':
      return n.velocity;
    case 'pan':
      return n.pan ?? 0;
    case 'release':
      return n.release ?? 0.5;
    case 'fine':
      return (n.fine ?? 0) / 100;
  }
}

/** The edit that gives a note `value` (lane units). */
export function laneEdit(id: NoteId, lane: NoteLane, value: number): NoteEdit {
  switch (lane) {
    case 'velocity':
      return { id, velocity: Math.max(0.01, Math.min(1, value)) };
    case 'pan':
      return { id, pan: Math.max(-1, Math.min(1, value)) };
    case 'release':
      return { id, release: Math.max(0, Math.min(1, value)) };
    case 'fine':
      return { id, fine: Math.round(Math.max(-1, Math.min(1, value)) * 100) };
  }
}

/** The lane value at a height in the lane (y from the top of a lane `height` px tall). */
export function valueAtY(y: number, height: number, lane: NoteLane): number {
  const t = Math.max(0, Math.min(1, 1 - (y - 3) / Math.max(1, height - 6)));
  if (!LANES[lane].bipolar) return t;
  const v = t * 2 - 1;
  // A little dead zone around the centre makes "back to 0" easy to hit.
  return Math.abs(v) < 0.04 ? 0 : v;
}

/** A value in its unit: "78%", "25% left", "centred", "+12 ct". */
export function formatLaneAmount(lane: NoteLane, value: number): string {
  switch (lane) {
    case 'velocity':
    case 'release':
      return `${Math.round(value * 100)}%`;
    case 'pan':
      return value === 0 ? 'centred' : `${Math.round(Math.abs(value) * 100)}% ${value < 0 ? 'left' : 'right'}`;
    case 'fine': {
      const ct = Math.round(value * 100);
      return `${ct > 0 ? '+' : ''}${ct} ct`;
    }
  }
}

/** Hint-bar text for a value: "Velocity 78%", "Pan 25% left". */
export function formatLaneValue(lane: NoteLane, value: number): string {
  return `${LANES[lane].label} ${formatLaneAmount(lane, value)}`;
}
