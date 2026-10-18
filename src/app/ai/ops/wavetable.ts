/** Sound design: give a Wavetable channel a table of its own from a description of harmonics (wavetable_shape). */
import { setPluginState } from '@core/ops/channels';
import { frameFromHarmonics, MAX_FRAMES, userTableState } from '@agstudio/sdk/dsp/wavetable-frames';
import * as S from '../schema/parts';
import { fail, type OpModule } from './context';
import { isObj, num, r2, str } from './values';

/** The Wavetable's plugin id (the plugin lives in `plugins/builtin`, which the app does not import). */
const WAVETABLE_ID = 'agstudio.wavetable';
/** The most harmonics a described frame may list (the table keeps 256, but a description rarely needs more than 128). */
const MAX_LISTED_HARMONICS = 128;
/** The level an oscillator that was off is turned up to when the table is put on it. */
const OSC_ON_LEVEL = 0.7;

/** The strengths of one frame's harmonics, checked: 1…128 non-negative numbers, not all zero. */
function harmonicsOf(raw: unknown, frameNumber: number): number[] {
  const list = isObj(raw) ? raw.harmonics : undefined;
  if (!Array.isArray(list) || list.length === 0) return fail(`frame ${frameNumber}: harmonics must be a list of strengths (the first is the fundamental)`);
  if (list.length > MAX_LISTED_HARMONICS) fail(`frame ${frameNumber}: at most ${MAX_LISTED_HARMONICS} harmonics`);
  const strengths = list.map((x) => Math.max(0, num(x) ?? 0));
  if (strengths.every((x) => x === 0)) fail(`frame ${frameNumber}: every harmonic is 0 (that frame would be silent)`);
  return strengths;
}

export const wavetable: OpModule = {
  schemas: [
    S.op(
      'wavetable_shape',
      'Gives a Wavetable synth channel a wavetable of its own, described by the strength of each harmonic of every key frame (frame 1 is position 0%, the last frame is 100%; the synth morphs between neighbours), and sets an oscillator to play it ("My table"). Replaces any table the channel had. One undo step.',
      {
        channel: { ...S.CHANNEL, description: 'The Wavetable channel (its id, name, or @ref).' },
        frames: {
          type: 'array',
          description:
            'Key frames, 1–32, in order from position 0% to 100%. Each lists harmonic strengths: harmonics[0] is the fundamental (the pitch itself), [1] the octave above, [2] the octave and a fifth, and so on (up to 128). Sines add up, so [1, 0.5, 0.33, 0.25] is a saw-like tone, [1, 0, 0.33, 0, 0.2] a hollow square-like one, [1] a pure sine; frames are leveled automatically.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              harmonics: { type: 'array', items: { type: 'number' }, description: 'Strengths ≥ 0 of harmonics 1, 2, 3…' },
            },
            required: ['harmonics'],
          },
        },
        oscillator: {
          type: 'string',
          enum: ['1', '2', 'both'],
          description: 'Which oscillator plays the table (default 1; an oscillator that was off is turned on).',
        },
        position: S.num('Where in the table the oscillator starts, 0–1 (default: leave it).'),
      },
      ['channel', 'frames'],
    ),
  ],
  prompt: {
    id: 'wavetable',
    order: 27,
    text: `Your own wavetables: wavetable_shape gives a Wavetable synth channel a table you describe by harmonics (a list of strengths per key frame: harmonics[0] is the pitch itself, [1] the octave up, and so on), and puts it on oscillator 1, 2 or both. Use several frames to make a sound that morphs (a few harmonics → many, odd harmonics only → all, a bump of harmonics that moves up for a vowel or wah) and move "position" (or a mod matrix slot such as an LFO → osc1Position) through them. The musician can then reshape the table by hand in the Wavetable's table editor.`,
  },
  handlers: {
    wavetable_shape: (a, c) => {
      const { d } = c;
      const id = c.channel(a.channel);
      const ch = d.channels[id]!;
      if (ch.kind !== 'instrument' || ch.plugin.pluginId !== WAVETABLE_ID)
        return fail(`“${ch.name}” is not a Wavetable channel (wavetable_shape needs ${WAVETABLE_ID})`);
      if (!Array.isArray(a.frames) || a.frames.length === 0) return fail('frames: give at least one key frame');
      if (a.frames.length > MAX_FRAMES) fail(`frames: a table holds at most ${MAX_FRAMES} key frames`);
      const frames = a.frames.map((f, i) => frameFromHarmonics(harmonicsOf(f, i + 1)));
      setPluginState(d, { kind: 'channel', channelId: id }, userTableState(frames) as never);

      const which = str(a.oscillator) ?? '1';
      const oscillators = which === 'both' ? [1, 2] : which === '2' ? [2] : [1];
      const position = num(a.position);
      const notes: string[] = [];
      for (const n of oscillators) {
        ch.plugin.params[`osc${n}Table`] = 'user';
        if (position !== undefined) ch.plugin.params[`osc${n}Position`] = Math.max(0, Math.min(1, position));
        if (Number(ch.plugin.params[`osc${n}Level`] ?? 0) === 0) {
          ch.plugin.params[`osc${n}Level`] = OSC_ON_LEVEL;
          notes.push(`turned oscillator ${n} on`);
        }
      }
      const where = oscillators.length === 2 ? 'oscillators 1 and 2' : `oscillator ${oscillators[0]}`;
      const at = position === undefined ? '' : ` at position ${r2(Math.max(0, Math.min(1, position)) * 100)}%`;
      return `Gave “${ch.name}” a drawn table of ${frames.length} frame${frames.length === 1 ? '' : 's'} on ${where}${at}${notes.length ? ` (${notes.join(', ')})` : ''}`;
    },
  },
};
