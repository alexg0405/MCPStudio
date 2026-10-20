/** Read tools for what has been measured or found: the reference song, loudness, sung pitch, vocal cleanup, what Convert to MIDI would write and the sample library. */
import { SAMPLE_CATEGORIES } from '@core/samples/types';
import { cleanupReport } from '../../cleanup/report';
import { alignReport } from '../../align/report';
import { conversionReport } from '../../transcribe/report';
import { loudnessFacts } from '../../metering/facts';
import { pitchReport } from '../../pitch/report';
import { referenceReport } from '../../reference/summary';
import { listSamples, SAMPLE_SORTS } from '../../samples/listing';
import * as S from '../schema/parts';
import { projectOf, tool } from './tool';

export const getReference = tool(
  'get_reference',
  'The reference song (a song the musician owns that their song should be shaped after): its measured tempo, key, sections with bar counts and energy, loudness, true peak, tonal balance per band and stereo width, next to the musician’s song (tempo, key, sections), what an arrangement like the reference would be at the song’s tempo, and the last tonal comparison of the mix with it. Only measurements: no notes or audio of the reference exist here.',
  {},
  (services) => referenceReport(projectOf(services)),
);

export const getLoudness = tool(
  'get_loudness',
  'Loudness and stereo of the master: the live readings of the Meters (momentary, short-term and integrated loudness in LUFS since the song started playing, loudness range, true peak, stereo correlation and mono loss; the first call opens a meter, so play the song and read again), the loudness target the song aims for (reference song, style or streaming), and the last loudness report (integrated LUFS, range, true peak and bar positions, what streaming services do). The loudness_report action makes a new report offline.',
  {},
  (services) => loudnessFacts(services),
);

export const getPitch = tool(
  'get_pitch',
  'The sung notes of a recorded audio clip, as the Pitch editor shows them: per note its number (1-based, what the pitch action takes), bar, start/end seconds, pitch (MIDI and note name), how many cents off the nearest note, whether it is in the song key, drift and vibrato measured, and what has been changed (target, shift, flattened drift, vibrato %); also which sound the musician hears (the A/B switch: hearing). The first look at a clip it listens first (state "analyzing": ask again in a moment).',
  { clip: S.str('An audio clip id (clip_…; default: the selected audio clip).') },
  (services, args) => pitchReport(services, args),
);

export const getCleanup = tool(
  'get_cleanup',
  'The vocal cleanup of a recorded audio clip, as the Clean up vocal window shows it: which parts are on (noise reduction in dB and where the noise was learned from, breath reduction and the breaths found with their numbers, bar and seconds and whether each is lowered, mouth-click removal), whether the cleaned sound is ready, and which sound the musician hears (the before/after switch: hearing). The breaths are found when the cleaned sound is made.',
  { clip: S.str('An audio clip id (clip_…; default: the selected audio clip).') },
  (services, args) => cleanupReport(services, args),
);

export const getAlignment = tool(
  'get_alignment',
  'Vocal alignment of recorded audio clips (doubles, backing vocals and ad-libs lined up with a lead, or tightened to the grid): for each aligned clip its id, track and bar, the mode (guide or grid), the guide clip, tightness, pitch alignment % or grid strength, the state (ready, rendering with progress, out of date, problem with the reason), how far the sound was moved (median and largest move in ms) and which sound the musician hears (the A/B switch: hearing). Without clip it lists every aligned clip. The align_clips and tighten_timing actions set it; the aligned audio is made in the background.',
  { clip: S.str('An audio clip id (clip_…); default: every aligned clip.') },
  (services, args) => alignReport(services, args),
);

export const getMidiConversion = tool(
  'get_midi_conversion',
  'The notes "Convert to MIDI" (the audio_to_midi action) would write for an audio clip, before anything is made: per note its number, bar and beat, key (and the note name, or for drums which drum), velocity and length in beats, plus a short summary (how many notes or hits, the range, the swing found), the chords found for mode chords, and which pads would play sounds cut from the recording. The first look at a clip with these settings it listens first (state "analyzing": ask again in a moment). Takes the same settings as the action: mode (melody, drums, chords, bass; auto uses what the sound suggests), quantize, strength, swing, sensitivity…',
  {
    clip: S.str('An audio clip id (clip_…; default: the selected audio clip).'),
    mode: { type: 'string', enum: ['auto', 'melody', 'drums', 'chords', 'bass'], description: 'What to read (default auto).' },
    quantize: S.str('The grid: "off", "1/32", "1/16t", "1/16" (default), "1/8t", "1/8" or "1/4".'),
    strength: S.num('Quantize strength 0–100 % (default 100).'),
    swing: { type: 'string', enum: ['straighten', 'keep'], description: 'straighten (default) or keep the recording’s swing.' },
    sensitivity: S.num('0–100 % (default 50).'),
    articulation: { type: 'string', enum: ['natural', 'legato', 'staccato'], description: 'Melody and bass: how notes end.' },
    legato_gap_ms: S.num('Legato: gaps shorter than this many ms are closed (default 150).'),
    keep_cents: S.bool('Melody and bass: keep the cents as fine pitch.'),
    chord_resolution: { type: 'string', enum: ['beat', 'half', 'bar'], description: 'Chords: how often to read a chord.' },
    chord_rhythm: { type: 'string', enum: ['hold', 'beats', 'offbeats', 'eighths'], description: 'Chords: how they are played.' },
    chord_bass: S.bool('Chords: add the root as a low note.'),
  },
  (services, args) => conversionReport(services, args),
);

export const listSampleSounds = tool(
  'list_samples',
  'The sounds in the musician’s sample folders (the Sample browser window), each with what the analysis found: type (kick, snare, clap, hat, open-hat, cymbal, tom, perc, 808, fx, vocal, tonal, or loop / long), the confidence of a one-shot’s type, a loop’s tempo and bars, the key of a loop or the note of a one-shot, length, loudness and brightness, favorites and the musician’s tags. Filters like the window’s; ids, paths and file names are what place_sample and make_kit take. Also says how many files there are, how far the analysis is, and the song’s tempo and key to match against.',
  {
    text: S.str(
      'Words that must all appear in the name, folder, type, tempo, key or tags ("kick", "128 bpm", "a minor"); -word leaves matches out.',
    ),
    category: { type: 'string', enum: [...SAMPLE_CATEGORIES], description: 'Only one-shots of this type.' },
    kind: { type: 'string', enum: ['one-shot', 'loop'], description: 'Only one-shots or only loops.' },
    bpm_min: S.num('Loops from this tempo.'),
    bpm_max: S.num('Loops up to this tempo.'),
    half_double: S.bool('With bpm_min / bpm_max: also loops at half or double those tempos.'),
    key: S.str('Sounds in this key or note: "A", "C#", "A minor" (a note alone matches both modes).'),
    in_song_key: S.bool('Only sounds whose note or key fits the song key.'),
    favorites: S.bool('Only the starred sounds.'),
    recent: S.bool('Only sounds the musician used lately.'),
    tag: S.str('Only sounds with this tag of the musician’s.'),
    folder: S.str('Only this folder or subfolder (Folder or Folder/Sub, as the paths show).'),
    similar_to: S.str('The sounds nearest to this one (its id, path or name), closest first.'),
    sort: { type: 'string', enum: [...SAMPLE_SORTS], description: 'Order (default name).' },
    descending: S.bool('Reverse the order.'),
    limit: S.int('How many to list (default 40, at most 200).'),
  },
  (services, args) => {
    const { transport } = projectOf(services);
    return listSamples(services.sampleBrowser, args, { bpm: transport.bpm, key: transport.key });
  },
);
