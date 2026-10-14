/**
 * What the AI answers with: a message for the musician and a list of actions on the project. A JSON
 * schema for structured outputs (every object `additionalProperties: false`, ranges in descriptions —
 * structured outputs take no numeric bounds; the applier validates and clamps everything).
 */
import { SCALES } from '@agstudio/sdk/notes';
import { LFO_SHAPES } from '@core/automation/generate';
import { BEAT_JSON_SCHEMA } from '@core/beat/spec';

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });
const int = (description: string) => ({ type: 'integer', description });
const bool = (description: string) => ({ type: 'boolean', description });

const CHANNEL = str('A channel: its id (ch_…), its exact name, or @ref of a channel added earlier in this answer.');
const INSERT = str(
  'A mixer track: "master", its number ("3"), its id (ins_…), its name, or @ref of one added earlier.',
);
const EFFECT = str('An effect slot: its id (fx_…) or @ref of one added earlier in this answer.');
const PATTERN = str('A pattern: "current", its id (pat_…), its exact name, or @ref of one added earlier.');
const PLUGIN = str('Plugin id from the catalog (e.g. "agstudio.3xosc").');
const REF = str('Optional name to refer to what this creates in later actions of the same answer, e.g. "@bass".');
const PRESET = str('A preset name from the catalog for this plugin (applied before params).');
const PARAMS = {
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

const op = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  description,
  additionalProperties: false,
  properties: { op: { type: 'string', const: name }, ...properties },
  required: ['op', ...required],
});

const { message: _message, ...beatProps } = BEAT_JSON_SCHEMA.properties;

const VALUE = (description: string) => ({ anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'boolean' }], description });
const IN_UNIT =
  'In the control’s own unit: dB for volumes and sends, −1…1 for pan, cents for pitch, 0..1 for effect mix, BPM for tempo, the catalog unit or option id for plugin params.';

/** What an automation clip moves. */
const AUTOMATION_TARGET = {
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

export const ACTION_OPS = [
  op('song', 'Song settings.', {
    bpm: num('Tempo in BPM (10–522).'),
    swing: num('0..1 swing on even 1/16 steps.'),
    key: str(
      `Song key: a root and a scale, like "F minor", "C# dorian", "A minor-pentatonic", or "none". Scales: ${SCALES.map((sc) => sc.id).join(', ')}.`,
    ),
    time_signature: str('Like "4/4" or "3/4".'),
  }),
  op(
    'add_channel',
    'Adds a channel to the channel rack with an instrument.',
    {
      ref: REF,
      plugin: PLUGIN,
      name: str('Channel name.'),
      sample: str(
        'For the Sampler: a built-in kit sound (kick, snare, clap, hat, open-hat, tom-low, tom-mid, tom-high, rim, cowbell, crash).',
      ),
      preset: PRESET,
      params: PARAMS,
      volume_db: num('Channel volume in dB (−60…+1.9; default −2.2).'),
      pan: num('−1 (left) … 1 (right).'),
      insert: { ...INSERT, description: `${INSERT.description} The mixer track it plays through (default Master).` },
      color: str('A CSS hex color like "#c76b5b".'),
    },
    ['plugin'],
  ),
  op(
    'edit_channel',
    'Changes a channel. "plugin" swaps its instrument (settings reset unless params/preset are given).',
    {
      channel: CHANNEL,
      name: str('New name.'),
      plugin: PLUGIN,
      preset: PRESET,
      params: PARAMS,
      volume_db: num('Channel volume in dB.'),
      pan: num('−1 … 1.'),
      mute: bool('Mute it.'),
      solo: bool('Solo it.'),
      pitch_cents: num('Channel pitch in cents (−2400…2400).'),
      insert: INSERT,
      color: str('Hex color.'),
      reverse: bool('Audio clip channels: play the sample backwards.'),
      follow_tempo: {
        type: 'string',
        enum: ['off', 'resample', 'stretch'],
        description:
          'Audio clip channels: off = its own speed; resample = speed (and pitch) follow the song tempo; stretch = tempo follows, pitch stays. Needs source_bpm.',
      },
      source_bpm: num('Audio clip channels: the tempo the audio was recorded at (20–999).'),
    },
    ['channel'],
  ),
  op('remove_channel', 'Deletes a channel and its notes and clips.', { channel: CHANNEL }, ['channel']),
  op('add_insert', 'Adds a mixer track (routed to Master).', {
    ref: REF,
    name: str('Track name, e.g. "Drum bus".'),
    volume_db: num('Fader in dB (−60…+5.6).'),
    pan: num('−1 … 1.'),
    color: str('Hex color.'),
  }),
  op(
    'edit_insert',
    'Changes a mixer track.',
    {
      insert: INSERT,
      name: str('New name.'),
      volume_db: num('Fader in dB (−60…+5.6; 0 = unity).'),
      pan: num('−1 … 1.'),
      mute: bool('Mute it.'),
      solo: bool('Solo it (FL-style: its sources keep playing).'),
      color: str('Hex color.'),
    },
    ['insert'],
  ),
  op('remove_insert', 'Deletes a mixer track (its channels go to Master).', { insert: INSERT }, ['insert']),
  op(
    'add_effect',
    'Adds an effect to a mixer track’s slots.',
    {
      ref: REF,
      insert: INSERT,
      plugin: PLUGIN,
      preset: PRESET,
      params: PARAMS,
      mix: num('Dry/wet 0..1 (default 1).'),
      enabled: bool('false to add it bypassed.'),
      position: int('1-based slot position (default: after the last).'),
    },
    ['insert', 'plugin'],
  ),
  op(
    'edit_effect',
    'Changes an effect slot. "plugin" replaces the effect.',
    {
      effect: EFFECT,
      plugin: PLUGIN,
      preset: PRESET,
      params: PARAMS,
      mix: num('Dry/wet 0..1.'),
      enabled: bool('false bypasses it.'),
      position: int('Move it to this 1-based slot.'),
    },
    ['effect'],
  ),
  op('remove_effect', 'Removes an effect slot.', { effect: EFFECT }, ['effect']),
  op(
    'route',
    'Sends a mixer track into another track (adds the route, or changes its level).',
    {
      from: INSERT,
      to: INSERT,
      level_db: num('Send level in dB (default 0).'),
      pre: bool('Take it before the fader (pre-fader send).'),
    },
    ['from', 'to'],
  ),
  op('unroute', 'Removes the route from one track to another.', { from: INSERT, to: INSERT }, ['from', 'to']),
  op(
    'route_only',
    'FL’s "Route to this track only": the track’s only route becomes `to`.',
    { from: INSERT, to: INSERT },
    ['from', 'to'],
  ),
  op(
    'sidechain',
    'Feeds an effect’s sidechain input (effects marked "has a sidechain input") from a mixer track, or "none".',
    { effect: EFFECT, from: INSERT },
    ['effect', 'from'],
  ),
  op('add_pattern', 'Adds an empty pattern.', {
    ref: REF,
    name: str('Pattern name.'),
    bars: num('Length in bars (default: grows with its notes).'),
  }),
  op(
    'edit_pattern',
    'Changes a pattern.',
    { pattern: PATTERN, name: str('New name.'), color: str('Hex color.'), bars: num('Length in bars.') },
    ['pattern'],
  ),
  op('remove_pattern', 'Deletes a pattern and its playlist clips.', { pattern: PATTERN }, ['pattern']),
  op(
    'write_notes',
    'Writes notes for one channel in a pattern.',
    {
      pattern: PATTERN,
      channel: CHANNEL,
      replace: bool("true (default) replaces that channel's notes in the pattern; false adds to them."),
      notes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            step: num('1/16 step from the pattern start (bar b beat q = (b-1)*16+(q-1)*4); fractions allowed.'),
            len: num('Length in steps (default 1).'),
            key: int('MIDI note (C4 = 60). Omit for drum channels (they play their root key).'),
            vel: num('Velocity 0..1 (default 0.8).'),
          },
          required: ['step'],
        },
      },
    },
    ['pattern', 'channel', 'notes'],
  ),
  op(
    'clear_notes',
    "Removes a channel's notes from a pattern (all channels when channel is omitted).",
    { pattern: PATTERN, channel: CHANNEL },
    ['pattern'],
  ),
  op(
    'note_tool',
    'Runs a piano-roll tool from the catalog ("Piano-roll tools") on one channel’s notes in a pattern: quantize, humanize, strum, arpeggiate, legato, chords, transpose, generate… It sees notes written earlier in the same answer.',
    {
      tool: str('Tool id from the catalog, e.g. "agstudio.notes.humanize".'),
      pattern: PATTERN,
      channel: CHANNEL,
      params: { ...PARAMS, description: 'Tool settings: name = param id from the catalog; value in its unit.' },
    },
    ['tool', 'pattern', 'channel'],
  ),
  op(
    'steps',
    'Step-sequencer tools for one channel in a pattern (drum and other step parts).',
    {
      pattern: PATTERN,
      channel: CHANNEL,
      action: {
        type: 'string',
        enum: ['fill', 'rotate', 'shift', 'reverse', 'randomize', 'clear'],
        description:
          'fill = a hit every N steps; rotate wraps around the pattern; shift moves without wrapping; randomize replaces the steps with random hits.',
      },
      every: int('fill: a hit every N steps (2 = eighths, 4 = quarter notes, 8 = half notes).'),
      by: int('rotate/shift: how many 1/16 steps (negative = earlier).'),
      density: num('randomize: share of steps that get a hit, 0..1 (default 0.4).'),
    },
    ['pattern', 'channel', 'action'],
  ),
  op(
    'automate',
    'Draws an automation clip on the playlist that moves one control over time when the song plays: fades, filter sweeps, risers, send throws, tempo ramps, wobbles. Give points, or an lfo for a repeating wave.',
    {
      ref: REF,
      target: AUTOMATION_TARGET,
      from_bar: int('1-based bar where the clip starts (default 1).'),
      bars: num('Length in bars (default 4).'),
      points: {
        type: 'array',
        description: 'The curve, in order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            bar: num('Bars from the clip start: 0 is its start, fractions allowed.'),
            value: VALUE(IN_UNIT),
            shape: {
              type: 'string',
              enum: ['curve', 'hold', 'stairs', 'smooth'],
              description: 'How it moves on to the next point: curve (a line, bent by tension), hold, stairs, smooth (S-shape).',
            },
            tension: num('−1…1: bends the move to the next point (negative starts slowly, positive starts fast).'),
          },
          required: ['bar', 'value'],
        },
      },
      lfo: {
        type: 'object',
        description: 'Instead of points: a repeating wave over the whole clip.',
        additionalProperties: false,
        properties: {
          shape: { type: 'string', enum: [...LFO_SHAPES] },
          beats: num('Cycle length in beats (1 = a quarter note, 0.5 = an eighth, 4 = a bar of 4/4).'),
          depth: num('0..1: how much of the control’s range it sweeps, peak to peak.'),
          center: VALUE(`The middle of the wave. ${IN_UNIT} Default: the control’s current value.`),
        },
        required: ['shape', 'beats', 'depth'],
      },
    },
    ['target'],
  ),
  op(
    'place_pattern',
    'Places a pattern on the playlist (song mode).',
    {
      pattern: PATTERN,
      bar: int('1-based bar where it starts.'),
      track: int('1-based playlist track (default: the first free track there).'),
      bars: num('Clip length in bars (default: the pattern length).'),
      times: int('Place it this many times back to back (default 1).'),
    },
    ['pattern', 'bar'],
  ),
  op(
    'edit_audio_clip',
    'Changes one audio clip on the playlist (ids are in the playlist listing): its gain and fades.',
    {
      clip: str('The clip id (clip_…).'),
      gain_db: num('Clip gain in dB (−60…+12; 0 = as recorded).'),
      fade_in: num('Fade-in length in seconds (0 = none).'),
      fade_out: num('Fade-out length in seconds (0 = none).'),
    },
    ['clip'],
  ),
  op(
    'marker',
    'Adds, renames, moves or removes a playlist marker (a named song position like "Verse" or "Drop").',
    {
      action: { type: 'string', enum: ['add', 'edit', 'remove'] },
      marker: str('edit/remove: the marker’s id (mk_…) or exact name.'),
      name: str('add/edit: its name.'),
      bar: num('add/edit: the 1-based bar it sits at (fractions allowed).'),
      color: str('Hex color.'),
    },
    ['action'],
  ),
  op('clear_playlist', 'Removes playlist clips (all, or those overlapping the bars / on the track given).', {
    from_bar: int('1-based first bar.'),
    to_bar: int('1-based last bar (inclusive).'),
    track: int('1-based playlist track.'),
  }),
  op(
    'beat',
    'Writes a complete drum/808/melody pattern (the beat writer; follow-ups with a beat change the same pattern).',
    beatProps,
    ['title', 'bars', 'tracks'],
  ),
  op('transport', 'Playback and recording, applied after the edits.', {
    action: {
      type: 'string',
      enum: ['play', 'stop', 'record'],
      description: 'record = arm recording and play (live MIDI/typing-keyboard notes go into the current pattern).',
    },
    mode: { type: 'string', enum: ['pattern', 'song'], description: 'Switch pattern/song mode first.' },
    from_bar: int('1-based bar to play from (song mode).'),
    metronome: bool('Turn the metronome on or off.'),
  }),
  op(
    'command',
    'Runs any app command from the <commands> list, after the edits: save, save as, open, export, undo or redo, show windows, layouts, metronome, the tour… Commands that open a file dialog ask the musician to confirm with one click.',
    {
      id: str('Command id from <commands>, e.g. "file.save".'),
      args: VALUE('Only for commands that list args.'),
    },
    ['id'],
  ),
  op('open', 'Shows a window, applied after the edits.', {
    window: { type: 'string', enum: ['mixer', 'channel-rack', 'piano-roll', 'playlist', 'plugin'] },
    channel: CHANNEL,
    effect: EFFECT,
  }),
] as const;

export const ACTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: {
      type: 'string',
      description:
        'What you did (or your answer), in one to three plain sentences for the musician. If something they asked for is impossible, say so.',
    },
    actions: {
      type: 'array',
      description: 'The edits, in order (empty for questions). They are applied together as one undo step.',
      items: { anyOf: ACTION_OPS },
    },
  },
  required: ['message', 'actions'],
} as const;

/** A param value as the AI sends it. */
export interface ParamEntry {
  name: string;
  value: number | string | boolean;
}

/** One action as received (validated field by field when applied). */
export type AiAction = { op: string } & Record<string, unknown>;

export interface AiAnswer {
  message: string;
  actions: AiAction[];
}

/** Checks the answer's outer shape; drops actions that aren't objects with a known op. */
export function readAnswer(raw: unknown): { answer: AiAnswer; dropped: number } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'the answer is not an object' };
  const r = raw as Record<string, unknown>;
  if (typeof r.message !== 'string') return { error: 'the answer has no message' };
  if (!Array.isArray(r.actions)) return { error: 'the answer has no actions list' };
  const known = new Set<string>(ACTION_OPS.map((o) => o.properties.op.const));
  const actions = r.actions.filter(
    (a): a is AiAction => typeof a === 'object' && a !== null && known.has((a as { op?: string }).op ?? ''),
  );
  return { answer: { message: r.message.trim(), actions }, dropped: r.actions.length - actions.length };
}
