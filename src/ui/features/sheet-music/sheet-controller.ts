/**
 * The Sheet music window's engine room, outside React: it engraves the pattern when the notes or the settings change,
 * draws the systems as SVG into the window, shows the selection (shared with the piano roll), lights the notes that play,
 * and owns the keyboard cursor. React only draws the toolbar around it, so scrolling, following and selecting cause no
 * React commits.
 */
import type { Services } from '@app/services';
import type { SheetState } from '@app/notation/sheet';
import { sheetState } from '@app/notation/sheet';
import type { NoteId, PatternId, Tick } from '@core/model/types';
import { describeBar, cursorStops, scoreEvents, type ScoreEvent } from '@core/notation/events';
import { locateTick, SPACE, type SheetLayout } from '@core/notation/render/layout';
import { renderSheet } from '@core/notation/render';
import { meterOf } from '@core/notation/meter';
import type { Score } from '@core/notation/types';
import { ticksPerBar } from '@core/time/ppq';
import { SheetFollow } from './sheet-follow';

/** Most bars written out in the hidden text version of the score (a longer score is read with the cursor). */
const MAX_TEXT_BARS = 64;
/** Pixels left empty at the right of the page for the scrollbar. */
const SCROLLBAR_ROOM = 20;
/** Narrowest page the layout is made for; a narrower window scrolls sideways. */
const MIN_PAGE_WIDTH = 200;

/** The keyboard cursor: where notes are typed (a pattern tick) and the key the next typed letter is nearest to. */
export interface SheetCursor {
  tick: Tick;
  key: number;
}

/** Draws the sheet into a host element and keeps it in step with the project. */
export class SheetController {
  state: SheetState | null = null;
  layout: SheetLayout | null = null;
  events: ScoreEvent[] = [];
  stops: ScoreEvent[] = [];
  cursor: SheetCursor = { tick: 0, key: 72 };
  /** Called after every redraw and cursor move (the window refreshes its summary). */
  onChange: (() => void) | null = null;
  /** The cursor box is shown (the keyboard has the focus). */
  isCursorShown = false;
  private readonly follow: SheetFollow;
  private heads = new Map<string, Element[]>();
  private shownSelection = new Set<string>();
  private unsubscribes: Array<() => void> = [];
  private resizeObserver: ResizeObserver | null = null;
  private pending = 0;
  private lastKey: readonly unknown[] = [];
  private cursorSystem = -1;

  constructor(
    private readonly s: Services,
    readonly host: HTMLElement,
    private readonly content: HTMLElement,
  ) {
    this.follow = new SheetFollow(
      s,
      host,
      () => this.state?.patternId ?? null,
      () => s.editor.getState().sheet.follow,
    );
  }

  /** Starts listening to the project and the settings and draws the first time. */
  mount(): void {
    const redraw = () => this.schedule();
    this.unsubscribes = [
      this.s.doc.subscribe(redraw),
      this.s.view.subscribe(redraw),
      this.s.session.subscribe(redraw),
      this.s.editor.subscribe((state, previous) => {
        if (state.sheet !== previous.sheet) redraw();
        if (state.noteSelection !== previous.noteSelection) this.showSelection();
      }),
    ];
    this.resizeObserver = new ResizeObserver(redraw);
    this.resizeObserver.observe(this.host);
    this.refresh();
  }

  unmount(): void {
    for (const stop of this.unsubscribes.splice(0)) stop();
    this.resizeObserver?.disconnect();
    cancelAnimationFrame(this.pending);
    this.follow.detach();
  }

  /** Draws again soon (once per frame at most) when something the sheet depends on changed. */
  private schedule(): void {
    if (this.pending || !this.hasChanged()) return;
    this.pending = requestAnimationFrame(() => {
      this.pending = 0;
      this.refresh();
    });
  }

  /** The things a drawing depends on: when none of them is a different object, the sheet is already right. */
  private inputs(): readonly unknown[] {
    const { project } = this.s.doc.getState();
    const patternId = this.s.view.getState().currentPatternId;
    const pattern = patternId ? project.patterns[patternId] : undefined;
    return [
      pattern,
      project.transport,
      project.chords,
      project.lyrics,
      project.channels,
      this.s.editor.getState().sheet,
      this.s.session.getState().selectedChannelId,
      patternId,
      this.host.clientWidth,
    ];
  }

  private hasChanged(): boolean {
    const now = this.inputs();
    return now.length !== this.lastKey.length || now.some((value, i) => value !== this.lastKey[i]);
  }

  /** Draws now if something changed since the last drawing (a key press must act on what is on the page, not on last frame's). */
  refreshIfStale(): void {
    if (this.hasChanged()) this.refresh();
  }

  /** Engraves and draws now. */
  refresh(): void {
    this.lastKey = this.inputs();
    this.state = sheetState(this.s);
    if (!this.state) {
      this.content.replaceChildren();
      this.layout = null;
      this.events = [];
      this.stops = [];
      this.follow.detach();
      this.heads.clear();
      this.onChange?.();
      return;
    }
    const zoom = this.s.editor.getState().sheet.zoom / 100;
    const width = Math.max(MIN_PAGE_WIDTH, this.host.clientWidth - SCROLLBAR_ROOM) / zoom;
    const rendered = renderSheet(this.state.score, { width, zoom });
    this.layout = rendered.layout;
    // Drawing again (after a typed note, say) must not throw the page back to the top.
    const scrolled = this.host.scrollTop;
    this.content.innerHTML = `${rendered.systems.join('')}${textVersion(this.state.score)}`;
    this.host.scrollTop = scrolled;
    this.events = scoreEvents(this.state.score);
    this.stops = cursorStops(this.events);
    this.indexHeads();
    this.shownSelection = new Set();
    this.showSelection();
    this.follow.attach(this.content);
    this.clampCursor();
    this.drawCursor();
    this.onChange?.();
  }

  /** The score, or null when the pattern has no notes to show. */
  get score(): Score | null {
    return this.state?.score ?? null;
  }

  get patternId(): PatternId | null {
    return this.state?.patternId ?? null;
  }

  private indexHeads(): void {
    this.heads = new Map();
    for (const element of this.content.querySelectorAll('.ag-head')) {
      const id = (element as HTMLElement).dataset.note ?? '';
      this.heads.set(id, [...(this.heads.get(id) ?? []), element]);
    }
  }

  /** Marks the selected notes (the same selection the piano roll uses): only the notes that changed are touched. */
  showSelection(): void {
    const wanted = new Set<string>(this.s.editor.getState().noteSelection);
    for (const id of this.shownSelection) {
      if (!wanted.has(id)) for (const element of this.heads.get(id) ?? []) element.classList.remove('ag-sel');
    }
    for (const id of wanted) {
      if (!this.shownSelection.has(id)) for (const element of this.heads.get(id) ?? []) element.classList.add('ag-sel');
    }
    this.shownSelection = wanted;
  }

  // ---- the cursor ----

  private clampCursor(): void {
    const length = this.score ? this.score.measures.length * ticksPerBar(this.score.timeSig) : 0;
    this.cursor.tick = Math.max(0, Math.min(this.cursor.tick, length));
  }

  /** Moves the cursor (and the view with it). */
  setCursor(tick: Tick, key?: number): void {
    this.cursor = { tick, key: key ?? this.cursor.key };
    this.clampCursor();
    this.drawCursor();
    this.onChange?.();
  }

  /** Shows or hides the cursor box (it is shown while the keyboard has the focus). */
  setCursorShown(isShown: boolean): void {
    this.isCursorShown = isShown;
    this.drawCursor();
  }

  /** Puts the dashed box where the cursor is, on the system that holds it, and scrolls that system into view. */
  drawCursor(): void {
    for (const rect of this.content.querySelectorAll<SVGRectElement>('.ag-cursor')) rect.setAttribute('visibility', 'hidden');
    if (!this.isCursorShown || !this.layout || !this.score) return;
    const found = locateTick(this.layout, ticksPerBar(this.score.timeSig), this.cursor.tick);
    if (!found) return;
    const svg = this.content.querySelector<SVGElement>(`svg[data-system="${found.system.index}"]`);
    const rect = svg?.querySelector<SVGRectElement>('.ag-cursor');
    if (!svg || !rect) return;
    const top = (found.system.staffTops[0] as number) - 2 * SPACE;
    const bottom = (found.system.staffTops[found.system.staffTops.length - 1] as number) + 6 * SPACE;
    rect.setAttribute('x', String(found.x - 1.4 * SPACE));
    rect.setAttribute('y', String(top));
    rect.setAttribute('width', String(2.8 * SPACE));
    rect.setAttribute('height', String(bottom - top));
    rect.setAttribute('visibility', 'visible');
    if (found.system.index !== this.cursorSystem || this.isOutOfView(svg)) this.scrollTo(svg);
    this.cursorSystem = found.system.index;
  }

  private isOutOfView(svg: Element): boolean {
    const box = svg.getBoundingClientRect();
    const view = this.host.getBoundingClientRect();
    return box.top < view.top || box.bottom > view.bottom;
  }

  /** Brings a system into the window in one jump (never a glide: a keyboard user moves fast). */
  private scrollTo(svg: Element): void {
    const top = svg.getBoundingClientRect().top - this.host.getBoundingClientRect().top + this.host.scrollTop;
    this.host.scrollTo({ top: Math.max(0, top - 12), behavior: 'auto' });
  }

  // ---- looking things up ----

  /** The cursor stop (a note, chord or rest) that starts at a tick, or the nearest one before it. */
  stopAtOrBefore(tick: Tick): ScoreEvent | null {
    let found: ScoreEvent | null = null;
    for (const stop of this.stops) {
      if (stop.tick > tick) break;
      found = stop;
    }
    return found;
  }

  /** The nearest column to a point in a system (layout pixels), as a pattern tick. */
  tickAtX(systemIndex: number, x: number): Tick | null {
    const system = this.layout?.systems[systemIndex];
    if (!system) return null;
    const measure = system.measures.find((candidate) => x < candidate.left + candidate.width) ?? system.measures[system.measures.length - 1];
    if (!measure) return null;
    let best = measure.columns[0];
    for (const column of measure.columns) if (best && Math.abs(measure.left + column.x - x) < Math.abs(measure.left + best.x - x)) best = column;
    return best ? measure.measure.startTick + best.tick : null;
  }

  /** The ids of the notes drawn at a stop. */
  noteIdsAt(stop: ScoreEvent): NoteId[] {
    return stop.noteIds;
  }

  /** The length of one bar in ticks. */
  get barTicks(): Tick {
    return this.score ? ticksPerBar(this.score.timeSig) : meterOf({ num: 4, den: 4 }).barTicks;
  }
}

/** The score as plain text, one paragraph per bar, kept out of sight for screen readers that browse the page. */
function textVersion(score: Score): string {
  const bars = Math.min(score.measures.length, MAX_TEXT_BARS);
  const lines: string[] = [];
  for (let bar = 0; bar < bars; bar++) lines.push(`<p>${escapeHtml(describeBar(score, bar))}</p>`);
  if (score.measures.length > bars) lines.push(`<p>And ${score.measures.length - bars} more bars: move the cursor to hear them.</p>`);
  return `<div class="ag-sheet-text">${lines.join('')}</div>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
