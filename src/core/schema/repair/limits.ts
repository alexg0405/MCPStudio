/** The ranges repair keeps stored numbers inside. Values outside them can only come from damaged data. */

/** Channel volume is linear gain 0–1.25 (see setChannelProp). */
export const CHANNEL_VOLUME_MAX = 1.25;
/** Insert faders are linear gain; the ceiling (+12 dB) is generous so repair only catches nonsense. */
export const INSERT_VOLUME_MAX = 4;
/** The largest tick a stored position or length may have: positions are whole numbers of ticks (960 per beat). */
export const TICK_MAX = Number.MAX_SAFE_INTEGER;
/** The slowest tempo a project may have, in beats per minute. */
export const BPM_MIN = 10;
/** The fastest tempo a project may have, in beats per minute. */
export const BPM_MAX = 522;
