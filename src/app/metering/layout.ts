/**
 * The meter's shared-memory layout (slots of the readings, buffer sizes) for the interface: it reads the numbers the audio
 * thread writes, so it needs the same constants. Re-exported here because the interface reaches the engine only through the app.
 */
export { HISTORY_CAPACITY, R, SCOPE_FRAMES, SPECTRUM_SIZE } from '@engine/meter/layout';
