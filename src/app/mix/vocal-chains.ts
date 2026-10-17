/**
 * The factory vocal chains, as data: each is a row of effects (plugin id, preset name, params on top,
 * dry/wet, sends) that one click puts on a mixer insert (`actions/chains.ts` applies them). Levels are
 * calibrated so a chain keeps a vocal's loudness within about 1 dB of the dry voice
 * (`test/browser/vocal-chains.test.ts` measures it), and the sends go to the mix's Reverb and Delay
 * returns where it has them (else the step is an insert effect with the same sound).
 */
import type { ChainPreset, ChainStep } from '../chains';
import { COMPRESSOR, DELAY, eqBands, EQ_PRO, REVERB, SATURATOR, LIMITER } from './recipe-parts';

export const TUNE = 'agstudio.tune';
export const DE_ESSER = 'agstudio.de-esser';
export const DOUBLER = 'agstudio.doubler';
export const LOFI = 'agstudio.lofi';
export const GATE = 'agstudio.gate';

/** A reverb send, or (no Reverb return in the mix) an insert reverb of that preset blended `mix`. */
const reverb = (preset: string, db: number, mix: number): ChainStep => ({
  pluginId: REVERB,
  preset,
  params: { mix },
  send: { to: 'reverb', db },
  label: `${preset.toLowerCase()} reverb`,
});

/** A delay send, or an insert delay of that preset blended `mix`. */
const delay = (preset: string, db: number, mix: number): ChainStep => ({
  pluginId: DELAY,
  preset,
  params: { mix },
  send: { to: 'delay', db },
  label: `${preset.toLowerCase()} delay`,
});

const POP_EQ: ChainStep = {
  pluginId: EQ_PRO,
  preset: 'Vocal air',
  params: eqBands({ 3: { type: 'bell', freq: 300, gain: -2, q: 1.4 } }),
  label: 'EQ (90 Hz low cut, less mud at 300 Hz, presence at 3 kHz, air above 10 kHz)',
};
const POP_COMPRESSOR: ChainStep = {
  pluginId: COMPRESSOR,
  preset: 'Smooth vocals',
  params: { makeup: 2 },
  label: 'compressor (3:1, smooth, even)',
};
const POP_DE_ESSER: ChainStep = { pluginId: DE_ESSER, preset: 'Gentle', label: 'de-esser (gentle, 7 kHz)' };

/** What the mix setup's Vocals bus carries: the pop chain's EQ, compressor and de-esser, and its sends. */
export const VOCALS_BUS_FX: readonly ChainStep[] = [POP_EQ, POP_COMPRESSOR, POP_DE_ESSER];
export const VOCALS_BUS_SENDS = { reverb: -14, delay: -20 } as const;

export const FACTORY_CHAINS: readonly ChainPreset[] = [
  {
    name: 'Clean pop vocal',
    description: 'Clear and even: low cut, presence and air, gentle compression and de-essing, a tight double, a little plate and echo.',
    steps: [
      POP_EQ,
      POP_COMPRESSOR,
      POP_DE_ESSER,
      { pluginId: SATURATOR, preset: 'Subtle bus saturation', label: 'subtle saturation' },
      { pluginId: DOUBLER, preset: 'Tight double', label: 'a tight double behind the voice' },
      reverb('Plate', VOCALS_BUS_SENDS.reverb, 0.12),
      delay('Eighth echo', VOCALS_BUS_SENDS.delay, 0.08),
    ],
  },
  {
    name: 'Rap vocal',
    description: 'Upfront and dry: tight low end, forward mids, hard compression, a bright de-esser, a quiet double and a slap.',
    steps: [
      {
        pluginId: EQ_PRO,
        params: eqBands({
          1: { type: 'lowCut24', freq: 100 },
          3: { type: 'bell', freq: 250, gain: -3, q: 1.2 },
          5: { type: 'bell', freq: 3000, gain: 2, q: 1 },
          7: { type: 'highShelf', freq: 9000, gain: 2 },
        }),
        label: 'EQ (100 Hz low cut, less box at 250 Hz, forward at 3 kHz, bright above 9 kHz)',
      },
      {
        pluginId: COMPRESSOR,
        params: { threshold: -22, ratio: 4, knee: 4, attack: 3, release: 70, makeup: 2 },
        label: 'compressor (4:1, fast, up in your face)',
      },
      { pluginId: DE_ESSER, preset: 'Bright vocal', label: 'de-esser (bright vocal)' },
      { pluginId: SATURATOR, preset: 'Tube glow', params: { mix: 0.4 }, label: 'tube warmth, blended in' },
      { pluginId: DOUBLER, preset: 'Tight double', params: { level: -13 }, label: 'a quiet tight double' },
      delay('Slapback', -22, 0.07),
      reverb('Room', -22, 0.08),
    ],
  },
  {
    name: 'Airy ballad',
    description: 'Soft and open: gentle compression, shimmering highs, a wide quiet double and a long hall.',
    steps: [
      {
        pluginId: EQ_PRO,
        preset: 'Vocal air',
        params: eqBands({
          1: { type: 'lowCut24', freq: 80 },
          3: { type: 'bell', freq: 250, gain: -1.5, q: 1.2 },
          7: { type: 'highShelf', freq: 12000, gain: 4.5 },
        }),
        label: 'EQ (80 Hz low cut, a little less box, plenty of air above 12 kHz)',
      },
      {
        pluginId: COMPRESSOR,
        params: { threshold: -24, ratio: 2.5, knee: 8, attack: 12, release: 200, makeup: 2 },
        label: 'compressor (2.5:1, slow and gentle)',
      },
      { pluginId: DE_ESSER, preset: 'Bright vocal', label: 'de-esser (bright vocal)' },
      { pluginId: SATURATOR, preset: 'Tape warmth', params: { mix: 0.3 }, label: 'tape warmth, blended in' },
      { pluginId: DOUBLER, preset: 'Wide pop', params: { level: -11 }, label: 'a wide, quiet double' },
      reverb('Hall', -9, 0.22),
      delay('Eighth echo', -18, 0.1),
    ],
  },
  {
    name: 'Lo-fi vocal',
    description: 'Dusty and close: a narrow, warm tone, tape and cassette wobble, a small room and a soft echo.',
    steps: [
      {
        pluginId: EQ_PRO,
        params: eqBands({
          1: { type: 'lowCut24', freq: 220 },
          4: { type: 'bell', freq: 1200, gain: 3, q: 0.8 },
          8: { type: 'highCut12', freq: 6500 },
        }),
        label: 'EQ (220 Hz low cut, boxy mids, highs rolled off at 6.5 kHz)',
      },
      {
        pluginId: COMPRESSOR,
        preset: 'Smooth vocals',
        params: { threshold: -24, ratio: 4, makeup: 3 },
        label: 'compressor (4:1, squashed and close)',
      },
      { pluginId: SATURATOR, preset: 'Tape warmth', params: { mix: 0.8 }, label: 'tape saturation' },
      { pluginId: LOFI, preset: 'Cassette wobble', params: { mix: 0.55 }, label: 'cassette wobble and hiss, blended in' },
      reverb('Room', -12, 0.15),
      delay('Eighth echo', -20, 0.1),
    ],
  },
  {
    name: 'Trap auto-tune vocal',
    description: 'The hard-tuned trap sound: robotic pitch correction (set its key to the song’s), bright and compressed, a wide double and ping-pong echoes.',
    steps: [
      { pluginId: TUNE, preset: 'Hard tune robot (A minor)', label: 'auto-tune (A minor, instant: set the key to your song’s)' },
      {
        pluginId: EQ_PRO,
        params: eqBands({
          1: { type: 'lowCut24', freq: 110 },
          3: { type: 'bell', freq: 300, gain: -2, q: 1.2 },
          6: { type: 'bell', freq: 3500, gain: 2, q: 1 },
          7: { type: 'highShelf', freq: 11000, gain: 3 },
        }),
        label: 'EQ (110 Hz low cut, less mud, presence at 3.5 kHz, air above 11 kHz)',
      },
      {
        pluginId: COMPRESSOR,
        params: { threshold: -24, ratio: 4, knee: 4, attack: 2, release: 90, makeup: 2 },
        label: 'compressor (4:1, fast)',
      },
      { pluginId: DE_ESSER, preset: 'Bright vocal', label: 'de-esser (bright vocal)' },
      { pluginId: SATURATOR, preset: 'Tube glow', params: { mix: 0.3 }, label: 'tube warmth, blended in' },
      { pluginId: DOUBLER, preset: 'Wide pop', params: { level: -12 }, label: 'a wide double' },
      delay('Dotted ping-pong', -16, 0.12),
      reverb('Plate', -14, 0.12),
    ],
  },
  {
    name: 'Podcast voice',
    description: 'Clear speech: a gentle gate for room noise, warm and present EQ, even compression, a wideband de-esser and a safety limiter.',
    steps: [
      {
        pluginId: GATE,
        preset: 'Hush the noise floor',
        params: { threshold: -50, range: -12, attack: 2, hold: 100, release: 250 },
        label: 'gentle gate (hushes room noise between words)',
      },
      {
        pluginId: EQ_PRO,
        params: eqBands({
          1: { type: 'lowCut24', freq: 80 },
          3: { type: 'bell', freq: 250, gain: -3, q: 1.2 },
          5: { type: 'bell', freq: 4000, gain: 2.5, q: 1 },
          7: { type: 'highShelf', freq: 10000, gain: 1.5 },
        }),
        label: 'EQ (80 Hz low cut, less boom at 250 Hz, clarity at 4 kHz)',
      },
      {
        pluginId: COMPRESSOR,
        params: { threshold: -22, ratio: 3, knee: 6, attack: 8, release: 120, makeup: 2 },
        label: 'compressor (3:1, even speech)',
      },
      { pluginId: DE_ESSER, preset: 'Podcast voice (wideband)', label: 'de-esser (wideband)' },
      { pluginId: LIMITER, preset: 'Transparent safety −0.3 dB', label: 'safety limiter (−0.3 dB)' },
    ],
  },
];
