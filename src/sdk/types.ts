/**
 * AGstudio plugin SDK: the contract between plugins (instruments and effects) and the host.
 * Plugins import only from '@agstudio/sdk' (and '/params', '/worklet', '/dsp', '/ui').
 *
 * The types live in `api/`, one file per part of the contract (notes, host, instances, editor,
 * definitions, note scripts); this file re-exports all of them so every import path stays the same.
 */
export * from './api/notes';
export * from './api/host';
export * from './api/instances';
export * from './api/editor';
export * from './api/definitions';
export * from './api/note-script';
