/** The velocity tools: Scale velocities, Velocity range and Velocity ramp. */
import { defineNoteScript, p } from '@agstudio/sdk';
import { fitVelocities, rampVelocities, scaleVelocities } from '@agstudio/sdk/notes';

export const scaleVelocityTool = defineNoteScript({
  id: 'agstudio.notes.velocity-scale',
  name: 'Scale velocities',
  version: 1,
  category: 'Velocity',
  description: 'Makes notes louder or softer: Amount 0.5× halves every velocity, Offset adds to it.',
  params: {
    factor: p.float(0, 2, 1, { label: 'Amount', unit: 'x', hint: '1× = unchanged' }),
    offset: p.float(-1, 1, 0, { label: 'Offset', unit: '%', hint: 'Added to every velocity after scaling' }),
  },
  run: (ctx) => scaleVelocities(ctx.notes, { factor: ctx.values.factor, offset: ctx.values.offset }),
});

export const velocityRangeTool = defineNoteScript({
  id: 'agstudio.notes.velocity-range',
  name: 'Velocity range',
  version: 1,
  category: 'Velocity',
  description: 'Spreads velocities between a minimum and a maximum: the softest note gets the minimum.',
  params: {
    min: p.float(0, 1, 0.4, { label: 'Softest', unit: '%' }),
    max: p.float(0, 1, 1, { label: 'Loudest', unit: '%' }),
  },
  run: (ctx) => fitVelocities(ctx.notes, { min: ctx.values.min, max: ctx.values.max }),
});

export const velocityRampTool = defineNoteScript({
  id: 'agstudio.notes.velocity-ramp',
  name: 'Velocity ramp',
  version: 1,
  category: 'Velocity',
  description: 'A crescendo or fade across the notes, from the first note’s level to the last one’s.',
  params: {
    from: p.float(0, 1, 0.3, { label: 'First note', unit: '%' }),
    to: p.float(0, 1, 1, { label: 'Last note', unit: '%' }),
    curve: p.float(-1, 1, 0, { label: 'Curve', hint: '0 = straight; above 0 rises late, below 0 rises early' }),
    multiply: p.bool(false, { label: 'Scale the existing velocities' }),
  },
  run: (ctx) =>
    rampVelocities(ctx.notes, {
      from: ctx.values.from,
      to: ctx.values.to,
      curve: ctx.values.curve,
      multiply: ctx.values.multiply,
    }),
});
