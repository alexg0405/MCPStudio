/**
 * The words of a request, for guessing which plugins and commands it needs (`predict.ts`): the little words that tell
 * nothing, and what producers call things that the plugins and commands name differently ("grunge" is distortion, "pump" is
 * a sidechain). These add to the action search's own synonyms (`core/search/rank.ts`).
 *
 * A missed guess costs a read tool call, not a wrong answer, so these lean towards including a plugin rather than
 * leaving it out.
 */
import { SYNONYMS, type Synonyms } from '@core/search/rank';

/** Words that say nothing about which plugin or command is needed. */
export const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    'a an the and or but so then also to of in on at for with without from into onto by as is are was were be been it its it\'s ' +
    'this that these those there here some any all more less most much many very really just only too quite bit little lot lots ' +
    'i me my mine we us our you your yours please can could would should will want wanna need like love ' +
    'make makes making made add adds adding put puts give gives set sets get gets let lets do does doing done use using try ' +
    'turn change changes changed bring take keep go going how what which when where why not no yes ' +
    'one two three another other same now again still up down out off over under about around ' +
    'song track beat part parts thing things stuff sound sounds'
  ).split(/\s+/),
);

/**
 * Producer words mapped to the words the catalog uses. Each key is one lower-case word of a request; the values are
 * words that appear in plugin names, categories and descriptions, or in command titles and ids.
 */
const PRODUCER_WORDS: Synonyms = {
  // Character and grit.
  grunge: ['distortion', 'saturator', 'lo-fi', 'crushed', 'grit'],
  grungy: ['distortion', 'saturator', 'lo-fi', 'crushed', 'grit'],
  gritty: ['distortion', 'saturator', 'grit'],
  dirty: ['distortion', 'saturator', 'lo-fi', 'grit'],
  crunch: ['distortion', 'saturator', 'grit'],
  crunchy: ['distortion', 'saturator', 'grit'],
  fuzz: ['distortion', 'saturator'],
  fuzzy: ['distortion', 'saturator'],
  overdrive: ['distortion', 'saturator'],
  drive: ['distortion', 'saturator'],
  distorted: ['distortion', 'saturator'],
  saturate: ['saturator', 'distortion'],
  saturation: ['saturator', 'distortion'],
  bitcrush: ['lo-fi', 'distortion', 'crushed'],
  lofi: ['lo-fi', 'tape', 'vinyl'],
  lo: ['lo-fi'],
  vinyl: ['lo-fi', 'crackle'],
  tape: ['lo-fi', 'saturator', 'stutter'],
  dusty: ['lo-fi', 'vinyl', 'crackle'],
  old: ['lo-fi', 'vinyl'],
  warm: ['saturator', 'lo-fi', 'eq', 'warmth'],
  warmer: ['saturator', 'lo-fi', 'eq', 'warmth'],
  warmth: ['saturator', 'lo-fi', 'tape'],
  dark: ['filter', 'eq', 'lo-fi', 'low-pass', 'dull'],
  darker: ['filter', 'eq', 'lo-fi', 'low-pass', 'dull'],
  muffled: ['filter', 'low-pass', 'eq'],
  // Space and time.
  reverb: ['reverb', 'room', 'hall', 'plate'],
  room: ['reverb'],
  hall: ['reverb'],
  plate: ['reverb'],
  space: ['reverb', 'delay'],
  spacey: ['reverb', 'delay'],
  ambient: ['reverb', 'pad', 'delay'],
  ambience: ['reverb'],
  cathedral: ['reverb'],
  church: ['reverb'],
  chamber: ['reverb'],
  echo: ['delay', 'echo'],
  echoes: ['delay', 'echo'],
  echoey: ['delay', 'reverb'],
  slapback: ['delay'],
  // Dynamics.
  sidechain: ['ducker', 'compressor', 'sidechain', 'duck', 'pump'],
  sidechained: ['ducker', 'compressor', 'sidechain'],
  duck: ['ducker', 'sidechain'],
  ducking: ['ducker', 'sidechain'],
  pump: ['ducker', 'sidechain'],
  pumping: ['ducker', 'sidechain'],
  compress: ['compressor', 'multiband', 'transient'],
  compressed: ['compressor', 'multiband'],
  compression: ['compressor', 'multiband'],
  punchy: ['transient', 'compressor', 'punch'],
  punchier: ['transient', 'compressor', 'punch'],
  punch: ['transient', 'compressor'],
  snap: ['transient'],
  glue: ['compressor', 'multiband'],
  squash: ['compressor', 'limiter', 'maximizer'],
  limiter: ['limiter', 'maximizer'],
  loudness: ['limiter', 'maximizer', 'loudness', 'meters', 'level'],
  louder: ['limiter', 'maximizer', 'volume', 'level'],
  loud: ['limiter', 'maximizer', 'volume'],
  master: ['limiter', 'maximizer', 'loudness', 'eq'],
  mastering: ['limiter', 'maximizer', 'loudness', 'eq'],
  gate: ['gate'],
  tighten: ['gate', 'transient', 'quantize'],
  tighter: ['gate', 'transient', 'quantize'],
  // Tone.
  eq: ['eq', 'equalizer'],
  equalizer: ['eq'],
  bright: ['eq', 'filter', 'high'],
  brighter: ['eq', 'filter', 'high'],
  muddy: ['eq', 'multiband', 'filter'],
  mud: ['eq', 'multiband', 'filter'],
  boomy: ['eq', 'multiband', 'filter'],
  hz: ['eq', 'filter'],
  frequency: ['eq', 'filter'],
  frequencies: ['eq', 'filter'],
  lows: ['eq', 'multiband', 'filter'],
  mids: ['eq', 'filter'],
  highs: ['eq', 'filter', 'multiband'],
  treble: ['eq', 'filter'],
  thin: ['eq', 'saturator'],
  harsh: ['eq', 'de-esser', 'multiband', 'filter'],
  filter: ['filter', 'low-pass', 'high-pass', 'cutoff'],
  sweep: ['filter', 'automation'],
  lowpass: ['filter', 'low-pass'],
  highpass: ['filter', 'high-pass'],
  cutoff: ['filter'],
  // Movement.
  wide: ['stereo', 'chorus', 'doubler', 'width'],
  wider: ['stereo', 'chorus', 'doubler', 'width'],
  widen: ['stereo', 'chorus', 'doubler', 'width'],
  stereo: ['stereo', 'width'],
  width: ['stereo'],
  chorus: ['chorus', 'detuned'],
  flange: ['flanger'],
  flanger: ['flanger'],
  phase: ['phaser', 'stereo'],
  phaser: ['phaser'],
  wobble: ['chorus', 'flanger', 'phaser', 'lo-fi', 'lfo'],
  swirl: ['phaser', 'flanger'],
  stutter: ['stutter', 'beat repeat', 'gates'],
  glitch: ['stutter', 'granular'],
  chop: ['slicer', 'stutter', 'granular'],
  chopped: ['slicer', 'stutter', 'granular'],
  slice: ['slicer'],
  // Voices.
  vocal: ['vocal', 'voice', 'tune', 'de-esser', 'harmonizer', 'doubler', 'denoise'],
  vocals: ['vocal', 'voice', 'tune', 'de-esser', 'harmonizer', 'doubler', 'denoise'],
  voice: ['voice', 'vocal', 'tune', 'harmonizer'],
  singer: ['voice', 'tune', 'harmonizer', 'doubler'],
  sing: ['voice', 'tune', 'harmonizer'],
  singing: ['voice', 'tune', 'harmonizer'],
  harmony: ['harmonizer', 'harmonies', 'chords'],
  harmonies: ['harmonizer', 'harmonies', 'harmony', 'voices'],
  harmonize: ['harmonizer', 'harmonies'],
  backing: ['harmonizer', 'harmonies', 'doubler'],
  double: ['doubler', 'doubles'],
  doubles: ['doubler', 'align'],
  autotune: ['tune', 'pitch'],
  pitch: ['tune', 'pitch'],
  robotic: ['tune', 'vocoder'],
  robot: ['vocoder', 'tune'],
  talk: ['vocoder'],
  talking: ['vocoder'],
  vocoder: ['vocoder'],
  sibilance: ['de-esser'],
  sibilant: ['de-esser'],
  hiss: ['denoise', 'noise'],
  hum: ['denoise', 'noise'],
  noise: ['denoise', 'noise', 'cleanup'],
  noisy: ['denoise', 'noise', 'cleanup'],
  breaths: ['cleanup', 'clean'],
  clean: ['cleanup', 'denoise', 'tidy'],
  // Instruments.
  bass: ['bass', '808', 'sub'],
  sub: ['bass', '808'],
  808: ['808', 'bass'],
  lead: ['synth', 'wavetable', '3xosc', 'lead'],
  pad: ['pad', 'wavetable', '3xosc', 'granular', 'reverb'],
  lush: ['pad', 'reverb', 'chorus', 'wavetable'],
  pluck: ['pluck', 'string'],
  plucky: ['pluck', 'string'],
  guitar: ['pluck', 'string'],
  bell: ['fm', 'bells'],
  bells: ['fm', 'bells'],
  keys: ['fm', 'wavetable', 'piano'],
  piano: ['fm', 'keys'],
  organ: ['fm', 'organs'],
  brass: ['fm', 'brass'],
  drums: ['drum', 'kit', 'sampler'],
  kick: ['drum', 'kick', 'sampler'],
  snare: ['drum', 'snare', 'sampler'],
  hats: ['drum', 'hat', 'sampler'],
  hat: ['drum', 'hat', 'sampler'],
  clap: ['drum', 'clap', 'sampler'],
  percussion: ['drum', 'perc'],
  sample: ['sampler', 'slicer', 'granular', 'sample'],
  samples: ['sampler', 'slicer', 'granular', 'sample'],
  loop: ['slicer', 'sampler', 'granular', 'loop'],
  texture: ['granular', 'texture'],
  grain: ['granular'],
  granular: ['granular'],
  wavetable: ['wavetable'],
  supersaw: ['wavetable', '3xosc', 'unison'],
  fm: ['fm'],
  synth: ['synth', 'wavetable', '3xosc', 'fm'],
  // Notes and music theory.
  chord: ['chords', 'chord'],
  chords: ['chords', 'chord'],
  progression: ['chords', 'progression'],
  arpeggio: ['arpeggiate', 'arpeggiator', 'arp'],
  arp: ['arpeggiate', 'arpeggiator'],
  arpeggiate: ['arpeggiate', 'arpeggiator'],
  arpeggiator: ['arpeggiator', 'arpeggiate', 'arp'],
  roll: ['repeat', 'roll'],
  strum: ['strum'],
  humanize: ['humanize'],
  swing: ['quantize', 'swing'],
  quantize: ['quantize'],
  transpose: ['transpose'],
  scale: ['scale', 'snap'],
  legato: ['legato'],
  velocity: ['velocity'],
  melody: ['melody', 'generate', 'notes', 'piano roll'],
  // The app.
  clip: ['clip', 'audio clip'],
  launcher: ['launcher'],
  mp3: ['export', 'mp3'],
  flac: ['export'],
  stems: ['export', 'stems'],
  midi: ['midi', 'export', 'import'],
  analyzer: ['analyzer', 'meters'],
  spectrum: ['analyzer', 'meters', 'visualizer'],
  lyrics: ['lyrics'],
  marker: ['marker', 'playlist'],
  markers: ['marker', 'playlist'],
  undo: ['undo'],
  redo: ['redo'],
  save: ['save'],
  metronome: ['metronome', 'click', 'count-in'],
  tempo: ['tempo', 'bpm', 'tap'],
  record: ['record', 'recording'],
  recording: ['record', 'recording'],
  mixer: ['mixer'],
  playlist: ['playlist'],
};

/** What a request word may also mean: the action search's synonyms, then the producer words (these win a clash). */
const BASE_SYNONYMS: Synonyms = { ...SYNONYMS, ...PRODUCER_WORDS };

/** The shortest stem worth matching ("tun" from "tuned" would match too much). */
const MIN_STEM_LENGTH = 4;

/** "flanged" and "doubled" are the Flanger and the Doubler: the word without its ending, when that is long enough. */
function stemOf(word: string): string | null {
  const stem = word.replace(/(ing|ed|es|er|s)$/, '');
  return stem !== word && stem.length >= MIN_STEM_LENGTH ? stem : null;
}

/** The synonyms to match these request words with: the table, plus each word's stem. */
export function synonymsFor(words: readonly string[]): Synonyms {
  const expanded: Record<string, readonly string[]> = { ...BASE_SYNONYMS };
  for (const word of words) {
    const stem = stemOf(word);
    if (stem) expanded[word] = [...(BASE_SYNONYMS[word] ?? []), stem];
  }
  return expanded;
}

/** The words of a request that can say what is needed: lower case, without the little words. */
export function requestWords(request: string): string[] {
  const words = request
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-z0-9-]+/)
    .map((word) => word.replace(/^-+|-+$/g, ''))
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
  return [...new Set(words)];
}
