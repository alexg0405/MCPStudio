/** Processor name of the input recorder (kept apart so the main thread needn't load the worklet). */
export const RECORDER_ID = 'agstudio.recorder';

/** Recorder state slots (Int32 view of the shared state buffer). */
export const REC_STATE = { mode: 0, written: 1 } as const;
/** `mode` values: waiting, recording, finished (the processor stops being called). */
export const REC_MODE = { idle: 0, recording: 1, done: 2 } as const;
