/**
 * Actions on the app itself rather than the project: `settings` (preferences and editor settings), `select`
 * (what the editors and commands act on: channel, mixer track, pattern, clips, notes, the loop region) and
 * `save_preset`. They change stores that are not part of the document, so they make no undo step; they run
 * right after the edit (an answer can write notes and then select them) and report in `AppliedTurn.ui`.
 */
import type { Draft } from 'immer';
import type { Project } from '@core/model/types';
import type { Services } from '../../../services';
import { PIANO_ROLL_TOOLS, PLAYLIST_TOOLS } from '../../../stores/editor';
import type { AiAnswer } from '../../schema';
import * as S from '../../schema/parts';
import { ActionError, createOpContext, type AnswerState, type OpModule } from '../context';
import type { SessionOutput } from './output';
import { applySavePreset } from './save-preset';
import { applySelect } from './select';
import { applySettings, AUDIO_BUFFERS, RECORD_GRIDS, SCOPES, SNAPS } from './settings';

export { AUDIO_BUFFERS, RECORD_GRIDS };

const EDITOR_FIELDS = (tools: readonly string[], what: string) => ({
  type: 'object',
  description: `${what}.`,
  additionalProperties: false,
  properties: {
    tool: { type: 'string', enum: [...tools] },
    snap: { type: 'string', enum: [...SNAPS], description: 'Grid to snap to.' },
    ...(what === 'Piano roll'
      ? {
          scale_snap: S.bool('Drawn notes stay in the key’s scale.'),
          scale_highlight: S.bool('Shade rows outside the key’s scale.'),
        }
      : {}),
  },
});

export const session: OpModule = {
  schemas: [
    S.op(
      'settings',
      'App settings (not the project); only what you list changes. Applied after the edits, not undoable.',
      {
        metronome: S.bool('Metronome.'),
        count_in_bars: S.int('Count-in bars before recording (0–4).'),
        record_mode: { type: 'string', enum: ['overdub', 'replace'] },
        record_quantize: {
          type: 'string',
          enum: Object.keys(RECORD_GRIDS),
          description: 'Grid recorded notes snap to.',
        },
        record_notes: S.bool('Record notes and knob moves.'),
        record_audio: S.bool('Record audio from the input.'),
        follow_playhead: S.bool('Scroll with the playhead.'),
        tooltips: S.bool('Hover hints.'),
        typing_piano: S.bool('Computer keys play notes.'),
        piano_octave: S.int('Typing keyboard octave (0–9; 5 = middle C).'),
        midi_input: S.bool('MIDI keyboards.'),
        audio_buffer: {
          type: 'string',
          enum: [...AUDIO_BUFFERS],
          description:
            'Auto (default) is the fastest that plays smoothly; large plays smoothest, small answers fastest live.',
        },
        sample_memory_mb: S.int('Decoded-audio memory in MB (256–16384).'),
        scope: { type: 'string', enum: [...SCOPES], description: 'Toolbar display.' },
        input_channels: { type: 'string', enum: ['mono', 'stereo'], description: 'Audio input.' },
        input_track: { ...S.INSERT, description: 'Mixer track the audio input records and monitors through.' },
        monitor: S.bool('Hear the input while recording (headphones!).'),
        latency_offset_ms: S.num('Recording latency correction, ms (−200…200).'),
        export: {
          type: 'object',
          description: 'Export defaults.',
          additionalProperties: false,
          properties: {
            codec: { type: 'string', enum: ['wav', 'flac', 'mp3'] },
            bits: S.int('16, 24 (WAV also 32 float).'),
            sample_rate: S.int('44100, 48000 or 96000.'),
            mp3_kbps: S.int('128, 192, 256 or 320.'),
            normalize: S.bool('Normalize.'),
            stems: S.bool('Stems.'),
            master_chain: S.bool('Stems through the master chain.'),
            stems_to: { type: 'string', enum: ['folder', 'zip'] },
          },
        },
        piano_roll: EDITOR_FIELDS(PIANO_ROLL_TOOLS, 'Piano roll'),
        playlist: EDITOR_FIELDS(PLAYLIST_TOOLS, 'Playlist'),
      },
    ),
    S.op(
      'select',
      'Selects what the editors and commands act on, applied after the edits. Then run a command (copy, transpose, delete…) on it.',
      {
        channel: S.CHANNEL,
        insert: S.INSERT,
        pattern: S.PATTERN,
        clips: {
          type: 'object',
          description: 'Playlist clips: ids, or those on a track and/or touching bars.',
          additionalProperties: false,
          properties: {
            ids: { type: 'array', items: { type: 'string' } },
            track: S.int('1-based playlist track.'),
            from_bar: S.int('1-based first bar.'),
            to_bar: S.int('1-based last bar (inclusive).'),
            all: S.bool('Every clip.'),
          },
        },
        notes: {
          type: 'object',
          description:
            'Piano-roll notes of a channel (default: the selected one) in a pattern, within bars and keys (default all).',
          additionalProperties: false,
          properties: {
            pattern: S.PATTERN,
            channel: S.CHANNEL,
            from_bar: S.int('1-based first bar.'),
            to_bar: S.int('1-based last bar (inclusive).'),
            from_key: S.int('Lowest MIDI key.'),
            to_key: S.int('Highest MIDI key.'),
          },
        },
        loop: {
          type: 'object',
          description: 'The loop region: bars, or a marker’s section.',
          additionalProperties: false,
          properties: {
            from_bar: S.int('1-based first bar.'),
            to_bar: S.int('1-based last bar (inclusive).'),
            section: S.str('A marker name: its span to the next marker.'),
          },
        },
        clear: { type: 'string', enum: ['clips', 'notes', 'loop', 'all'], description: 'Clear that selection.' },
      },
    ),
    S.op(
      'save_preset',
      'Saves a channel’s or effect’s settings as the musician’s own preset (same name replaces); load it later with preset.',
      { channel: S.CHANNEL, effect: S.EFFECT, name: S.str('The preset’s name.') },
      ['name'],
    ),
  ],
  prompt: {
    id: 'session',
    order: 40,
    text: `App settings and selection: settings changes preferences (metronome, count-in, record mode, follow playhead, tooltips, audio buffer, input, export defaults, the editors' tool and grid), not the project. select picks what commands act on: channel, mixer track, pattern, clips (by id, track or bars), notes, the loop region. Selection-based commands (pianoRoll.transpose, playlist.copy, channels.delete, audioClip.*) act on it. open also closes, focuses or maximizes a window. Neither of these is undoable.`,
  },
  handlers: {},
};

/** The names of the actions here (they run after the edit, not inside it). */
export const SESSION_OP_NAMES: readonly string[] = session.schemas.map((o) => o.properties.op.const);

/** Runs the answer's settings, selection and preset actions (after its edits are committed). */
export function sessionAfter(services: Services, answer: AiAnswer, state: AnswerState): void {
  const wanted = answer.actions.filter((action) => SESSION_OP_NAMES.includes(action.op));
  if (!wanted.length) return;
  const draftOfCommitted = services.doc.getState().project as unknown as Draft<Project>;
  const context = createOpContext(services, draftOfCommitted, answer, { previousBeat: null }, state);
  for (const action of wanted) {
    const label = action.op.replace(/_/g, ' ');
    const out: SessionOutput = { ui: state.ui, warn: (message) => state.warnings.push(`${label}: ${message}`) };
    try {
      if (action.op === 'settings') applySettings(services, action, context, out);
      else if (action.op === 'select') applySelect(services, action, context, out);
      else if (action.op === 'save_preset') applySavePreset(services, action, context, out);
    } catch (error) {
      if (error instanceof ActionError) out.warn(error.message);
      else throw error;
    }
  }
}
