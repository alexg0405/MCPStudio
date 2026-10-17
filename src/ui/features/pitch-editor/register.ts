import type { Services } from '@app/services';
import {
  analyzeClip,
  applyPitchActionToClip,
  audioClipOf,
  clearClipPitch,
  defaultPitchClip,
  editFor,
  loadPitchClip,
  parsePitchAction,
  pitchProblem,
  snapClip,
  startPitchRenderer,
} from '@app/actions/pitch';
import { playFrom } from '@app/actions/transport';
import { pitchState } from '@app/pitch/state';
import { tempoMapOf } from '@core/automation/tempo';
import { playbackMode, tickAtSourceSeconds } from '@core/audio/playback';
import type { ClipId } from '@core/model/types';
import { parseKey as parseKeyText } from '@app/ai/ops/values';
import { PITCH_NAMES, isScaleId } from '@agstudio/sdk/notes';
import { addContextMenuItems } from '../../context-menus';
import { addMenuItems, cmd } from '../../shell/menus';
import { lazyWindow } from '../../workspace/lazy';
import { openWindow, registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { setWindowHelp } from '../../workspace/window-help';

const WINDOW = 'pitch-editor';

/** The clip a command acts on: `{ clip }` / an id in its arguments, else the selected audio clip, else the one being edited. */
function targetClip(s: Services, args: unknown): ClipId | null {
  const p = s.doc.getState().project;
  const given = typeof args === 'string' ? args : args && typeof args === 'object' ? (args as { clip?: unknown }).clip : undefined;
  if (typeof given === 'string' && p.playlist.clips[given as ClipId]?.kind === 'audio') return given as ClipId;
  const picked = defaultPitchClip(s);
  if (picked) return picked;
  const open = pitchState.getState().clipId;
  return open && audioClipOf(p, open) ? open : null;
}

const NO_CLIP = 'Select an audio clip on the playlist first (right-click it, then Pitch editor).';

/** A key from a command's arguments: "A minor", or { root: 'A' | 0–11, scale }; null for none or unreadable. */
function keyArg(v: unknown): { root: number; scale: string } | null {
  if (!v) return null;
  if (typeof v === 'string') return parseKeyText(v) ?? null;
  if (typeof v !== 'object') return null;
  const o = v as { root?: unknown; scale?: unknown };
  const root = typeof o.root === 'number' ? o.root : typeof o.root === 'string' ? PITCH_NAMES.findIndex((n) => n.toLowerCase() === (o.root as string).toLowerCase()) : -1;
  if (!Number.isFinite(root) || root < 0 || root > 11) return null;
  return { root: Math.round(root), scale: typeof o.scale === 'string' && isScaleId(o.scale) ? o.scale : 'major' };
}

/**
 * The Pitch editor: a piano grid of the notes found in a recorded clip, with the sung pitch line.
 * Drag notes to retune them, snap them all to the key, flatten drift, tame vibrato; the corrected
 * audio is made in the background and the clip plays it (app/actions/pitch.ts).
 */
export function register(services: Services): void {
  registerWindowType({
    type: WINDOW,
    title: () => 'Pitch editor',
    component: lazyWindow(() => import('./PitchEditor'), (m) => m.PitchEditor),
    defaultRect: (ws) => ({ x: 70, y: 52, w: Math.min(980, Math.max(560, ws.w - 140)), h: Math.min(560, Math.max(340, ws.h - 110)) }),
    minSize: { w: 520, h: 280 },
  });
  registerWindowToggle(services, {
    command: 'pitchEditor.open',
    type: WINDOW,
    title: 'Pitch editor',
    hint: 'Correct the pitch of a sung audio clip note by note: snap to the key, retune notes, flatten drift, tame vibrato',
    chords: ['Alt+Shift+P'],
    menuOrder: 31,
  });
  setWindowHelp(WINDOW, {
    intro:
      'Shows the notes sung in an audio clip (blobs on a piano grid, with the pitch line as sung) so you can correct them. The corrected sound is made in the background and the clip plays it; your recording stays untouched.',
    moves: [
      ['Drag a note up or down', 'retunes it to the nearest semitone (hold Alt to move it by cents)'],
      ['Click / Shift+click / drag a box', 'selects notes; the sliders then act on the selection'],
      ['Snap all to key', 'pulls every note to the notes of the key (Strength sets how far)'],
      ['Drift / Vibrato sliders', 'flatten a note’s slow wandering, or scale its vibrato (0 % removes it)'],
      ['Transition slider', 'how fast the pitch glides to its new note (0 = hard tune)'],
      ['Split tool, S, M', 'cut a note in two where you click; M joins it with the next'],
      ['Right-click', 'a menu for the note: split, merge, snap, octave, reset'],
      ['Wheel / Ctrl+wheel / Alt+wheel', 'scroll, zoom in time, zoom the rows'],
      ['Delete', 'puts the selected notes back as sung'],
    ],
  });

  const { commands } = services;
  commands.register<{ clip?: string } | string>({
    id: 'pitchEditor.openClip',
    title: 'Pitch editor for the selected audio clip',
    category: 'Audio clip',
    hint: 'Opens the Pitch editor on the selected audio clip: find its sung notes and correct them (also Alt + double-click on a clip)',
    argsHint: 'optional { clip: id } or the clip id (default: the selected audio clip)',
    run: (s, args) => {
      const id = targetClip(s, args);
      if (!id) {
        s.session.getState().toast(NO_CLIP);
        return;
      }
      const problem = pitchProblem(s.doc.getState().project, id);
      if (problem) {
        s.session.getState().toast(problem);
        return;
      }
      void loadPitchClip(s, id);
      openWindow(s, WINDOW);
    },
  });
  commands.register({
    id: 'pitchEditor.play',
    title: 'Play the clip being pitch-edited',
    category: 'Audio clip',
    hint: 'Plays the song from the selected note of the Pitch editor (or the start of its clip), so you hear the correction',
    run: (s) => {
      const st = pitchState.getState();
      const p = s.doc.getState().project;
      const found = st.clipId ? audioClipOf(p, st.clipId) : null;
      if (!found || !st.clip) {
        s.session.getState().toast(NO_CLIP);
        return;
      }
      const edit = editFor(p, st.clip);
      const first = st.selected.length ? edit.notes[Math.min(...st.selected)] : undefined;
      const tempo = tempoMapOf(p, 'song');
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
      if (!id) {
        s.session.getState().toast(NO_CLIP);
        return;
      }
      const p = s.doc.getState().project;
      const key = keyArg(args && typeof args === 'object' ? args.key : undefined) ?? (p.transport.key ? { root: p.transport.key.root, scale: p.transport.key.scale } : null);
      if (!key) {
        s.session.getState().toast('Set the song key first (piano roll, Key button), or say which key to use.');
        return;
      }
      const pct = args && typeof args === 'object' && typeof args.strength === 'number' ? args.strength : 100;
      try {
        const clip = await analyzeClip(s, id);
        snapClip(s, clip, key, Math.max(0, Math.min(1, pct / 100)));
      } catch (e) {
        s.session.getState().toast(e instanceof Error ? e.message : String(e), 'error');
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
      if (!id) {
        s.session.getState().toast(NO_CLIP);
        return;
      }
      const parsed = parsePitchAction({ ...args, key: keyArg(args?.key) }, s.doc.getState().project.transport.key);
      if ('error' in parsed) {
        s.session.getState().toast(parsed.error, 'error');
        return;
      }
      try {
        await applyPitchActionToClip(s, id, parsed.action, parsed.notes, parsed.label);
      } catch (e) {
        s.session.getState().toast(e instanceof Error ? e.message : String(e), 'error');
      }
    },
  });
  commands.register<{ clip?: string }>({
    id: 'pitchEditor.clear',
    title: 'Remove pitch correction from an audio clip',
    category: 'Audio clip',
    hint: 'The selected audio clip plays its own recording again (one undo step)',
    argsHint: 'optional { clip: id } (default: the selected audio clip)',
    run: (s, args) => {
      const id = targetClip(s, args);
      if (!id || !clearClipPitch(s, id)) s.session.getState().toast('That clip has no pitch correction.');
    },
  });

  // Right-click an audio clip, the Playlist menu, and Alt + double-click (the playlist calls the command).
  addContextMenuItems('playlist.clip', ({ clip }, s) =>
    clip.kind === 'audio'
      ? [
          {
            label: 'Pitch editor…',
            hint: 'Find the sung notes of this clip and correct their pitch (snap to the key, retune notes, flatten drift, tame vibrato)',
            onSelect: () => void s.commands.run('pitchEditor.openClip', { clip: clip.id }),
          },
        ]
      : [],
  );
  addMenuItems('playlist', [cmd('pitchEditor.openClip', 33)]);

  // The renderer that keeps the corrected audio up to date (created once, here).
  startPitchRenderer(services);
  // A new project, or a clip that is gone: the editor shows nothing rather than a ghost.
  services.history.onChange((change) => {
    const id = pitchState.getState().clipId;
    if (id && !change.next.playlist.clips[id]) pitchState.setState({ clipId: null, clip: null, phase: 'none', selected: [], message: '' });
  });
}
