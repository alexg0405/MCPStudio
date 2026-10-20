/**
 * What the AI (and the MCP server) can read about a clip's vocal cleanup: which sections are on and how, the breaths found
 * (with the numbers the Clean up vocal window shows), and whether the cleaned sound is ready. Synchronous.
 */
import { tempoMapOf } from '@core/automation/tempo';
import { BREATH_REMOVE_DB, describeCleanup, isRenderCurrent } from '@core/audio/cleanup-edit';
import { playbackMode, tickAtSourceSeconds } from '@core/audio/playback';
import type { AudioClip, ClipId } from '@core/model/types';
import { ticksPerBar } from '@core/time/ppq';
import { audioClipOf } from '../actions/pitch-clip';
import { cleanupProblem } from '../actions/cleanup';
import type { Services } from '../services';
import { cleanupState } from './state';

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** The clip a read means: the one given, else the selected audio clip, else the only one with a cleanup, else the only audio clip. */
function pick(s: Services, given: unknown): { id: ClipId } | { error: string } {
  const p = s.doc.getState().project;
  const audio = Object.values(p.playlist.clips).filter((c): c is AudioClip => c.kind === 'audio');
  if (typeof given === 'string' && given) {
    const hit = audio.find((c) => c.id === given);
    return hit ? { id: hit.id } : { error: `there is no audio clip "${given}"` };
  }
  const selected = s.editor.getState().clipSelection.find((id) => p.playlist.clips[id]?.kind === 'audio');
  if (selected) return { id: selected };
  const cleaned = audio.filter((c) => c.cleanup);
  if (cleaned.length === 1) return { id: (cleaned[0] as AudioClip).id };
  if (audio.length === 1) return { id: (audio[0] as AudioClip).id };
  return { error: audio.length ? 'which clip? give clip (an audio clip id from get_clips)' : 'the song has no audio clips' };
}

export function cleanupReport(s: Services, args: { clip?: unknown }): unknown {
  const target = pick(s, args.clip);
  if ('error' in target) return target;
  const id = target.id;
  const p = s.doc.getState().project;
  const problem = cleanupProblem(p, id);
  if (problem) return { clip: id, error: problem };
  const found = audioClipOf(p, id);
  if (!found) return { error: `there is no audio clip "${id}"` };
  const { clip, channel } = found;
  const settings = clip.cleanup;
  const hearing = s.editor.getState().cleanupOriginal.includes(id) ? 'original recording' : 'cleaned sound';
  if (!settings) {
    return { clip: id, name: channel.name, state: 'none', summary: 'no cleanup is set on this clip', hearing, order: ORDER_NOTE };
  }
  const rendering = cleanupState.getState().rendering?.clipId === id;
  const tempo = tempoMapOf(p, 'song');
  const mode = playbackMode(channel);
  const barTicks = ticksPerBar(p.transport.timeSig);
  const noiseProblem = cleanupState.getState().problems[id];
  return {
    clip: id,
    name: channel.name,
    state: isRenderCurrent(settings) ? 'ready' : 'being made',
    summary: describeCleanup(settings),
    cleaned_audio: isRenderCurrent(settings) ? 'ready' : rendering ? 'being made now' : 'waiting to be made',
    hearing,
    order: ORDER_NOTE,
    ...(settings.noise
      ? {
          noise: {
            reduction_db: r1(settings.noise.amountDb),
            sensitivity_pct: Math.round(settings.noise.sensitivity * 100),
            learned_from:
              settings.noise.from !== undefined && settings.noise.to !== undefined
                ? { from_s: r2(settings.noise.from), to_s: r2(settings.noise.to) }
                : 'not looked for yet (the quietest half second is found when the cleaned sound is made)',
            ...(noiseProblem ? { problem: noiseProblem } : {}),
          },
        }
      : {}),
    ...(settings.breaths
      ? {
          breaths: {
            reduction_db: settings.breaths.reduceDb >= BREATH_REMOVE_DB ? 'removed' : r1(settings.breaths.reduceDb),
            sensitivity_pct: Math.round(settings.breaths.sensitivity * 100),
            found: settings.breaths.spans
              ? settings.breaths.spans.map((b, i) => ({
                  n: i + 1,
                  bar: r2(tickAtSourceSeconds(clip, mode, tempo, b.from) / barTicks + 1),
                  start_s: r2(b.from),
                  end_s: r2(b.to),
                  lowered: !b.off,
                }))
              : 'not looked for yet (they are found when the cleaned sound is made)',
          },
        }
      : {}),
    ...(settings.clicks ? { clicks: { sensitivity_pct: Math.round(settings.clicks.sensitivity * 100) } } : {}),
  };
}

/** The processing order, said once in every answer so a request that mixes cleanup and pitch correction is understood. */
const ORDER_NOTE = 'order of a clip’s sound: the recording, then cleanup, then pitch correction (the pitch editor works on the cleaned sound)';
