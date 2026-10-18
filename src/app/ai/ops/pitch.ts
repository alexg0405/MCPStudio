/**
 * Pitch correction of recorded audio clips (the Pitch editor's work): pull a sung line to the song key
 * with a strength, flatten pitch drift, set the vibrato, move notes, set the glide, reset or remove it.
 * Notes are the ones `get_pitch` lists (1-based). The corrected audio is made in the background after
 * the edit (a few seconds per minute of audio); the clip plays it when it is ready.
 */
import { current, isDraft } from 'immer';
import { tempoMapOf } from '@core/automation/tempo';
import { playbackMode, tickAtSourceSeconds } from '@core/audio/playback';
import { applyPitchAction } from '@core/audio/pitch-edit';
import type { AudioClip, ClipId, PitchEdit, Project } from '@core/model/types';
import { setPitchEdit } from '@core/ops/pitch';
import { PITCH_ACTION_NAMES, parsePitchAction, pitchEditOf, pitchProblem } from '../../actions/pitch';
import * as S from '../schema/parts';
import { fail, type OpModule } from './context';
import { num, str, parseKey } from './values';

const plain = (v: PitchEdit): PitchEdit => (isDraft(v) ? (current(v) as PitchEdit) : v);

export const pitch: OpModule = {
  schemas: [
    S.op(
      'pitch',
      'Corrects the pitch of a recorded audio clip (a sung vocal or one melody line; not chords or drums). snap_to_key pulls every sung note to the nearest note of a key (default: the song key) by strength %; flatten_drift takes the slow wandering out of notes; vibrato sets how much vibrato is kept (0 removes it, 100 leaves it, 200 doubles it); shift moves notes by semitones or to a MIDI note; transition sets the glide time in ms (0 = hard tune); reset puts notes back as sung; clear removes the correction. The clip is found by id, or by track + bar. The corrected audio is made in the background and the original recording is kept.',
      {
        action: { type: 'string', enum: [...PITCH_ACTION_NAMES, 'clear'] },
        clip: S.str('The audio clip id (clip_…).'),
        track: S.int('With bar: the 1-based track the clip is on.'),
        bar: S.num('With track: a 1-based bar where the clip plays.'),
        key: S.str('snap_to_key: the key, e.g. "A minor" or "F# dorian" (default: the song key).'),
        strength: S.num('snap_to_key: 0–100 %, how far notes are pulled (default 100; 50 keeps some of the human feel).'),
        amount: S.num('flatten_drift: 0–100 % (default 100). vibrato: 0–200 % (100 = as sung, 0 = none).'),
        semitones: S.num('shift: move the notes by this many semitones (negative = down).'),
        to_midi: S.num('shift: move the notes to this MIDI note number (60 = middle C).'),
        ms: S.num('transition: glide time in ms, 0–300.'),
        notes: { type: 'array', items: { type: 'integer' }, description: 'Only these notes (1-based numbers from get_pitch). Default: all notes.' },
        from_bar: S.num('Only notes starting from this 1-based bar (with to_bar).'),
        to_bar: S.num('Only notes starting up to and including this bar.'),
      },
      ['action'],
    ),
  ],
  prompt: {
    id: 'pitch',
    order: 16,
    text: `Pitch correction: the pitch action tunes a recorded vocal (an audio clip of one voice or melody line). Look first with get_pitch (the notes it found: number, bar, pitch, how far off, drift, vibrato). "Tune it to the key" is snap_to_key (strength 100 = robotic hard tune, 40–70 keeps a natural feel); "less wobble" is flatten_drift; "remove the vibrato" is vibrato with amount 0; one note too sharp is shift on that note's number. The corrected audio is rendered in the background, so say it will be ready in a moment; Undo restores the earlier sound. It only works on forwards audio (not Reverse).`,
  },
  handlers: {
    pitch: (action, context) => {
      const found = context.clip(action);
      if (found.kind !== 'audio') return fail('only audio clips (a recorded vocal) can be pitch-corrected');
      const clip = found as AudioClip;
      const id = clip.id as ClipId;
      const problem = pitchProblem(context.base, id);
      if (problem) return fail(problem);
      context.focus.clip(id, 'pitch');
      const channel = context.project.channels[clip.channelId];
      const name = channel ? `“${channel.name}”` : 'the clip';
      const subAction = str(action.action);
      if (subAction === 'clear') {
        setPitchEdit(context.draft, id, null);
        context.touch(clip.start, clip.start + clip.length, [id]);
        return `Removed the pitch correction from ${name}`;
      }
      const keyText = str(action.key);
      const key = keyText ? parseKey(keyText) : undefined;
      if (keyText && !key) return fail(`unreadable key "${keyText}" (say e.g. "A minor")`);
      const parsed = parsePitchAction(
        {
          action: subAction,
          key,
          strength: action.strength,
          amount: action.amount,
          semitones: action.semitones,
          to_midi: action.to_midi,
          ms: action.ms,
          notes: action.notes,
        },
        context.base.transport.key,
      );
      if ('error' in parsed) return fail(parsed.error);

      const own = (context.draft.playlist.clips[id] as AudioClip | undefined)?.pitchEdit;
      const edit: PitchEdit | null = own ? plain(own as PitchEdit) : pitchEditOf(context.base, id);
      const fromBar = num(action.from_bar);
      if (!edit) {
        // Not analysed yet: the app listens to the clip, then makes the same change (its own undo step).
        context.state.after.push({
          kind: 'command',
          id: 'pitchEditor.apply',
          args: {
            clip: id,
            action: subAction,
            ...(keyText ? { key: keyText } : {}),
            ...(action.strength !== undefined ? { strength: action.strength } : {}),
            ...(action.amount !== undefined ? { amount: action.amount } : {}),
            ...(action.semitones !== undefined ? { semitones: action.semitones } : {}),
            ...(action.to_midi !== undefined ? { to_midi: action.to_midi } : {}),
            ...(action.ms !== undefined ? { ms: action.ms } : {}),
            ...(Array.isArray(action.notes) ? { notes: action.notes } : {}),
          },
          gesture: false,
        });
        return `Listening to ${name} to find its notes, then: ${parsed.label}`;
      }
      let which: Set<number> | 'all' = parsed.notes;
      if (fromBar !== undefined) {
        const toBar = num(action.to_bar) ?? fromBar;
        const project: Project = context.base;
        const barTicks = context.bar();
        const tempo = tempoMapOf(project, 'song');
        const mode = channel?.kind === 'audioClip' ? playbackMode(channel) : playbackMode({});
        const inRange = new Set<number>();
        edit.notes.forEach((n, i) => {
          const bar = tickAtSourceSeconds(clip, mode, tempo, n.from) / barTicks + 1;
          if (bar >= fromBar - 1e-6 && bar < toBar + 1) inRange.add(i);
        });
        which = which === 'all' ? inRange : new Set([...which].filter((i) => inRange.has(i)));
        if (which.size === 0) return fail(`no notes start in bars ${fromBar}–${toBar} of that clip`);
      }
      if (which !== 'all') {
        const bad = [...which].filter((i) => i >= edit.notes.length);
        if (bad.length === edit.notes.length || (which.size > 0 && bad.length === which.size)) return fail(`that clip has ${edit.notes.length} notes (numbered from 1)`);
        which = new Set([...which].filter((i) => i < edit.notes.length));
      }
      const next = applyPitchAction(edit, parsed.action, which);
      setPitchEdit(context.draft, id, next);
      context.touch(clip.start, clip.start + clip.length, [id]);
      return `${name}: ${parsed.label.replace(/^./, (m) => m.toLowerCase())}`;
    },
  },
};

