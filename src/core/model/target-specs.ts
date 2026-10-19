import { p } from '@agstudio/sdk/params';
import { DEFAULT_BPM, DEFAULT_CHANNEL_VOLUME } from './defaults';
import { MAX_INSERT_VOLUME } from './fader';

// Param specs of the host's own controls (what automation and controller links see for them).

/** Range of a channel's volume as automation and controllers see it: a linear gain, 0 to 1.25. */
export const CHANNEL_VOLUME_SPEC = p.float(0, 1.25, DEFAULT_CHANNEL_VOLUME, { label: 'Volume' });
/** Range of a channel's pan: -1 (left) to 1 (right). */
export const CHANNEL_PAN_SPEC = p.float(-1, 1, 0, { label: 'Pan' });
/** Range of a channel's pitch offset: -2400 to 2400 cents (two octaves each way). */
export const CHANNEL_PITCH_SPEC = p.float(-2400, 2400, 0, { label: 'Pitch', unit: 'ct' });
/** Range of a mixer insert's volume: a linear gain from 0 up to `MAX_INSERT_VOLUME`. */
export const INSERT_VOLUME_SPEC = p.float(0, MAX_INSERT_VOLUME, 1, { label: 'Volume' });
/** Range of a mixer insert's pan: -1 (left) to 1 (right). */
export const INSERT_PAN_SPEC = p.float(-1, 1, 0, { label: 'Pan' });
/** Range of an effect slot's dry/wet mix: 0 (dry) to 1 (fully wet), shown as a percentage. */
export const SLOT_MIX_SPEC = p.float(0, 1, 1, { label: 'Mix', unit: '%' });
/** Range of the level of a send from one insert to another: a linear gain from 0 up to `MAX_INSERT_VOLUME`. */
export const ROUTE_LEVEL_SPEC = p.float(0, MAX_INSERT_VOLUME, 1, { label: 'Send level' });
/** Range of the song tempo for automation and controllers: 10 to 522 beats per minute. */
export const TEMPO_SPEC = p.float(10, 522, DEFAULT_BPM, { label: 'Tempo' });
