/** Reading a channel's MIDI effects chain: the slots, which of them do something, and a short name for the chain. */
import type { Channel, ChannelId, MidiFxSlot, MidiFxSlotId, Project } from '../model/types';
import { midiFxDef } from '../midi-fx/registry';

const NO_SLOTS: readonly MidiFxSlot[] = [];

/** The channel's MIDI effects in the order notes go through them (none for a channel that has none, or is not an instrument). */
export function midiFxOf(channel: Channel | undefined): readonly MidiFxSlot[] {
  return channel?.kind === 'instrument' ? (channel.midiFx ?? NO_SLOTS) : NO_SLOTS;
}

/** One effect of a channel's chain. */
export function midiFxSlotOf(project: Pick<Project, 'channels'>, channelId: ChannelId, slotId: MidiFxSlotId): MidiFxSlot | undefined {
  return midiFxOf(project.channels[channelId]).find((slot) => slot.id === slotId);
}

/** True when the channel has an effect that changes its notes: one that is on and that this version knows. */
export function hasActiveMidiFx(channel: Channel | undefined): boolean {
  return midiFxOf(channel).some((slot) => slot.enabled && midiFxDef(slot.effect) !== undefined);
}

/** The chain's effects by name, in order, with bypassed ones in brackets ("Arpeggiator → Chord → (Humanize)"); '' for none. */
export function midiFxSummary(channel: Channel | undefined): string {
  return midiFxOf(channel)
    .map((slot) => {
      const name = midiFxDef(slot.effect)?.name ?? slot.effect;
      return slot.enabled ? name : `(${name})`;
    })
    .join(' → ');
}
