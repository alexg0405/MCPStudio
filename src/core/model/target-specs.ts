import { p } from '@agstudio/sdk/params';
import { DEFAULT_BPM, DEFAULT_CHANNEL_VOLUME } from './defaults';
import { MAX_INSERT_VOLUME } from './fader';

// Param specs of the host's own controls (what automation and controller links see for them).

export const CHANNEL_VOLUME_SPEC = p.float(0, 1.25, DEFAULT_CHANNEL_VOLUME, { label: 'Volume' });
export const CHANNEL_PAN_SPEC = p.float(-1, 1, 0, { label: 'Pan' });
export const CHANNEL_PITCH_SPEC = p.float(-2400, 2400, 0, { label: 'Pitch', unit: 'ct' });
export const INSERT_VOLUME_SPEC = p.float(0, MAX_INSERT_VOLUME, 1, { label: 'Volume' });
export const INSERT_PAN_SPEC = p.float(-1, 1, 0, { label: 'Pan' });
export const SLOT_MIX_SPEC = p.float(0, 1, 1, { label: 'Mix', unit: '%' });
export const ROUTE_LEVEL_SPEC = p.float(0, MAX_INSERT_VOLUME, 1, { label: 'Send level' });
/** A group's VCA fader: a linear gain on the fader taper, like a track's volume. */
export const VCA_SPEC = p.float(0, MAX_INSERT_VOLUME, 1, { label: 'VCA' });
export const TEMPO_SPEC = p.float(10, 522, DEFAULT_BPM, { label: 'Tempo' });
