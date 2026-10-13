import { newId } from '@core/model/ids';
import { kitPiece } from '@core/model/kit';
import type { AudioClip, AudioClipChannel, LaneId, Tick } from '@core/model/types';
import { DEFAULT_CHANNEL_VOLUME, paletteColor } from '@core/model/defaults';
import { addChannel, addSample } from '@core/ops/channels';
import { addClips } from '@core/ops/playlist';
import { PPQ } from '@core/time/ppq';
import { generate } from '@engine/kit/generators';
import type { Services } from '../services';
import { kitSampleRef } from '../default-project';

const durations = new Map<string, number>();

/** Length of a built-in kit sound in seconds (generated once at 48 kHz). */
export function kitDuration(generator: string): number {
  let d = durations.get(generator);
  if (d === undefined) {
    const data = generate(generator, 48000);
    d = data ? (data[0]?.length ?? 0) / 48000 : 0;
    durations.set(generator, d);
  }
  return d;
}

/**
 * FL behaviour: dropping a sample on the playlist creates an "audio clip" channel for it plus a
 * clip as long as the sample (at the current tempo).
 */
export function addKitAudioClip(s: Services, generator: string, laneId: LaneId, start: Tick): void {
  const project = s.doc.getState().project;
  const sample = kitSampleRef(generator);
  const seconds = kitDuration(generator);
  sample.durationSec = seconds;
  const channel: AudioClipChannel = {
    kind: 'audioClip',
    id: newId.channel(),
    name: kitPiece(generator)?.name ?? generator,
    color: paletteColor(project.channelOrder.length),
    muted: false,
    solo: false,
    volume: DEFAULT_CHANNEL_VOLUME,
    pan: 0,
    output: project.mixer.order[0] ?? ('master' as AudioClipChannel['output']),
    sampleId: sample.id,
  };
  const ticks = Math.max(1, Math.round((seconds * project.transport.bpm * PPQ) / 60));
  const clip: AudioClip = {
    kind: 'audio',
    id: newId.clip(),
    laneId,
    start,
    length: ticks,
    channelId: channel.id,
    offsetSec: 0,
  };
  s.history.transact(`Add ${channel.name} clip`, (d) => {
    addSample(d, sample);
    addChannel(d, channel);
    addClips(d, [clip]);
  });
  s.editor.getState().selectClips([clip.id]);
}
