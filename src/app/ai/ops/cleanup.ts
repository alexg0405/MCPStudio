/**
 * Vocal cleanup of recorded audio clips (the Clean up vocal window's work): noise reduction, breath control and mouth-click
 * removal, set per clip in one go. The cleaned audio is made in the background after the edit (about a second per minute
 * of audio) and the clip plays it when it is ready; the original recording is kept and Undo restores it.
 */
import { current, isDraft } from 'immer';
import { applyCleanupRequest, describeCleanup, isNeutralCleanup, type CleanupRequest } from '@core/audio/cleanup-edit';
import type { AudioClip, ClipId, VocalCleanup } from '@core/model/types';
import { setCleanup } from '@core/ops/cleanup';
import { cleanupProblem } from '../../actions/cleanup';
import * as S from '../schema/parts';
import { fail, type OpModule } from './context';
import { bool, num } from './values';

const plain = (v: VocalCleanup): VocalCleanup => (isDraft(v) ? (current(v) as VocalCleanup) : v);

/** What the action asks for, as a request; null when it names nothing to change. */
function requestOf(action: Record<string, unknown>): CleanupRequest | null {
  const request: CleanupRequest = {};
  const noise = num(action.noise_db);
  if (noise !== undefined) request.noiseDb = noise;
  const noiseSensitivity = num(action.noise_sensitivity);
  if (noiseSensitivity !== undefined) request.noiseSensitivity = noiseSensitivity;
  const breaths = num(action.breaths_db);
  if (breaths !== undefined) request.breathsDb = breaths;
  const breathSensitivity = num(action.breath_sensitivity);
  if (breathSensitivity !== undefined) request.breathSensitivity = breathSensitivity;
  const clicks = bool(action.clicks);
  if (clicks !== undefined) request.clicks = clicks;
  const clickSensitivity = num(action.click_sensitivity);
  if (clickSensitivity !== undefined) request.clickSensitivity = clickSensitivity;
  return Object.keys(request).length ? request : null;
}

export const cleanup: OpModule = {
  schemas: [
    S.op(
      'clean_vocal',
      'Cleans up a recorded vocal (an audio clip): noise_db turns steady background noise (hiss, hum, room tone) down by that many dB (0 turns it off; 6–12 is natural, up to 30), breaths_db turns the breaths between phrases down (0 off, 6–12 is natural, 60 removes them), clicks removes mouth clicks and lip smacks. A field left out keeps that part as it is; a part switched on starts with its defaults (noise 12 dB, breaths 12 dB). The noise is learned from the quietest half second of the clip unless noise_from / noise_to (seconds into the recording) name a stretch with only the room sound. The clip is found by id, or by track + bar. The cleaned audio is made in the background and the original recording is kept; the pitch editor then works on the cleaned sound. clear removes the cleanup.',
      {
        clip: S.str('The audio clip id (clip_…).'),
        track: S.int('With bar: the 1-based track the clip is on.'),
        bar: S.num('With track: a 1-based bar where the clip plays.'),
        noise_db: S.num('Noise reduction in dB (0 off, default when switched on 12, at most 30).'),
        noise_sensitivity: S.num('How far above the noise a sound must rise to be kept, 0–100 % (default 50; higher cuts more noise but can dull soft consonants).'),
        noise_from: S.num('Seconds into the recording where a stretch with only the room sound starts (with noise_to, at least 0.1 s).'),
        noise_to: S.num('Seconds into the recording where that stretch ends.'),
        breaths_db: S.num('Breath reduction in dB (0 off, default when switched on 12, 60 or more removes them).'),
        breath_sensitivity: S.num('How many breaths are found, 0–100 % (default 50; higher finds shorter and louder ones too).'),
        clicks: S.bool('Remove mouth clicks (true) or leave them (false).'),
        click_sensitivity: S.num('How small a click still counts, 0–100 % (default 50).'),
        clear: S.bool('true removes the whole cleanup from the clip (the recording plays again).'),
      },
      [],
    ),
  ],
  prompt: {
    id: 'cleanup',
    order: 17,
    text: `Vocal cleanup: the clean_vocal action cleans a recorded vocal (an audio clip). Look first with get_cleanup (what is on, the breaths found, whether the cleaned sound is ready). "Get rid of the background noise" is noise_db 12 (more for a loud fan, up to 20); "the breaths are too loud" is breaths_db 10 (60 removes them, which can sound unnatural between phrases); "remove the mouth clicks" is clicks true. The cleaned audio is rendered in the background, so say it will be ready in a moment; Undo restores the earlier sound. The pitch action works on the cleaned sound.`,
  },
  handlers: {
    clean_vocal: (action, context) => {
      const found = context.clip(action);
      if (found.kind !== 'audio') return fail('only audio clips (a recorded vocal) can be cleaned up');
      const clip = found as AudioClip;
      const id = clip.id as ClipId;
      const problem = cleanupProblem(context.base, id);
      if (problem) return fail(problem);
      context.focus.clip(id, 'clean_vocal');
      const channel = context.project.channels[clip.channelId];
      const name = channel ? `“${channel.name}”` : 'the clip';
      if (bool(action.clear) === true) {
        setCleanup(context.draft, id, null);
        context.touch(clip.start, clip.start + clip.length, [id]);
        return `Removed the vocal cleanup from ${name}`;
      }
      const request = requestOf(action);
      const from = num(action.noise_from);
      const to = num(action.noise_to);
      if (!request && from === undefined) return fail('say what to clean: noise_db, breaths_db, clicks (or clear)');
      if ((from === undefined) !== (to === undefined)) return fail('noise_from and noise_to go together (seconds into the recording)');
      if (from !== undefined && to !== undefined && !(to - from >= 0.1)) return fail('the noise stretch needs at least 0.1 seconds between noise_from and noise_to');
      const own = (context.draft.playlist.clips[id] as AudioClip | undefined)?.cleanup;
      let next: VocalCleanup = applyCleanupRequest(own ? plain(own as VocalCleanup) : undefined, request ?? { noiseDb: 12 });
      if (from !== undefined && to !== undefined && next.noise) next = { ...next, noise: { ...next.noise, from, to } };
      if (isNeutralCleanup(next)) {
        setCleanup(context.draft, id, null);
        context.touch(clip.start, clip.start + clip.length, [id]);
        return `Switched everything off for ${name}`;
      }
      setCleanup(context.draft, id, next);
      context.touch(clip.start, clip.start + clip.length, [id]);
      return `${name}: ${describeCleanup(next)}`;
    },
  },
};
