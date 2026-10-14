/** Processor name of the streaming input recorder (kept apart so the main thread needn't load the worklet). */
export const INPUT_RECORDER_ID = 'agstudio.input-recorder';

/** Int32 slots of the shared state. */
export const IN_STATE = {
  /** IN_MODE value. */
  mode: 0,
  /** Frames written since recording started (the ring holds the last `capacity`). */
  written: 1,
  /** Blocks processed (meters): the level ring is indexed by it. */
  blocks: 2,
} as const;

/** `mode` values: metering only, recording, closed (the processor ends). */
export const IN_MODE = { meter: 0, recording: 1, closed: 2 } as const;

/** Blocks of peak levels kept for the meter (~85 ms at 48 kHz). */
export const LEVEL_BLOCKS = 32;
