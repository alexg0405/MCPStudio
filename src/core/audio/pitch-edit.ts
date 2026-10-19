/**
 * Pitch correction of a recorded clip (`AudioClip.pitchEdit`): what the edits mean, how they turn into a
 * pitch-shift curve, and the render. Pure functions of plain data (no DOM, no globals), so the editor, the AI,
 * the Worker and the tests all agree. `pitch-edit/edit.ts` is the edit itself (reading, validating, changing it),
 * `pitch-edit/render.ts` the shift curve and the render; this file keeps the import path every caller uses.
 */
export * from './pitch-edit/edit';
export * from './pitch-edit/render';
