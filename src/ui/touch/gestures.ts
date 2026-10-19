/**
 * The touch gestures, in plain words: the list the Shortcuts window shows under the keys and `docs/shortcuts.md` repeats
 * (`test/unit/shortcuts-doc.test.ts`). Keep it in step with `surface.ts`, `global.ts` and `sdk/ui/touch-assist.ts`.
 */

/** One gesture and what it does. */
export interface TouchGesture {
  gesture: string;
  what: string;
}

/** Where a group of gestures works. */
export interface TouchGestureGroup {
  where: string;
  gestures: readonly TouchGesture[];
}

export const TOUCH_GESTURES: readonly TouchGestureGroup[] = [
  {
    where: 'Playlist, piano roll, pitch editor and their rulers',
    gestures: [
      { gesture: 'One finger drag', what: 'What the current tool does with a mouse: draw, move, select, erase' },
      { gesture: 'Two fingers drag', what: 'Pan the view (the first finger’s drag is dropped, nothing is changed)' },
      { gesture: 'Pinch sideways', what: 'Zoom time around the point between your fingers' },
      { gesture: 'Pinch up and down', what: 'Make tracks (playlist) or keys (piano roll) taller or shorter' },
      { gesture: 'Hold one finger (half a second)', what: 'The right-click menu: a clip’s or note’s menu, or the empty spot’s' },
      { gesture: 'Two quick taps', what: 'A double-click (open a pattern, rename, add an automation point, reset a handle)' },
    ],
  },
  {
    where: 'Knobs, faders, sliders and number boxes',
    gestures: [
      { gesture: 'Drag up or down', what: 'Change the value' },
      { gesture: 'A second finger anywhere while dragging', what: 'Fine adjust (a tenth as fast) until it lifts' },
      { gesture: 'Hold first, then drag', what: 'Fine adjust for that drag' },
      { gesture: 'Hold, then lift without dragging', what: 'The control’s menu (automation, link to a controller, reset)' },
      { gesture: 'Two quick taps', what: 'Back to the default value' },
    ],
  },
  {
    where: 'Everywhere else',
    gestures: [
      { gesture: 'Hold one finger on a control', what: 'Its menu if it has one, else what it does (the hint)' },
      { gesture: 'Two quick taps on a window’s title', what: 'Maximize or restore it' },
      { gesture: 'Drag a window’s title or edge', what: 'Move or resize it (bigger handles in the touch layout)' },
      { gesture: 'Several fingers on the Keys window', what: 'One note per finger: chords on the piano, rolls on the pads' },
    ],
  },
];
