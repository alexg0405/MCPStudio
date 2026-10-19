import { createStore } from 'zustand';
import type { Services } from '@app/services';
import type { LatencyMeasurement } from '@core/audio/latency';

/** Whether the audio input dialog is open. */
export const audioInputDialog = createStore<{ open: boolean }>(() => ({ open: false }));

/** Where the latency calibration is: not started, listening, a result waiting to be used, or a failure. */
export type Calibration =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'done'; m: LatencyMeasurement }
  | { state: 'error'; error: string };

/** The latency calibration's progress (the dialog shows it; the command starts it). */
export const calibrationStore = createStore<{ c: Calibration; abort: AbortController | null }>(() => ({
  c: { state: 'idle' },
  abort: null,
}));

/** Plays the clicks and measures the round trip (the result waits in the dialog to be used). */
export async function runCalibration(s: Services): Promise<void> {
  if (calibrationStore.getState().c.state === 'running') return;
  const abort = new AbortController();
  calibrationStore.setState({ c: { state: 'running' }, abort });
  const result = await s.audioInput.calibrate(abort.signal);
  calibrationStore.setState({ c: 'error' in result ? { state: 'error', error: result.error } : { state: 'done', m: result }, abort: null });
}
