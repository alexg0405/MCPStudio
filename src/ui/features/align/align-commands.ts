/** The commands of vocal alignment: open the Align window, align clips to a guide, tighten them to the grid, remove it, A/B. */
import type { Services } from '@app/services';
import { alignClips, audioClipsAmong, hearUnaligned, removeAlignment, selectedAudioClips, tightenClips, type AlignResult } from '@app/actions/align';
import { alignState } from '@app/align/state';
import { DEFAULT_GRID_STEP_TICKS, GRID_STEPS } from '@core/audio/align/edit';
import type { ClipId } from '@core/model/types';
import { openWindow } from '../../workspace/registry';

/** The window type of the Align window. */
export const ALIGN_WINDOW = 'vocal-align';

const NO_CLIP = 'Select an audio clip on the playlist first (right-click it, then Align to guide…).';

/** The clip ids a command was given (`{ clips: [...] }` or `{ clip }`), or the selected audio clips. */
export function clipsFor(s: Services, args: unknown): ClipId[] {
  const given = args && typeof args === 'object' ? (args as { clips?: unknown; clip?: unknown }) : {};
  const ids = Array.isArray(given.clips) ? given.clips : typeof given.clip === 'string' ? [given.clip] : [];
  const named = audioClipsAmong(s.doc.getState().project, ids.filter((id): id is ClipId => typeof id === 'string'));
  return (named.length ? named : selectedAudioClips(s)).map((c) => c.id);
}

/** A number from a command argument (null when it is not one). */
function numberArg(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** The grid step in ticks of a command argument ("1/16"), or the default. */
function stepArg(v: unknown): number {
  if (typeof v !== 'string') return DEFAULT_GRID_STEP_TICKS;
  const hit = GRID_STEPS.find((g) => g.label.split(' ')[0] === v.trim());
  return hit ? hit.ticks : DEFAULT_GRID_STEP_TICKS;
}

/** Says what a request did in a toast: how many clips, and the reason for each that was left out. */
export function tellResult(s: Services, result: AlignResult, what: string): void {
  const say = s.session.getState().toast;
  if (result.aligned.length === 0) {
    say(result.skipped[0]?.reason ?? 'There is no audio clip to work on.', 'error');
    return;
  }
  const n = result.aligned.length;
  say(`${what} ${n} clip${n === 1 ? '' : 's'}: the aligned sound is being made and plays when it is ready.`);
  for (const skipped of result.skipped) say(skipped.reason, 'error');
}

/** Registers the commands. */
export function registerAlignCommands({ commands }: Services): void {
  commands.register<{ clip?: string } | string>({
    id: 'align.open',
    title: 'Align vocals…',
    category: 'Audio clip',
    hint: 'Opens the Align window for the selected audio clips: make doubles, backing vocals and ad-libs follow a lead (timing and pitch), or tighten a vocal to the grid',
    argsHint: 'optional { clip: id } or the clip id (default: the selected audio clips)',
    run: (s, args) => {
      const given = typeof args === 'string' ? args : args?.clip;
      const project = s.doc.getState().project;
      const named = typeof given === 'string' ? audioClipsAmong(project, [given as ClipId])[0] : undefined;
      if (!named && selectedAudioClips(s).length === 0) {
        s.session.getState().toast(NO_CLIP);
      }
      alignState.setState({ windowClip: named ? named.id : null });
      openWindow(s, ALIGN_WINDOW);
    },
  });
  commands.register<{ guide?: string; clips?: string[]; tightness?: number; pitch?: number }>({
    id: 'align.apply',
    title: 'Align audio clips to a guide clip',
    category: 'Audio clip',
    hint: 'Moves the syllables of the selected audio clips (doubles, backing vocals) onto the timing of a lead clip, and with Pitch above 0 pulls their pitch towards the lead too; the audio is made in the background (one undo step)',
    argsHint:
      '{ guide: id of the lead audio clip, clips?: [audio clip ids] (default: the selected audio clips), tightness?: 0-100 (0 = only big offsets, 100 = syllable-tight; default 70), pitch?: 0-100 % of the pitch deviation to correct (default 0) }',
    run: (s, args) => {
      const clips = clipsFor(s, args);
      if (clips.length === 0) return void s.session.getState().toast(NO_CLIP);
      if (typeof args?.guide !== 'string') return void s.session.getState().toast('Say which clip is the lead: give guide (an audio clip id).', 'error');
      const tightness = numberArg(args.tightness);
      const pitch = numberArg(args.pitch);
      const result = alignClips(s, { clips, guide: args.guide as ClipId, ...(tightness !== undefined ? { tightness } : {}), ...(pitch !== undefined ? { pitch } : {}) });
      tellResult(s, result, 'Aligning');
    },
  });
  commands.register<{ clips?: string[]; clip?: string; strength?: number; grid?: string }>({
    id: 'align.tighten',
    title: 'Tighten the timing of audio clips to the grid',
    category: 'Audio clip',
    hint: 'Moves the syllable starts of the selected vocal clips towards the nearest grid line by a strength in % (consonants stay sharp, pitch is kept); one undo step',
    argsHint: "optional { clips?: [audio clip ids] or clip?: id (default: the selected audio clips), strength?: 0-100 % (default 80), grid?: '1/4' | '1/8' | '1/16' | '1/32' (default '1/16') }",
    run: (s, args) => {
      const clips = clipsFor(s, args);
      if (clips.length === 0) return void s.session.getState().toast(NO_CLIP);
      const strength = numberArg(args?.strength);
      const result = tightenClips(s, { clips, ...(strength !== undefined ? { strength } : {}), stepTicks: stepArg(args?.grid) });
      tellResult(s, result, 'Tightening');
    },
  });
  commands.register<{ clips?: string[]; clip?: string }>({
    id: 'align.remove',
    title: 'Remove the alignment from audio clips',
    category: 'Audio clip',
    hint: 'Takes the alignment off the selected audio clips: they play their own recording again (one undo step)',
    argsHint: 'optional { clips?: [audio clip ids] or clip?: id } (default: the selected audio clips)',
    run: (s, args) => {
      const clips = clipsFor(s, args);
      const n = removeAlignment(s, clips);
      s.session.getState().toast(n ? `Removed the alignment from ${n} clip${n === 1 ? '' : 's'}.` : 'None of those clips is aligned.');
    },
  });
  commands.register<{ clip?: string; original?: boolean }>({
    id: 'align.toggleOriginal',
    title: 'Hear the original recording instead of the aligned sound (A/B)',
    category: 'Audio clip',
    hint: 'Switches an aligned clip between its aligned sound and the original recording, to compare; nothing in the project changes (goes back when the Align window is closed)',
    argsHint: 'optional { clip: id (default: the first selected aligned clip), original: true to hear the recording, false to hear the alignment (default: switch) }',
    run: (s, args) => {
      const project = s.doc.getState().project;
      const picked = clipsFor(s, args).find((id) => audioClipsAmong(project, [id])[0]?.align);
      if (!picked) return void s.session.getState().toast('Select an aligned clip first.');
      const original = hearUnaligned(s, picked, typeof args?.original === 'boolean' ? args.original : undefined);
      s.session.getState().setHint(original ? 'Hearing your original recording' : 'Hearing the aligned sound');
    },
  });
}
