import type { ChannelId, Clip, Tick } from './types';

// Exhaustive helpers over clip kinds, so a new kind fails to compile wherever it needs handling.

/** The channel a clip plays (audio and automation clips); null for pattern clips. */
export function clipChannelId(c: Clip): ChannelId | null {
  switch (c.kind) {
    case 'pattern':
      return null;
    case 'audio':
    case 'automation':
      return c.channelId;
  }
}

/** Content offset in ticks (pattern and automation clips); null for audio clips, which trim in seconds. */
export function clipTickOffset(c: Clip): Tick | null {
  switch (c.kind) {
    case 'pattern':
    case 'automation':
      return c.offset;
    case 'audio':
      return null;
  }
}

/** Equal for clips that play the same content ("select all clips of this pattern / sound"). */
export function clipSourceKey(c: Clip): string {
  switch (c.kind) {
    case 'pattern':
      return `pattern:${c.patternId}`;
    case 'audio':
    case 'automation':
      return `channel:${c.channelId}`;
  }
}
