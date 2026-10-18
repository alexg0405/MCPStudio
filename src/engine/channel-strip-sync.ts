import type { ChannelId, Project } from '@core/model/types';
import { ChannelStrip } from './channel-strip';
import type { EngineCore } from './engine-core';

/**
 * Brings the channel strips (one per instrument and audio clip channel) in line with a new version of the project:
 * new channels get a strip, changed ones are updated in place, removed ones are disposed, and every strip learns
 * whether it is muted. Does nothing when neither the channels nor the sample table changed.
 *
 * Returns whether any strip's delay-compensation shift changed (the engine then plans the song again while playing).
 */
export function syncChannelStrips(
  core: EngineCore,
  strips: Map<ChannelId, ChannelStrip>,
  prev: Project | null,
  next: Project,
  muted: ReadonlySet<ChannelId>,
): boolean {
  if (prev && prev.channels === next.channels && prev.samples === next.samples) return false;
  let shiftChanged = false;
  for (const id of next.channelOrder) {
    const channel = next.channels[id];
    // Automation channels make no sound and have no strip.
    if (!channel || channel.kind === 'automation') continue;
    const strip = strips.get(id);
    if (!strip) {
      strips.set(id, new ChannelStrip(core, channel, next));
    } else if (prev?.channels[id] !== channel) {
      const shiftBefore = strip.shift;
      strip.update(channel, next);
      if (strip.shift !== shiftBefore) shiftChanged = true;
    } else if (prev && prev.samples !== next.samples) {
      strip.samplesChanged(next);
    }
    strips.get(id)?.setMuted(muted.has(id));
  }
  disposeStripsWithoutChannel(strips, next);
  return shiftChanged;
}

/** Strips whose channel is gone (or turned into one that makes no sound of its own) are disposed. */
function disposeStripsWithoutChannel(strips: Map<ChannelId, ChannelStrip>, next: Project): void {
  for (const [id, strip] of strips) {
    const kind = next.channels[id]?.kind;
    if (kind === 'instrument' || kind === 'audioClip') continue;
    strip.dispose();
    strips.delete(id);
  }
}
