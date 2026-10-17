import type { ChannelId, Project } from '@core/model/types';
import type { FeedNote } from '@agstudio/sdk';

/**
 * The notes instrument channels play, handed to effects that follow a melody (`PluginHost.notes`): the engine
 * calls `emit` for every note the transport, a preview or a live key plays; a listener names a channel by its
 * position among the instrument channels (1 = the first in the rack) and hears it while it is there.
 */
export class NoteFeedHub {
  /** Instrument channels in rack order, and their names. */
  private order: ChannelId[] = [];
  private names = new Map<ChannelId, string>();
  private readonly listeners = new Set<{ position: number; fn: (e: FeedNote) => void }>();

  setProject(p: Project): void {
    this.order = p.channelOrder.filter((id) => p.channels[id]?.kind === 'instrument');
    this.names = new Map(this.order.map((id) => [id, p.channels[id]?.name ?? '']));
  }

  listen(position: number, fn: (e: FeedNote) => void): () => void {
    const l = { position, fn };
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }

  channelName(position: number): string | null {
    const id = this.order[position - 1];
    return id ? (this.names.get(id) ?? null) : null;
  }

  /** A note on or off for a channel (`time` is the song's time: each listener shifts it like its own audio). */
  emit(channelId: ChannelId, e: FeedNote): void {
    if (this.listeners.size === 0) return;
    for (const l of this.listeners) if (this.order[l.position - 1] === channelId) l.fn(e);
  }

  /** Everything stops at `time` (stop, seek, loop): every listener lets go. */
  emitAllOff(time: number): void {
    if (this.listeners.size === 0) return;
    const e: FeedNote = { kind: 'allOff', time, noteId: 0, key: 0, velocity: 0 };
    for (const l of this.listeners) l.fn(e);
  }
}
