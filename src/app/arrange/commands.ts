/**
 * The arranger as user actions (the playlist's menus and right-click): each is one undo step and
 * returns a plain line for a toast. No AI involved: the same deterministic craft the AI's actions
 * use (`run.ts`).
 */
import type { Draft } from 'immer';
import type { Project, Tick } from '@core/model/types';
import { songLength } from '@core/query/playlist';
import { barSpan } from '@core/time/bars';
import { ticksPerBar } from '@core/time/ppq';
import type { Services } from '../services';
import { ArrangeInputError, developInDraft, refreshInDraft, transitionInDraft, varyInDraft, type RunResult, type TransitionKind } from './run';

export interface CommandResult {
  message: string;
  /** Whether the project changed (an undo step was made). */
  changed: boolean;
  /** The span to select or play after (when it edited one). */
  touched: { from: Tick; to: Tick } | null;
}

function run(s: Services, label: string, fn: (d: Draft<Project>, base: Project) => RunResult): CommandResult {
  const base = s.doc.getState().project;
  let result: RunResult | null = null;
  let error: string | null = null;
  const changed = !!s.history.transact(label, (d) => {
    try {
      result = fn(d, base);
    } catch (e) {
      if (e instanceof ArrangeInputError) error = e.message;
      else throw e;
    }
  });
  const r = result as RunResult | null;
  if (error) return { message: error, changed, touched: null };
  const first = r?.changes[0] ?? 'Nothing to change';
  const bugs = r?.warnings.length ? ` Still to look at: ${r.warnings.slice(0, 2).join('; ')}.` : '';
  return { message: `${first}.${bugs}`, changed, touched: r?.touched ?? null };
}

/** Fills, small changes and transitions over [from, to) (default: the whole song), one undo step. */
export function developSong(s: Services, range?: { from: Tick; to: Tick } | null): CommandResult {
  const p = s.doc.getState().project;
  if (songLength(p) === 0) return { message: 'The playlist is empty: place your patterns on it first, then develop them.', changed: false, touched: null };
  const where = range ? barSpan(range.from, range.to, p.transport.timeSig) : 'the song';
  return run(s, `Develop ${where}`, (d, base) =>
    developInDraft(d, s, base, { ...(range ? { from: range.from, to: range.to } : {}), fills: true, transitions: true, fx: true, cleanup: true }),
  );
}

/** A fill that replaces the drums at the end of the bar containing `tick`. */
export function addFillAt(s: Services, tick: Tick, beats = 2): CommandResult {
  const bar = ticksPerBar(s.doc.getState().project.transport.timeSig);
  const barNo = Math.floor(tick / bar) + 1;
  return run(s, `Add a fill at bar ${barNo}`, (d, base) => varyInDraft(d, s, base, { kind: 'fill', bar: barNo, beats }));
}

/** A transition into the bar at (or after) `tick`: the recipe its sections call for. */
export function addTransitionAt(s: Services, tick: Tick, kind: TransitionKind = 'auto'): CommandResult {
  const bar = ticksPerBar(s.doc.getState().project.transport.timeSig);
  const at = Math.round(tick / bar) * bar;
  return run(s, `Add a transition at bar ${at / bar + 1}`, (d, base) => transitionInDraft(d, s, base, { at, kind }));
}

/** Rebuilds variations from their sources (after the sources were edited by hand). */
export function refreshVariations(s: Services): CommandResult {
  return run(s, 'Refresh variations', (d, base) => refreshInDraft(d, s, base));
}
