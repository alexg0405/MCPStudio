/**
 * What every read tool is built from: the `ReadTool` shape, the `tool()` wrapper that turns a missing thing into
 * `{ error }`, the lookups the actions use, and the units the tools report in (dB, 1-based bars, mixer numbers).
 */
import type { Draft } from 'immer';
import { gainToDecibels } from '@core/model/fader';
import { MASTER, type InsertId, type Project } from '@core/model/types';
import { ticksPerBar } from '@core/time/ppq';
import type { Services } from '../../services';
import { ActionError, createOpContext, newAnswerState, type OpContext } from '../ops/context';
import { isObj, num } from '../ops/values';
import * as S from '../schema/parts';

/** The arguments a tool was called with (untrusted: every value is checked before it is used). */
export type ToolArgs = Record<string, unknown>;

/** One read-only tool: what the AI (and the MCP server) can look at. */
export interface ReadTool {
  name: string;
  description: string;
  /** JSON schema of the arguments (a closed object; every argument is optional unless `required` lists it). */
  schema: { type: 'object'; additionalProperties: false; properties: Record<string, unknown>; required?: string[] };
  /** Returns plain JSON. A bad argument returns `{ error }`. */
  run(services: Services, args?: ToolArgs): unknown;
}

/** Rounds to two decimals: the precision musicians read (bars, dB, pan). */
export const round2 = (value: number) => Math.round(value * 100) / 100;
/** Rounds to three decimals: the precision of steps and times. */
export const round3 = (value: number) => Math.round(value * 1000) / 1000;
/** A fader gain as dB, with silence reported as -100 (JSON has no -Infinity). */
export const gainDb = (gain: number) => (gain <= 0 ? -100 : round2(gainToDecibels(gain)));

/** The committed project (what the tools read; they never change it). */
export const projectOf = (services: Services): Project => services.doc.getState().project;

/** The same lookups the actions use (id, exact name, mixer number…), against the committed project. */
function committedLookups(services: Services): OpContext {
  const project = projectOf(services) as unknown as Draft<Project>;
  return createOpContext(services, project, { message: '', actions: [] }, { previousBeat: null }, newAnswerState());
}

/** Wraps a tool body: ActionErrors (a thing that doesn't exist…) become `{ error }`. */
export function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  run: (services: Services, args: ToolArgs, lookup: OpContext) => unknown,
): ReadTool {
  return {
    name,
    description,
    schema: { type: 'object', additionalProperties: false, properties },
    run: (services, args = {}) => {
      try {
        return run(services, isObj(args) ? args : {}, committedLookups(services));
      } catch (error) {
        if (error instanceof ActionError) return { error: error.message };
        throw error;
      }
    },
  };
}

const ticksPerBarOf = (project: Project) => ticksPerBar(project.transport.timeSig);
/** A tick as a 1-based bar position (bar 1 = tick 0). */
export const barNumberAt = (project: Project, tick: number) => round2(tick / ticksPerBarOf(project) + 1);
/** The end of a span (in ticks) as the 1-based bar it ends in, inclusive: a span ending where bar 5 starts reads 4. */
export const barEndAt = (project: Project, endTick: number) => round2(endTick / ticksPerBarOf(project));
/** A length in ticks as a number of bars. */
export const barCount = (project: Project, ticks: number) => round2(ticks / ticksPerBarOf(project));
/** The tick a 1-based bar number starts at (what a tool's `*_bar` argument means). */
export const tickOfBar = (project: Project, bar: number) => (Math.max(1, Math.round(bar)) - 1) * ticksPerBarOf(project);

/** Mixer number: 0 for Master, 1… for the tracks (what actions accept as "insert"). */
export const mixerNumber = (project: Project, id: InsertId) => project.mixer.order.indexOf(id);
/** A mixer track's name ("Master" for the master). */
export const mixerTrackName = (project: Project, id: InsertId) =>
  id === MASTER ? 'Master' : (project.mixer.inserts[id]?.name ?? id);

/** The 1-based bar range arguments several tools take. */
export const BAR_RANGE = {
  from_bar: S.int('1-based first bar.'),
  to_bar: S.int('1-based last bar (inclusive).'),
};

/** [from, to) in ticks from optional 1-based inclusive bars (no bars = the whole song). */
export function barRange(project: Project, args: ToolArgs): { from: number; to: number } {
  const fromBar = num(args.from_bar);
  const toBar = num(args.to_bar);
  return {
    from: fromBar !== undefined ? tickOfBar(project, fromBar) : 0,
    to: toBar !== undefined ? Math.max(1, Math.round(toBar)) * ticksPerBarOf(project) : Number.POSITIVE_INFINITY,
  };
}
