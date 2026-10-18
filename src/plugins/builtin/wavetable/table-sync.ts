import type { WorkletPort } from '@agstudio/sdk';
import type { WavetableBank } from '@agstudio/sdk/dsp/wavetable';
import { buildFrameBank, framesOfState, readUserTableState } from '@agstudio/sdk/dsp/wavetable-frames';

/** The shared one-sine bank an instance plays as its table until the musician draws one (built once per page). */
let emptyBank: WavetableBank | null = null;

/** What each instance's kernel was last sent, so an unchanged table is not rebuilt (an undo back to it is cheap too). */
const lastSent = new WeakMap<WorkletPort, string>();

/**
 * Turns the plugin's state into the band-limited bank of its drawn table and sends it to the kernel. Runs on the main
 * thread each time the state changes (see `onState` in the SDK), so the audio thread never builds mip levels. State
 * that is missing or damaged plays as an empty table (one sine).
 */
export function syncUserTable(state: unknown, port: WorkletPort): void {
  const frames = framesOfState(state);
  const key = frames.length ? (readUserTableState(state).user?.frames.join(',') ?? '') : '';
  if (lastSent.get(port) === key) return;
  lastSent.set(port, key);
  const bank = frames.length ? buildFrameBank(frames, true) : (emptyBank ??= buildFrameBank([], true));
  port.send({ type: 'userBank', data: bank.data, frames: bank.frames });
}
