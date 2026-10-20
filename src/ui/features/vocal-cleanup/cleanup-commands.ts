/** The Clean up vocal commands: open the window on a clip, change a clip's cleanup, compare before and after, remove it. */
import type { Services } from '@app/services';
import {
  changeCleanup,
  cleanupOf,
  cleanupProblem,
  clearClipCleanup,
  defaultCleanupClip,
  hearRemoved,
  hearUncleaned,
  learnNoiseAutomatically,
  learnNoiseFrom,
  loopRegionInSample,
  renderCleanupNow,
  stopHearingRemoved,
} from '@app/actions/cleanup';
import { audioClipOf } from '@app/actions/pitch-clip';
import { cleanupState } from '@app/cleanup/state';
import type { CleanupRequest } from '@core/audio/cleanup-edit';
import type { ClipId } from '@core/model/types';
import { openWindow } from '../../workspace/registry';

/** The window type of the Clean up vocal window. */
export const CLEANUP_WINDOW = 'vocal-cleanup';

const NO_CLIP = 'Select an audio clip on the playlist first (right-click it, then Clean up vocal).';

/** The clip id a command was given: `{ clip }` or a plain id string in its arguments. */
function clipGivenIn(args: unknown): unknown {
  if (typeof args === 'string') return args;
  if (args && typeof args === 'object') return (args as { clip?: unknown }).clip;
  return undefined;
}

/** The clip a command acts on: `{ clip }` / an id in its arguments, else the selected audio clip, else the one in the window. */
export function targetClip(s: Services, args: unknown): ClipId | null {
  const project = s.doc.getState().project;
  const given = clipGivenIn(args);
  if (typeof given === 'string' && project.playlist.clips[given as ClipId]?.kind === 'audio') return given as ClipId;
  const picked = defaultCleanupClip(s);
  if (picked) return picked;
  const open = cleanupState.getState().clipId;
  return open && audioClipOf(project, open) ? open : null;
}

/** Shows a message in a toast and stops: the way these commands say "nothing to do". */
const tell = (s: Services, text: string, kind?: 'error') => s.session.getState().toast(text, kind);

/** The arguments of `cleanup.apply`, named as the AI's `clean_vocal` names them. */
interface ApplyArgs {
  clip?: string;
  noise_db?: number;
  noise_sensitivity?: number;
  breaths_db?: number;
  breath_sensitivity?: number;
  clicks?: boolean;
  click_sensitivity?: number;
  noise_from?: number;
  noise_to?: number;
}

/** What `cleanup.apply` asks for as a request (fields not given are left out). */
function requestFrom(args: ApplyArgs): CleanupRequest {
  const request: CleanupRequest = {};
  if (typeof args.noise_db === 'number') request.noiseDb = args.noise_db;
  if (typeof args.noise_sensitivity === 'number') request.noiseSensitivity = args.noise_sensitivity;
  if (typeof args.breaths_db === 'number') request.breathsDb = args.breaths_db;
  if (typeof args.breath_sensitivity === 'number') request.breathSensitivity = args.breath_sensitivity;
  if (typeof args.clicks === 'boolean') request.clicks = args.clicks;
  if (typeof args.click_sensitivity === 'number') request.clickSensitivity = args.click_sensitivity;
  return request;
}

/** Registers the Clean up vocal commands. */
export function registerCleanupCommands({ commands }: Services): void {
  commands.register<{ clip?: string } | string>({
    id: 'cleanup.openClip',
    title: 'Clean up vocal for the selected audio clip',
    category: 'Audio clip',
    hint: 'Opens the Clean up vocal window on the selected audio clip: take out background noise, tone down breaths and remove lip smacks, with a before/after listen',
    argsHint: 'optional { clip: id } or the clip id (default: the selected audio clip)',
    run: (s, args) => {
      const id = targetClip(s, args);
      if (!id) return tell(s, NO_CLIP);
      const problem = cleanupProblem(s.doc.getState().project, id);
      if (problem) return tell(s, problem);
      cleanupState.setState({ clipId: id });
      openWindow(s, CLEANUP_WINDOW);
    },
  });
  commands.register<ApplyArgs>({
    id: 'cleanup.apply',
    title: 'Clean up an audio clip: noise, breaths and lip smacks',
    category: 'Audio clip',
    hint: 'Sets the vocal cleanup of an audio clip: noise reduction in dB, breath reduction in dB (60 removes them), lip-smack removal (one undo step; the cleaned audio is made in the background)',
    argsHint:
      'optional { clip?: id (default: the selected audio clip), noise_db?: 0-30 (0 off), noise_sensitivity?: 0-100 %, breaths_db?: 0-60 (0 off, 60 removes them), breath_sensitivity?: 0-100 %, clicks?: true | false, click_sensitivity?: 0-100 %, noise_from?: seconds, noise_to?: seconds (a stretch of the recording with only the room sound) }',
    run: (s, args) => {
      const id = targetClip(s, args);
      if (!id) return tell(s, NO_CLIP);
      const problem = cleanupProblem(s.doc.getState().project, id);
      if (problem) return tell(s, problem, 'error');
      const request = requestFrom(args ?? {});
      const hasStretch = typeof args?.noise_from === 'number' && typeof args?.noise_to === 'number';
      if (!Object.keys(request).length && !hasStretch) return tell(s, 'Say what to clean: noise_db, breaths_db or clicks.', 'error');
      if (Object.keys(request).length) changeCleanup(s, id, request);
      if (hasStretch) {
        const problemText = learnNoiseFrom(s, id, args.noise_from as number, args.noise_to as number);
        if (problemText) tell(s, problemText, 'error');
      }
    },
  });
  commands.register<{ clip?: string; original?: boolean }>({
    id: 'cleanup.toggleOriginal',
    title: 'Clean up vocal: hear the original or the cleaned sound (A/B)',
    category: 'Audio clip',
    hint: 'Switches an audio clip between its cleaned sound and your recording as recorded, so you can compare. Only what you hear changes: nothing in the project does, and it goes back to the cleaned sound when the window is closed',
    argsHint: 'optional { clip: id (default: the clip in the Clean up vocal window, else the selected audio clip), original: true to hear the recording, false for the cleaned sound (default: switch) }',
    run: (s, args) => {
      const open = cleanupState.getState().clipId;
      const isClipGiven = args && typeof args === 'object' && typeof args.clip === 'string';
      const id = !isClipGiven && open && audioClipOf(s.doc.getState().project, open) ? open : targetClip(s, args);
      if (!id) return tell(s, NO_CLIP);
      if (!cleanupOf(s.doc.getState().project, id)) return tell(s, 'This clip has no cleanup yet: switch something on first, then compare.');
      const isOriginal = hearUncleaned(s, id, typeof args?.original === 'boolean' ? args.original : undefined);
      s.session.getState().setHint(isOriginal ? 'Hearing your recording as recorded (switch back to hear the cleaned sound)' : 'Hearing the cleaned sound');
    },
  });
  commands.register<{ clip?: string; on?: boolean }>({
    id: 'cleanup.hearRemoved',
    title: 'Clean up vocal: hear what was removed',
    category: 'Audio clip',
    hint: 'Plays only what the cleanup took out of the clip (the noise, breaths and lip smacks), so you can check that no voice went with it',
    argsHint: 'optional { clip: id (default: the clip in the Clean up vocal window), on: false stops it }',
    run: async (s, args) => {
      if (args?.on === false) return stopHearingRemoved(s);
      const open = cleanupState.getState().clipId;
      const id = typeof args?.clip === 'string' ? targetClip(s, args) : (open ?? targetClip(s, args));
      if (!id) return tell(s, NO_CLIP);
      const problem = await hearRemoved(s, id);
      if (problem) tell(s, problem);
    },
  });
  commands.register<{ clip?: string; from?: number; to?: number; source?: 'loop' | 'auto' }>({
    id: 'cleanup.learnNoise',
    title: 'Clean up vocal: choose where the noise is learned from',
    category: 'Audio clip',
    hint: 'Tells the noise reduction which part of the clip has only the room sound: the loop region of the song, a stretch in seconds, or (auto) the quietest half second',
    argsHint: "optional { clip: id, source: 'loop' (the song's loop region over the clip) | 'auto' (the quietest half second), or from: seconds, to: seconds into the recording }",
    run: (s, args) => {
      const id = targetClip(s, args);
      if (!id) return tell(s, NO_CLIP);
      if (args?.source === 'auto') {
        if (!learnNoiseAutomatically(s, id)) tell(s, 'Noise reduction is not on for this clip.');
        return;
      }
      const stretch = args?.source === 'loop' ? loopRegionInSample(s, id) : typeof args?.from === 'number' && typeof args?.to === 'number' ? { from: args.from, to: args.to } : null;
      if (!stretch) return tell(s, 'Set a loop region over a quiet part of the clip first (drag in the playlist ruler), or give from and to in seconds.');
      const problem = learnNoiseFrom(s, id, stretch.from, stretch.to);
      if (problem) tell(s, problem, 'error');
    },
  });
  commands.register<{ clip?: string }>({
    id: 'cleanup.renderNow',
    title: 'Clean up vocal: make the cleaned sound now',
    category: 'Audio clip',
    hint: 'Makes the cleaned audio right away instead of waiting for the short pause after a change (use it after a failed render)',
    argsHint: 'optional { clip: id } (default: the clip in the Clean up vocal window, else the selected audio clip)',
    run: (s, args) => {
      const open = cleanupState.getState().clipId;
      const id = typeof args?.clip === 'string' ? targetClip(s, args) : (open ?? targetClip(s, args));
      if (!id) return tell(s, NO_CLIP);
      if (!cleanupOf(s.doc.getState().project, id)) return tell(s, 'This clip has no cleanup yet.');
      renderCleanupNow(id);
    },
  });
  commands.register<{ clip?: string }>({
    id: 'cleanup.clear',
    title: 'Remove the vocal cleanup from an audio clip',
    category: 'Audio clip',
    hint: 'The selected audio clip plays its own recording again (one undo step)',
    argsHint: 'optional { clip: id } (default: the selected audio clip)',
    run: (s, args) => {
      const id = targetClip(s, args);
      if (!id || !clearClipCleanup(s, id)) tell(s, 'That clip has no vocal cleanup.');
    },
  });
}
