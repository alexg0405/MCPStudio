/** The Pitch editor's commands: open a clip, play it, snap to the key, apply an action, compare A/B and clear. */
import type { Services } from '@app/services';
import { parseKey as parseKeyText } from '@app/ai/ops/values';
import {
  analyzeClip,
  applyPitchActionToClip,
  audioClipOf,
  clearClipPitch,
  defaultPitchClip,
  editFor,
  hearOriginal,
  loadPitchClip,
  parsePitchAction,
  pitchProblem,
  snapClip,
} from '@app/actions/pitch';
import { playFrom } from '@app/actions/transport';
import { pitchState } from '@app/pitch/state';
import { tempoMapOf } from '@core/automation/tempo';
import { isNeutralEdit } from '@core/audio/pitch-edit';
import { playbackMode, tickAtSourceSeconds } from '@core/audio/playback';
import type { ClipId } from '@core/model/types';
import { PITCH_NAMES, isScaleId } from '@agstudio/sdk/notes';
import { openWindow } from '../../workspace/registry';

/** The window type of the Pitch editor. */
export const PITCH_EDITOR_WINDOW = 'pitch-editor';

const NO_CLIP = 'Select an audio clip on the playlist first (right-click it, then Pitch editor).';

/** The clip id a command was given: `{ clip }` or a plain id string in its arguments. */
function clipGivenIn(args: unknown): unknown {
  if (typeof args === 'string') return args;
  if (args && typeof args === 'object') return (args as { clip?: unknown }).clip;
  return undefined;
}

/** The clip a command acts on: `{ clip }` / an id in its arguments, else the selected audio clip, else the one being edited. */
function targetClip(s: Services, args: unknown): ClipId | null {
  const project = s.doc.getState().project;
  const given = clipGivenIn(args);
  if (typeof given === 'string' && project.playlist.clips[given as ClipId]?.kind === 'audio') return given as ClipId;
  const picked = defaultPitchClip(s);
  if (picked) return picked;
  const open = pitchState.getState().clipId;
  return open && audioClipOf(project, open) ? open : null;
}

/** A tonic from a command's arguments: a note name ("A", "c#") or a number 0 to 11; -1 when it is neither. */
function rootArg(root: unknown): number {
  if (typeof root === 'number') return root;
  if (typeof root !== 'string') return -1;
  return PITCH_NAMES.findIndex((name) => name.toLowerCase() === root.toLowerCase());
}

/** A key from a command's arguments: "A minor", or { root: 'A' | 0–11, scale }; null for none or unreadable. */
function keyArg(v: unknown): { root: number; scale: string } | null {
  if (!v) return null;
  if (typeof v === 'string') return parseKeyText(v) ?? null;
  if (typeof v !== 'object') return null;
  const given = v as { root?: unknown; scale?: unknown };
  const root = rootArg(given.root);
  if (!Number.isFinite(root) || root < 0 || root > 11) return null;
  const scale = typeof given.scale === 'string' && isScaleId(given.scale) ? given.scale : 'major';
  return { root: Math.round(root), scale };
}

/** Shows a message in a toast and stops: the way these commands say "nothing to do". */
const tell = (s: Services, text: string, kind?: 'error') => s.session.getState().toast(text, kind);

/** Registers the Pitch editor's commands and the B key that switches between the corrected and original sound. */
export function registerPitchCommands({ commands, keymap }: Services): void {
  commands.register<{ clip?: string } | string>({
    id: 'pitchEditor.openClip',
    title: 'Pitch editor for the selected audio clip',
    category: 'Audio clip',
    hint: 'Opens the Pitch editor on the selected audio clip: find its sung notes and correct them (also Alt + double-click on a clip)',
    argsHint: 'optional { clip: id } or the clip id (default: the selected audio clip)',
    run: (s, args) => {
      const id = targetClip(s, args);
      if (!id) return tell(s, NO_CLIP);
      const problem = pitchProblem(s.doc.getState().project, id);
      if (problem) return tell(s, problem);
      void loadPitchClip(s, id);
      openWindow(s, PITCH_EDITOR_WINDOW);
    },
  });
  commands.register({
    id: 'pitchEditor.play',
    title: 'Play the clip being pitch-edited',
    category: 'Audio clip',
    hint: 'Plays the song from the selected note of the Pitch editor (or the start of its clip), so you hear the correction',
    run: (s) => {
      const st = pitchState.getState();
      const project = s.doc.getState().project;
      const found = st.clipId ? audioClipOf(project, st.clipId) : null;
      if (!found || !st.clip) return tell(s, NO_CLIP);
      const edit = editFor(project, st.clip);
      const first = st.selected.length ? edit.notes[Math.min(...st.selected)] : undefined;
      const tempo = tempoMapOf(project, 'song');
      const tick = first ? tickAtSourceSeconds(found.clip, playbackMode(found.channel), tempo, first.from) : found.clip.start;
      playFrom(s, Math.min(found.clip.start + found.clip.length - 1, Math.max(found.clip.start, tick)));
    },
  });
  commands.register<{ clip?: string; key?: string | { root?: number | string; scale?: string }; strength?: number }>({
    id: 'pitchEditor.snapToKey',
    title: 'Snap the pitch of an audio clip to the key',
    category: 'Audio clip',
    hint: 'Pulls every sung note of the selected audio clip to the nearest note of the song key (or a key you give), by a strength in %',
    argsHint: "optional { clip: id, key: 'A minor' | { root: 'A', scale: 'minor' } (default: the song key), strength: 0-100 (default 100) }",
    run: async (s, args) => {
      const id = targetClip(s, args);
      if (!id) return tell(s, NO_CLIP);
      const songKey = s.doc.getState().project.transport.key;
      const key = keyArg(args && typeof args === 'object' ? args.key : undefined) ?? (songKey ? { root: songKey.root, scale: songKey.scale } : null);
      if (!key) return tell(s, 'Set the song key first (piano roll, Key button), or say which key to use.');
      const strengthPercent = args && typeof args === 'object' && typeof args.strength === 'number' ? args.strength : 100;
      try {
        const clip = await analyzeClip(s, id);
        snapClip(s, clip, key, Math.max(0, Math.min(1, strengthPercent / 100)));
      } catch (e) {
        tell(s, e instanceof Error ? e.message : String(e), 'error');
      }
    },
  });
  commands.register<{ clip?: string; action?: string; key?: unknown; strength?: number; amount?: number; semitones?: number; to_midi?: number; ms?: number; notes?: number[] }>({
    id: 'pitchEditor.apply',
    title: 'Pitch correction of an audio clip: apply an action',
    category: 'Audio clip',
    hint: 'Changes the sung notes of an audio clip: snap to key, flatten drift, set vibrato, move notes, glide time, reset (one undo step)',
    argsHint:
      "{ action: 'snap_to_key' | 'flatten_drift' | 'vibrato' | 'shift' | 'transition' | 'reset', clip?: id (default: the selected audio clip), key?: 'A minor' (snap_to_key; default the song key), strength?: 0-100 % (snap_to_key, default 100), amount?: % (flatten_drift 0-100, default 100; vibrato 0-200, 100 = as sung, 0 = none), semitones?: n or to_midi?: MIDI note (shift), ms?: 0-300 (transition), notes?: [1-based note numbers, see get_pitch] (default: all notes) }",
    run: async (s, args) => {
      const id = targetClip(s, args);
      if (!id) return tell(s, NO_CLIP);
      const parsed = parsePitchAction({ ...args, key: keyArg(args?.key) }, s.doc.getState().project.transport.key);
      if ('error' in parsed) return tell(s, parsed.error, 'error');
      try {
        await applyPitchActionToClip(s, id, parsed.action, parsed.notes, parsed.label);
      } catch (e) {
        tell(s, e instanceof Error ? e.message : String(e), 'error');
      }
    },
  });
  commands.register<{ clip?: string; original?: boolean }>({
    id: 'pitchEditor.toggleOriginal',
    title: 'Pitch editor: hear the original or the corrected sound (A/B)',
    category: 'Audio clip',
    hint: 'Switches an audio clip between its corrected sound and its own recording so you can compare (B in the Pitch editor). Only what you hear changes: nothing in the project does, and it goes back to corrected when the clip is closed',
    argsHint: 'optional { clip: id (default: the clip in the Pitch editor, else the selected audio clip), original: true to hear the original, false for the corrected sound (default: switch) }',
    run: (s, args) => {
      // The clip in the editor first (that is the one being compared), then the usual choice.
      const open = pitchState.getState().clipId;
      const isClipGiven = args && typeof args === 'object' && typeof args.clip === 'string';
      const id = !isClipGiven && open && audioClipOf(s.doc.getState().project, open) ? open : targetClip(s, args);
      if (!id) return tell(s, NO_CLIP);
      const edit = audioClipOf(s.doc.getState().project, id)?.clip.pitchEdit;
      if (!edit || isNeutralEdit(edit)) return tell(s, 'This clip has no correction yet: change a note first, then compare.');
      const isOriginal = hearOriginal(s, id, typeof args?.original === 'boolean' ? args.original : undefined);
      s.session.getState().setHint(isOriginal ? 'Hearing the original recording (press B for the corrected sound)' : 'Hearing the corrected sound (press B for the original)');
    },
  });
  keymap.add([{ chord: 'B', command: 'pitchEditor.toggleOriginal', when: { focus: [PITCH_EDITOR_WINDOW] } }]);
  commands.register<{ clip?: string }>({
    id: 'pitchEditor.clear',
    title: 'Remove pitch correction from an audio clip',
    category: 'Audio clip',
    hint: 'The selected audio clip plays its own recording again (one undo step)',
    argsHint: 'optional { clip: id } (default: the selected audio clip)',
    run: (s, args) => {
      const id = targetClip(s, args);
      if (!id || !clearClipPitch(s, id)) tell(s, 'That clip has no pitch correction.');
    },
  });
}
