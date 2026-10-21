/**
 * Velocity: reshapes how hard notes are played. A curve compresses (soft notes get louder, so playing is more even) or expands
 * (soft notes get softer, so playing is more dynamic), a fixed level plays everything the same, and a range squeezes all notes
 * between a lowest and a highest level.
 */
import { p } from '@agstudio/sdk/params';
import { changedNote, clampVelocity } from '../note-utils';
import type { FxNote, MidiFxDef } from '../types';

const MODES = ['curve', 'fixed', 'range'];
const MODE_LABELS = { curve: 'Curve', fixed: 'Fixed level', range: 'Range' };
/** The curve's steepest bend: full "expand" raises velocities to this power, full "compress" to its inverse. */
const STEEPEST_POWER = 2 ** 1.5;

/** The velocity a played velocity becomes under the effect's settings at a tick. */
function reshaped(velocity: number, mode: string, at: number, param: (name: string, tick: number) => number): number {
  if (mode === 'fixed') return param('fixed', at);
  if (mode === 'range') {
    const low = param('low', at);
    const high = param('high', at);
    return low + velocity * (high - low);
  }
  const power = STEEPEST_POWER ** param('curve', at);
  return velocity ** power;
}

/** Velocity: see the file comment. */
export const velocityCurve: MidiFxDef = {
  id: 'velocity',
  name: 'Velocity',
  description: 'Reshapes how hard notes are played: even them out, make them more dynamic, play them all the same, or keep them in a range.',
  params: {
    mode: p.enum(MODES, 'curve', { label: 'Mode', labels: MODE_LABELS, hint: 'Curve bends the dynamics, Fixed level plays every note the same, Range squeezes them between two levels' }),
    curve: p.float(-1, 1, 0, { label: 'Curve', unit: '%', hint: 'Below 0 compresses (soft notes get louder), above 0 expands (soft notes get softer)' }),
    fixed: p.float(0.01, 1, 0.8, { label: 'Fixed level', unit: '%', hint: 'Fixed level mode: every note is played at this velocity' }),
    low: p.float(0.01, 1, 0.3, { label: 'Lowest', unit: '%', hint: 'Range mode: the softest note becomes this velocity' }),
    high: p.float(0.01, 1, 0.9, { label: 'Highest', unit: '%', hint: 'Range mode: the hardest note becomes this velocity' }),
  },
  presets: [
    { name: 'Neutral', params: {} },
    { name: 'Even out (compress)', params: { curve: -0.6 } },
    { name: 'More dynamic (expand)', params: { curve: 0.6 } },
    { name: 'All the same', params: { mode: 'fixed', fixed: 0.85 } },
    { name: 'Keep it gentle', params: { mode: 'range', low: 0.25, high: 0.65 } },
  ],
  reach: () => ({ before: 0, after: 0 }),
  run(input, run) {
    const mode = String(run.values.mode);
    return input.map((note: FxNote) => changedNote(note, { velocity: clampVelocity(reshaped(note.velocity, mode, note.start, run.param)) }));
  },
};
