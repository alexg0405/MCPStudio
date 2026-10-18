/** The no-AI path: the offline generator writes a whole beat from the words asked so far. */
import { generateLocalBeat, mergeOfflinePrompt } from '@core/beat/local';
import { applyBeatSpec } from '../apply';
import { importMySounds } from '../my-sounds';
import type { Take } from '../state';
import type { AssistantSession } from './session';

/** A take from a file keeps its own tempo unless the request names one; closer than this (BPM) counts as the same. */
const SAME_TEMPO_BPM = 0.5;

/**
 * Writes a beat without an AI and plays it (when autoplay is on). The generator is stateless, so the
 * request is added to everything asked so far. `projectBpm` is the project's tempo when the request began.
 */
export async function writeOfflineBeat(
  session: AssistantSession,
  request: string,
  take: Take | null,
  projectBpm: number,
): Promise<void> {
  const { services, store } = session;
  session.offlinePrompt = mergeOfflinePrompt(session.offlinePrompt, request);
  const spec = generateLocalBeat({
    prompt: session.offlinePrompt,
    bpm: projectBpm,
    ...(take ? { performance: { events: take.events, role: take.role, bars: take.bars } } : {}),
  });
  if (take && spec.bpm === undefined && Math.abs(take.bpm - projectBpm) > SAME_TEMPO_BPM) spec.bpm = take.bpm;

  // The musician's own hits (cut from their recording) replace the kit's, when asked for and there are any.
  const useOwnHits = !!take?.audio && store.getState().mySounds && take.events.some((event) => event.kind !== 'tonal');
  const samples =
    take?.audio && useOwnHits ? await importMySounds({ events: take.events, audio: take.audio }).catch(() => ({})) : {};
  const applied = applyBeatSpec(services, spec, store.getState().applied, { samples });
  const trackNames = spec.tracks.map((track) => track.name).join(', ');
  session.say('assistant', spec.message ?? `Wrote "${spec.title}".`, {
    detail: `"${spec.title}": ${trackNames}${spec.bpm ? ` · ${spec.bpm} BPM` : ''}`,
    offline: true,
    beat: { title: spec.title, cursor: services.history.status().cursor },
  });
  store.setState({ phase: 'idle', applied });
  if (store.getState().autoplay) {
    services.view.getState().setMode('pattern');
    services.engine.play();
  }
}
