/**
 * The part of the song a request is about ("Ask AI about this part"): a time range, a marker
 * section, some clips or some notes. It is captured when the musician sends and resolved again on
 * every turn (markers move, clips get deleted); `focusContext` is how the AI sees it.
 *
 * `types` has the shapes, `resolve` resolves a focus against the project, `context-block` writes the
 * text the AI reads and `spans` holds the tick-span helpers they share.
 */
export { focusContext } from './context-block';
export { focusLabel, isAiFocus, resolveFocus } from './resolve';
export { isTimeFocus, type AiFocus, type FocusCopies, type ResolvedFocus } from './types';
