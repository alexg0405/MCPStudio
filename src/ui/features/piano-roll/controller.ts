/**
 * The imperative piano roll: owns the canvases, the viewport and pointer/wheel interaction. React only renders the shell;
 * data changes mark layers dirty and the shared frame loop redraws them.
 *
 * Geometry edits (move/resize/create) preview while dragging and commit one undo step on release. Continuous edits
 * (paint, erase, mute, event lane) are live history gestures.
 *
 * This class is the window's handle on the editor: it builds the shared context, wires the events and stores, runs the
 * frame, and exposes what the window needs. The work itself lives in `./control/`, one module per job (drawing a layer,
 * one tool's pointer handling, the piano keys, the event lane...).
 */
import type { Services } from '@app/services';
import { onFrame } from '../../frame-loop';
import { CleanupList } from '../../timeline/listeners';
import type { Viewport } from '../../timeline/viewport';
import {
  createPianoRollContext,
  type Layer,
  type PianoRollContext,
  type PianoRollElements,
  type PianoRollHooks,
  type PianoRollMenuRequest,
} from './control/context';
import { stopAudition } from './control/audition';
import { pianoRollPerf, runFrame } from './control/frame';
import { createLayerDrawers, type LayerDrawers } from './control/layers';
import { attachKeyboard } from './control/keys';
import { cancelDrag } from './control/pointer';
import { editTarget } from './control/target';
import { measureLayout, zoomBy } from './control/viewport-control';
import { listenToElements, subscribeToChanges } from './control/wiring';

/** The sizes of the keys and the ruler (the window's layout uses them), and the redraw timings. */
export { KEYS_WIDTH, RULER_HEIGHT } from './layout';
export { pianoRollPerf };
/** The types the window uses with the controller. */
export type { PianoRollElements, PianoRollMenuRequest };

/** The piano roll editor: mount it on its canvases, plug in its menu (`onMenu`), and it runs itself on the frame loop. */
export class PianoRollController implements PianoRollHooks {
  /** The view onto the pattern (scroll and zoom). */
  readonly vp: Viewport;
  /** Set by the window: shows the context menu for a right-click. */
  onMenu: PianoRollHooks['onMenu'] = null;
  private readonly ctx: PianoRollContext;
  private readonly drawers: LayerDrawers;
  private readonly cleanups = new CleanupList();

  constructor(s: Services, els: PianoRollElements) {
    this.ctx = createPianoRollContext(s, els, this);
    this.vp = this.ctx.vp;
    this.drawers = createLayerDrawers(this.ctx);
    // Keep a restored scroll position; center on the notes only when it's unknown or the channel changes.
    if (s.editor.getState().pianoRoll.scrollRow !== null) {
      const target = editTarget(this.ctx);
      this.ctx.state.centeredFor = { channelId: target.channelId, patternId: target.patternId };
    }
  }

  /** Starts listening to the app and the elements, and draws. */
  mount(): void {
    subscribeToChanges(this.ctx, this.cleanups);
    this.cleanups.add(onFrame(() => runFrame(this.ctx, this.drawers)));
    listenToElements(this.ctx, this.cleanups);
    attachKeyboard(this.ctx, this.cleanups);
    measureLayout(this.ctx);
  }

  /** Stops listening and saves the view. */
  unmount(): void {
    cancelDrag(this.ctx);
    stopAudition(this.ctx);
    this.cleanups.runAll();
    this.ctx.viewportSaver.flush();
  }

  /** Marks layers to be drawn on the next frame. */
  invalidate(...layers: Layer[]): void {
    this.ctx.invalidate(...layers);
  }

  /** The toolbar's zoom buttons. */
  zoomBy(factor: number): void {
    zoomBy(this.ctx, factor);
  }
}
