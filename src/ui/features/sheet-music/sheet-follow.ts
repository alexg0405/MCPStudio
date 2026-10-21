/**
 * Lights the notes of the sheet that are playing and keeps them on screen. It works on the elements drawn once (each
 * chord and rest has `data-t0` and `data-t1`, the pattern ticks it sounds between), on the animation frame loop, and only
 * toggles one class and the scroll position: playing a song makes no React commits.
 */
import { songPosition } from '@app/actions/markers';
import type { Services } from '@app/services';
import type { PatternId } from '@core/model/types';
import { patternTickAt } from '@core/query/playlist';
import { patternLength } from '@core/query/queries';
import { isReducedMotion } from '../../a11y/preferences';
import { onFrame } from '../../frame-loop';

/** The class the stylesheet gives a note that is playing. */
export const NOW_CLASS = 'ag-now';

/** One drawn chord or rest. */
interface TimedElement {
  from: number;
  to: number;
  element: Element;
  system: number;
}

/** Follows the playhead over the elements of a drawn sheet. */
export class SheetFollow {
  private groups: TimedElement[] = [];
  private active = new Set<TimedElement>();
  private next = 0;
  private lastTick = Number.NaN;
  private lastSystem = -1;
  private stop: (() => void) | null = null;

  constructor(
    private readonly s: Services,
    private readonly host: HTMLElement,
    private readonly patternId: () => PatternId | null,
    private readonly isFollowing: () => boolean,
  ) {}

  /** Finds the timed elements in what was drawn (call again after every redraw) and starts following. */
  attach(root: ParentNode): void {
    this.clear();
    this.groups = [...root.querySelectorAll<SVGGElement>('.ag-chord, .ag-rest')]
      .map((element) => ({
        from: Number(element.dataset.t0),
        to: Number(element.dataset.t1),
        element,
        system: Number(element.closest('svg')?.dataset.system ?? 0),
      }))
      .sort((a, b) => a.from - b.from);
    this.lastTick = Number.NaN;
    this.stop ??= onFrame(() => this.frame());
  }

  detach(): void {
    this.stop?.();
    this.stop = null;
    this.clear();
  }

  /** Puts everything back to unlit. */
  private clear(): void {
    for (const entry of this.active) entry.element.classList.remove(NOW_CLASS);
    this.active.clear();
    this.next = 0;
    this.lastSystem = -1;
  }

  /** The playhead in this pattern's ticks, or NaN when stopped (or in song mode when no clip of the pattern is playing). */
  private playheadTick(): number {
    const { engine, view, doc } = this.s;
    const patternId = this.patternId();
    if (!engine.playing || !patternId) return Number.NaN;
    const project = doc.getState().project;
    const pattern = project.patterns[patternId];
    if (!pattern) return Number.NaN;
    if (view.getState().mode === 'pattern') return engine.playhead() % patternLength(pattern, project.transport.timeSig);
    return patternTickAt(project, songPosition(this.s), patternId) ?? Number.NaN;
  }

  private frame(): void {
    const tick = this.playheadTick();
    if (Number.isNaN(tick)) {
      if (!Number.isNaN(this.lastTick)) this.clear();
      this.lastTick = Number.NaN;
      return;
    }
    // A loop or a jump back: start over from the beginning of the list.
    if (Number.isNaN(this.lastTick) || tick < this.lastTick) this.restartAt(tick);
    this.lastTick = tick;
    this.advance(tick);
  }

  private restartAt(tick: number): void {
    this.clear();
    let low = 0;
    let high = this.groups.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((this.groups[middle] as TimedElement).from <= tick) low = middle + 1;
      else high = middle;
    }
    // Everything that began before the tick and has not ended is lit; the walk back stops at the start of the list.
    for (let i = 0; i < low; i++) {
      const entry = this.groups[i] as TimedElement;
      if (entry.to > tick) this.light(entry);
    }
    this.next = low;
  }

  private advance(tick: number): void {
    let changed = false;
    while (this.next < this.groups.length && (this.groups[this.next] as TimedElement).from <= tick) {
      const entry = this.groups[this.next++] as TimedElement;
      if (entry.to > tick) {
        this.light(entry);
        changed = true;
      }
    }
    for (const entry of this.active) {
      if (entry.to > tick) continue;
      entry.element.classList.remove(NOW_CLASS);
      this.active.delete(entry);
      changed = true;
    }
    if (changed) this.keepInView();
  }

  private light(entry: TimedElement): void {
    entry.element.classList.add(NOW_CLASS);
    this.active.add(entry);
  }

  /** When the lit notes are on another system than before, turns the page: that system comes to the top of the window. */
  private keepInView(): void {
    if (!this.isFollowing()) return;
    let system = -1;
    for (const entry of this.active) system = Math.max(system, entry.system);
    if (system < 0 || system === this.lastSystem) return;
    this.lastSystem = system;
    const element = this.host.querySelector<SVGElement>(`svg[data-system="${system}"]`);
    if (!element) return;
    const top = element.getBoundingClientRect().top - this.host.getBoundingClientRect().top + this.host.scrollTop;
    const view = { top: this.host.scrollTop, bottom: this.host.scrollTop + this.host.clientHeight };
    const height = element.getBoundingClientRect().height;
    if (top >= view.top && top + height <= view.bottom) return;
    this.host.scrollTo({ top: Math.max(0, top - 12), behavior: isReducedMotion() ? 'auto' : 'smooth' });
  }
}
