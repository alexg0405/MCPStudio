import { kitPiece } from '@core/model/kit';
import { type ChannelId } from '@core/model/types';
import { addKitChannel } from '@app/actions/channels';
import { addSampleChannels, importAudioFile, setChannelSample } from '@app/actions/samples';
import { kitSampleRef } from '@app/default-project';
import type { Services } from '@app/services';

/** The drag data type of a kit sound dragged from the browser. */
export const SOUND = 'application/x-agstudio-sound';

/**
 * FL behaviour for drops on the rack: a sound dropped on a sampler (or audio clip) channel replaces
 * its sample; anywhere else, or several files at once, adds new channels.
 */
export async function dropOnRack(
  s: Services,
  target: ChannelId | undefined,
  generator: string,
  files: Promise<File[]> | null,
): Promise<void> {
  if (generator) {
    const ref = { ...kitSampleRef(generator), name: kitPiece(generator)?.short ?? generator };
    if (!target || !setChannelSample(s, target, ref)) addKitChannel(s, generator);
    return;
  }
  const refs = [];
  for (const file of (await files) ?? []) {
    const ref = await importAudioFile(s, file);
    if (ref) refs.push(ref);
  }
  const [first] = refs;
  if (!first) return;
  if (target && refs.length === 1 && setChannelSample(s, target, first)) return;
  const order = s.doc.getState().project.channelOrder;
  addSampleChannels(s, refs, target ? order.indexOf(target) + 1 : order.length);
}
