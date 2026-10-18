/** Automation clips: a control moving over time (points or an LFO). */
import { LFO_SHAPES } from '@core/automation/generate';
import * as S from '../../schema/parts';
import type { OpModule } from '../context';
import { automate } from './automate';
import { EDIT_MODES, editAutomation } from './edit';

export { automationDrives, ownUnitOf, paramTargetOf } from './targets';

/** One curve point as the AI writes it (the same fields for automate and edit_automation). */
const POINT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bar: S.num('Bars from the clip start: 0 is its start, fractions allowed.'),
    value: S.VALUE(S.IN_UNIT),
    shape: {
      type: 'string',
      enum: ['curve', 'hold', 'stairs', 'smooth'],
      description:
        'How it moves on to the next point: curve (a line, bent by tension), hold, stairs, smooth (S-shape).',
    },
    tension: S.num('−1…1: bends the move to the next point (negative starts slowly, positive starts fast).'),
  },
  required: ['bar', 'value'],
};

export const automation: OpModule = {
  schemas: [
    S.op(
      'automate',
      'Draws an automation clip on the playlist that moves one control over time when the song plays: fades, filter sweeps, risers, send throws, tempo ramps, wobbles. Give points, or an lfo for a repeating wave.',
      {
        ref: S.REF,
        target: S.AUTOMATION_TARGET,
        from_bar: S.int('1-based bar where the clip starts (default 1).'),
        bars: S.num('Length in bars (default 4).'),
        points: { type: 'array', description: 'The curve, in order.', items: POINT },
        lfo: {
          type: 'object',
          description: 'Instead of points: a repeating wave over the whole clip.',
          additionalProperties: false,
          properties: {
            shape: { type: 'string', enum: [...LFO_SHAPES] },
            beats: S.num('Cycle length in beats (1 = a quarter note, 0.5 = an eighth, 4 = a bar of 4/4).'),
            depth: S.num('0..1: how much of the control’s range it sweeps, peak to peak.'),
            center: S.VALUE(`The middle of the wave. ${S.IN_UNIT} Default: the control’s current value.`),
          },
          required: ['shape', 'beats', 'depth'],
        },
      },
      ['target'],
    ),
    S.op(
      'edit_automation',
      'Edits the points of an automation clip that already exists, in place (no delete and recreate): sets the points in a bar range, moves them in time, scales their values around their middle, removes them, or bends the curve leaving them. Name the clip by its channel (id or name, as get_automation lists it) or by what it drives. Bars count from the start of the curve, as get_automation reports them; values are in the control’s own unit.',
      {
        mode: {
          type: 'string',
          enum: [...EDIT_MODES],
          description:
            'set_points: replace the points in the range with the points given. move: shift them by bars. scale: multiply how far they sit from their middle by factor. remove: delete them. tension: set the bend of the curve leaving them.',
        },
        channel: { ...S.CHANNEL, description: 'The automation channel: its id, its exact name, or @ref.' },
        drives: S.str('Instead of channel: what it drives, as get_automation reports it (e.g. "Volume · Lead").'),
        from: S.num('The range starts at this bar of the curve (0 = its first bar; default 0).'),
        to: S.num('The range ends before this bar (default: the end of the curve).'),
        points: {
          type: 'array',
          description: 'set_points: the new points, in order, bars from the curve start inside the range.',
          items: POINT,
        },
        by: S.num('move: bars to shift the points by (negative = earlier).'),
        factor: S.num('scale: 0 or more. 2 doubles how far the points sit from their middle, 0.5 halves it.'),
        tension: S.num(
          'tension: −1…1 for the curve leaving each point (negative starts slowly, positive starts fast).',
        ),
      },
      ['mode'],
    ),
  ],
  handlers: {
    edit_automation: (action, context) => editAutomation(action, context),
    automate: (action, context) => automate(action, context),
  },
};
