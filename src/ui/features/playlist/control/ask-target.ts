/** The "Ask Studio" pill over the part you would ask about: what it belongs to, its hint, where it sits. */
import type { Project } from '@core/model/types';
import { sectionMatching } from '@core/query/sections';
import { barSpan } from '@core/time/bars';
import { studioMarkSvg } from '../../../controls/studio-mark';
import { askPillPlace, pillText, PILL_HEIGHT, type PillTarget } from '../ask-pill';
import { HEADER_WIDTH, RULER_HEIGHT } from '../layout';
import type { PlaylistContext } from './context';
import { laneRow } from './lanes';

/** The size of the Studio mark in the pill (px). */
const PILL_MARK_SIZE = 13;
/** Until the pill's real width is measured, assume this (px). */
const FALLBACK_PILL_WIDTH = 64;

/** What the pill is about and the hint it shows. */
interface AskTarget extends PillTarget {
  hint: string;
}

/** The part the pill belongs to: the selected clips, else the loop region (grid pixels, with its hint). */
function askTarget(ctx: PlaylistContext, project: Project): AskTarget | null {
  return selectedClipsTarget(ctx, project) ?? loopTarget(ctx, project);
}

/** The box around the selected clips (compact, just the mark, for a single clip). */
function selectedClipsTarget(ctx: PlaylistContext, project: Project): AskTarget | null {
  const { vp } = ctx;
  let start = Infinity;
  let end = -Infinity;
  let firstRow = Infinity;
  let lastRow = -Infinity;
  let count = 0;
  for (const id of ctx.s.editor.getState().clipSelection) {
    const clip = project.playlist.clips[id];
    const row = clip ? laneRow(ctx, project, clip.laneId) : -1;
    if (!clip || row < 0) continue;
    start = Math.min(start, clip.start);
    end = Math.max(end, clip.start + clip.length);
    firstRow = Math.min(firstRow, row);
    lastRow = Math.max(lastRow, row);
    count++;
  }
  if (count === 0) return null;
  const span = barSpan(start, end, project.transport.timeSig);
  const hint =
    count === 1
      ? `Ask Studio to change this clip (${span}), Alt+A: only it changes`
      : `Ask Studio to change the ${count} selected clips (${span}), Alt+A: only they change`;
  return {
    x0: vp.tickToX(start),
    x1: vp.tickToX(end),
    y0: vp.rowToY(firstRow),
    y1: vp.rowToY(lastRow) + vp.rowHeight,
    compact: count === 1,
    hint,
  };
}

/** The loop region (when there is one): the pill sits at its top-right. */
function loopTarget(ctx: PlaylistContext, project: Project): AskTarget | null {
  const loop = ctx.s.view.getState().loop;
  if (!loop || loop.end <= loop.start) return null;
  const section = sectionMatching(project, loop.start, loop.end);
  const span = barSpan(loop.start, loop.end, project.transport.timeSig);
  const what = section ? `${section.name} (${span})` : span;
  return {
    x0: ctx.vp.tickToX(loop.start),
    x1: ctx.vp.tickToX(loop.end),
    y0: 0,
    y1: 0,
    compact: false,
    hint: `Ask Studio to change ${what}, Alt+A: only those bars change`,
  };
}

function hidePill(pill: HTMLElement): void {
  if (pill.style.display !== 'none') pill.style.display = 'none';
}

/** Moves the Ask AI pill (dirty frames only); hidden while dragging and when there is nothing to ask about. */
export function updateAskPill(ctx: PlaylistContext, project: Project): void {
  const { state, vp } = ctx;
  const pill = ctx.els.askPill;
  const target = state.drag ? null : askTarget(ctx, project);
  if (!target) return hidePill(pill);
  const text = pillText(target);
  if (pill.style.display === 'none') pill.style.display = '';
  if (text !== state.pillLabel || !state.pillWidth) {
    // The Studio mark, then the label (fixed strings: no user text goes into the markup).
    pill.innerHTML = studioMarkSvg(PILL_MARK_SIZE) + (text ? `<span>${text}</span>` : '');
    state.pillLabel = text;
    state.pillWidth = pill.offsetWidth;
  }
  if (pill.getAttribute('data-hint') !== target.hint) pill.setAttribute('data-hint', target.hint);
  const size = { w: state.pillWidth || FALLBACK_PILL_WIDTH, h: PILL_HEIGHT };
  const at = askPillPlace(target, size, { w: vp.width, h: vp.height });
  if (!at) return hidePill(pill);
  pill.style.transform = `translate(${HEADER_WIDTH + at.x}px, ${RULER_HEIGHT + at.y}px)`;
}
