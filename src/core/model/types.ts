/**
 * Project document, schema v3. This is what gets saved (project.json) and what undo/redo operates on.
 * Every value is JSON-serializable. Entities live in Record<Id, T> maps plus order arrays so Immer
 * patches stay small and every entity keeps its reference identity until it changes.
 *
 * The types are split by topic in `types/` (ids, project, channels, patterns, playlist, automation, mixer,
 * samples, launcher, reference, dj); this file keeps the one import path every caller uses.
 */
export * from './types/ids';
export * from './types/project';
export * from './types/channels';
export * from './types/patterns';
export * from './types/playlist';
export * from './types/automation';
export * from './types/mixer';
export * from './types/samples';
export * from './types/launcher';
export * from './types/reference';
export * from './types/dj';
export * from './types/harmony';
