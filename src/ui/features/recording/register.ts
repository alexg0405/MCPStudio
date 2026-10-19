import type { Services } from '@app/services';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { addOverlay } from '../../shell/overlays';
import { AudioInputOverlay } from './AudioInputDialog';
import { registerAudioInputCommands } from './audio-input-commands';
import { registerPunchCommands } from './punch-commands';

export const order = 12;

/**
 * Audio recording settings and tools: Options › Audio input… (device, mono/stereo, level meter,
 * monitoring, latency and its calibration), what record mode records (notes, audio), and a command
 * for each so menus, the action search and the AI reach them.
 */
export function register(services: Services): void {
  registerAudioInputCommands(services);
  registerPunchCommands(services);

  addMenuItems('options', [
    cmd('transport.recordNotes', 74),
    cmd('transport.recordAudio', 75),
    cmd('audio.monitor', 76),
    cmd('options.audioInput', 77),
    cmd('audio.calibrateLatency', 78),
    sep(79),
  ]);
  addMenuItems('playlist', [
    cmd('transport.recordAudio', 40),
    cmd('options.audioInput', 41),
    cmd('record.punchIn', 42),
    cmd('record.punchOut', 43),
    cmd('record.punchRange', 44),
    cmd('record.clearPunch', 45),
    cmd('transport.recordPunch', 46),
    sep(49),
  ]);
  addOverlay('audio-input', AudioInputOverlay);
}