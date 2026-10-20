/**
 * Convert to MIDI (`audio_to_midi`): turns an audio clip into notes in a new pattern. Listening to the audio takes a moment, so
 * the handler checks the request and queues the app command (`audioToMidi.convert`) as an after-step of the answer, which makes
 * the channel, pattern, notes and playlist clip as one undo step of its own. `get_midi_conversion` reads what it would make.
 */
import { MODE_LABELS, TRANSCRIBE_MODES, type TranscribeMode } from '@core/audio/transcribe';
import type { AudioClip, ClipId } from '@core/model/types';
import { namedMode, specParts } from '../../transcribe/args';
import { sourceProblem } from '../../transcribe/source';
import * as S from '../schema/parts';
import { fail, type OpModule } from './context';

/** The request fields the action passes on to the command (the command checks them again, with the settings in hand). */
const PASSED = [
  'mode',
  'quantize',
  'strength',
  'swing',
  'sensitivity',
  'articulation',
  'legato_gap_ms',
  'keep_cents',
  'target',
  'instrument',
  'place',
  'mute_original',
  'slice_pads',
  'fill_chord_track',
  'chord_resolution',
  'chord_rhythm',
  'chord_bass',
] as const;

export const audioToMidi: OpModule = {
  schemas: [
    S.op(
      'audio_to_midi',
      'Turns an audio clip (a sung line, a drum loop, chords, a bass line) into MIDI notes in a new pattern, placed on the playlist under the audio. The clip is found by id, or by track + bar. mode: "melody" (one note at a time: a voice or lead; pitch, timing and loudness become notes), "drums" (kick, snare, clap, hats, toms and cymbals on the General MIDI drum keys; with a new channel it is Drum Pads playing hits cut from the recording itself), "chords" (a chord per beat from the harmony, voiced as notes; fill_chord_track also puts them on the chord track), "bass" (the lowest line of a mixed loop), or "auto" / left out (chosen from the sound). The notes land by the clip\'s own tempo follow and trim. quantize is the grid ("off", "1/32", "1/16t", "1/16", "1/8t", "1/8", "1/4"; default "1/16") with strength 0–100 % and swing "straighten" or "keep" (the recording\'s own swing in the notes). sensitivity 0–100 % (default 50) finds quieter sounds. target: "new" (default, with a suitable instrument; instrument is a plugin id) or the name or id of an existing instrument channel. One undo step; look first with get_midi_conversion.',
      {
        clip: S.str('The audio clip id (clip_…).'),
        track: S.int('With bar: the 1-based track the clip is on.'),
        bar: S.num('With track: a 1-based bar where the clip plays.'),
        mode: { type: 'string', enum: ['auto', ...TRANSCRIBE_MODES], description: 'What to read: melody, drums, chords, bass, or auto (from the sound).' },
        quantize: S.str('The grid: "off", "1/32", "1/16t", "1/16" (default), "1/8t", "1/8" or "1/4".'),
        strength: S.num('Quantize strength 0–100 % (default 100): how far notes move to the grid.'),
        swing: { type: 'string', enum: ['straighten', 'keep'], description: 'straighten (default) puts notes on straight lines; keep writes the recording’s own swing.' },
        sensitivity: S.num('0–100 % (default 50): how much is picked up; higher finds quieter and shorter sounds.'),
        articulation: { type: 'string', enum: ['natural', 'legato', 'staccato'], description: 'Melody and bass: how notes end (default natural).' },
        legato_gap_ms: S.num('Legato: gaps shorter than this many ms are closed (default 150).'),
        keep_cents: S.bool('Melody and bass: keep each note’s cents as its fine pitch.'),
        target: S.str('"new" (default) or an instrument channel (id or exact name) to write the notes to.'),
        instrument: S.str('For a new channel: the plugin id of its instrument (default: Drum Pads for drums, Pluck for melody, FM for chords, 3xOsc for bass).'),
        place: S.bool('Place a pattern clip under the audio clip (default true).'),
        mute_original: S.bool('Mute the audio clip so only the notes play (default false).'),
        slice_pads: S.bool('Drums on a new channel: cut the recording’s own hits into the pads (default true).'),
        fill_chord_track: S.bool('Chords: also put the chords on the chord track (default true).'),
        chord_resolution: { type: 'string', enum: ['beat', 'half', 'bar'], description: 'Chords: how often to read a chord (default beat).' },
        chord_rhythm: { type: 'string', enum: ['hold', 'beats', 'offbeats', 'eighths'], description: 'Chords: how they are played (default hold).' },
        chord_bass: S.bool('Chords: add the root as a low note.'),
      },
      [],
    ),
  ],
  prompt: {
    id: 'audio-to-midi',
    order: 18,
    text: `Convert to MIDI: audio_to_midi turns an audio clip into notes ("make this vocal into MIDI" is mode melody, "get the drums out of this loop" mode drums, "what chords are these" mode chords with fill_chord_track, "write out the bass" mode bass). Leave mode out and it picks from the sound. Look first with get_midi_conversion for the notes it would write (it answers "analyzing" the first time: ask again in a moment). Keep quantize at 1/16 unless the part is triplets or free; strength below 100 keeps some of the human feel; swing "keep" for a swung groove. Drums on a new channel use the hits cut from the recording on Drum Pads. It listens in the background, so say the pattern will appear in a moment; Undo removes the pattern, the channel and the clip together.`,
  },
  handlers: {
    audio_to_midi: (action, context) => {
      const clip = context.clip(action);
      if (clip.kind !== 'audio') return fail('only an audio clip can be converted to MIDI');
      const problem = sourceProblem(context.base, clip.id as ClipId);
      if (problem) return fail(problem);
      const args: Record<string, unknown> = { clip: clip.id };
      for (const name of PASSED) if (action[name] !== undefined) args[name] = action[name];
      try {
        // Every field is checked now (mode, grid, channel, instrument), so a bad request is an error of the answer, not a toast later.
        specParts(context.services, args, namedMode(action.mode) ?? 'melody');
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
      context.focus.clip(clip.id as ClipId, 'audio to MIDI');
      context.state.after.push({ kind: 'command', id: 'audioToMidi.convert', args: { ...args, mode: action.mode ?? 'auto' }, gesture: false });
      const channel = context.project.channels[(clip as AudioClip).channelId];
      const mode = typeof action.mode === 'string' && action.mode !== 'auto' ? MODE_LABELS[action.mode as TranscribeMode].label.toLowerCase() : 'a mode that fits the sound';
      return `Converting “${channel?.name ?? 'the clip'}” to MIDI as ${mode}; the pattern appears in a moment`;
    },
  },
};
