/** Events the page-wide touch helpers (`global.ts`) send to the rest of the shell. */

/**
 * A finger rested on something with a `data-hint` that has no menu of its own: show that hint (the touch version of hovering
 * for a tooltip). It bubbles from the element touched; the tooltip (`shell/hover-tip.ts`) listens for it.
 */
export const TOUCH_HINT_EVENT = 'ag-touch-hint';
