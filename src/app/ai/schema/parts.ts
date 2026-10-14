/**
 * Building blocks of the action schema (JSON schema for structured outputs: every object
 * `additionalProperties: false`, ranges in descriptions — structured outputs take no numeric bounds;
 * the applier validates and clamps everything).
 */
export const str = (description: string) => ({ type: 'string', description });
export const num = (description: string) => ({ type: 'number', description });
export const int = (description: string) => ({ type: 'integer', description });
export const bool = (description: string) => ({ type: 'boolean', description });

export const CHANNEL = str('A channel: its id (ch_…), its exact name, or @ref of a channel added earlier in this answer.');
export const INSERT = str(
  'A mixer track: "master", its number ("3"), its id (ins_…), its name, or @ref of one added earlier.',
);
export const EFFECT = str('An effect slot: its id (fx_…) or @ref of one added earlier in this answer.');
export const PATTERN = str('A pattern: "current", its id (pat_…), its exact name, or @ref of one added earlier.');
export const PLUGIN = str('Plugin id from the catalog (e.g. "agstudio.3xosc").');
export const REF = str('Optional name to refer to what this creates in later actions of the same answer, e.g. "@bass".');
export const PRESET = str('A preset name from the catalog for this plugin (applied before params).');
export const PARAMS = {
  type: 'array',
  description:
    'Plugin settings: name = param id from the catalog; value in the unit listed there (params marked 0–1 % take 0–1, enums take an option id, on/off params take true/false).',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      value: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'boolean' }] },
    },
    required: ['name', 'value'],
  },
};

export const op = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  description,
  additionalProperties: false,
  properties: { op: { type: 'string', const: name }, ...properties },
  required: ['op', ...required],
});

export const VALUE = (description: string) => ({ anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'boolean' }], description });
export const IN_UNIT =
  'In the control’s own unit: dB for volumes and sends, −1…1 for pan, cents for pitch, 0..1 for effect mix, BPM for tempo, the catalog unit or option id for plugin params.';

/** What an automation clip moves. */
export const AUTOMATION_TARGET = {
  type: 'object',
  description: 'The control the automation moves.',
  additionalProperties: false,
  properties: {
    kind: {
      type: 'string',
      enum: [
        'channel_volume',
        'channel_pan',
        'channel_pitch',
        'track_volume',
        'track_pan',
        'send',
        'effect_mix',
        'plugin',
        'tempo',
      ],
      description:
        'channel_* use "channel"; track_* use "insert"; send uses "insert" (from) and "to"; effect_mix uses "effect"; plugin uses "param" plus "channel" (its instrument) or "effect"; tempo needs nothing else.',
    },
    channel: CHANNEL,
    insert: INSERT,
    to: { ...INSERT, description: 'For a send: the mixer track it goes to.' },
    effect: EFFECT,
    param: str('For kind plugin: the param id from the catalog.'),
  },
  required: ['kind'],
};

/** One op's schema. */
export type OpSchema = ReturnType<typeof op>;
