/**
 * Controller presets: mappings for popular DJ controllers and pad grids for the clip launcher, chosen by the device's name. Only
 * controllers whose MIDI values could be checked against public documentation are here (see each
 * file's header for the source); any other controller uses MIDI learn.
 */
import type { ControllerPreset } from './build';
import { HERCULES_PRESETS } from './hercules';
import { NUMARK_PRESETS } from './numark';
import { PAD_PRESETS } from './pads';
import { PIONEER_PRESETS } from './pioneer';

/** A ready-made map for a known controller. */
export type { ControllerPreset } from './build';

/** Every ready-made map. */
export const CONTROLLER_PRESETS: readonly ControllerPreset[] = [...PIONEER_PRESETS, ...HERCULES_PRESETS, ...NUMARK_PRESETS, ...PAD_PRESETS];

/** Lower-case letters and digits only: "DDJ-FLX4 MIDI 1" → "ddjflx4midi1". */
export const normalizeDeviceName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The preset for a device name, or null (use MIDI learn). */
export function presetForDevice(deviceName: string): ControllerPreset | null {
  const n = normalizeDeviceName(deviceName);
  return CONTROLLER_PRESETS.find((p) => p.match.some((m) => n.includes(m))) ?? null;
}

/** The preset with this id (null when there is none). */
export function presetById(id: string): ControllerPreset | null {
  return CONTROLLER_PRESETS.find((p) => p.id === id) ?? null;
}
