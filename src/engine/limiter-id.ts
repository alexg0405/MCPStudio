/** Processor name of the master safety limiter (kept apart so the main thread needn't load the kernel). */
export const LIMITER_ID = 'agstudio.safety-limiter';

/**
 * How far ahead of the output the safety limiter looks (seconds): it delays the music by this much, so a live input's
 * round trip counts it. Kept here, with the id, so the main thread and the kernel agree without the main thread loading
 * the kernel.
 */
export const LIMITER_LOOKAHEAD_SEC = 0.0013;
