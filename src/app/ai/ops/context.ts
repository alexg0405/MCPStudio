/**
 * What every AI action handler gets: the draft being edited, lookups that find things by id, exact
 * name, mixer number or an @ref created earlier in the same answer, and the answer's running state
 * (changes, warnings, UI requests). Handlers return a change line or throw through `fail()`.
 *
 * Inside the recipe, read the draft with plain loops (or `current(d)`): memoized queries keep the
 * draft proxy and would return stale results for a later action.
 */
import type { Draft } from 'immer';
import { ticksPerBar } from '@core/time/ppq';
import type {
  ChannelId,
  Clip,
  ClipId,
  GroupId,
  InsertId,
  LaneId,
  MidiFxSlotId,
  PatternId,
  PluginInstance,
  Project,
  SlotId,
  SnapshotId,
  Tick,
} from '@core/model/types';
import { MASTER } from '@core/model/types';
import { formatValue, type ParamSpec, type ParamSpecs, type PluginDef } from '@agstudio/sdk';
import type { BeatPlan } from '../../assistant/apply';
import { presetChoices, presetValues } from '../../presets';
import type { Services } from '../../services';
import type { PromptSection } from '../prompt-section';
import type { AiAction, AiAnswer } from '../schema';
import type { OpSchema } from '../schema/parts';
import { createFocusGuard, type FocusGuard } from './focus-guard';
import type { AfterEdit, ApplyContext } from './types';
import { coerceParam, findParamId, isObj, lower, num, str } from './values';

export class ActionError extends Error {}

export const fail = (message: string): never => {
  throw new ActionError(message);
};

export type Ref =
  | { kind: 'channel'; id: ChannelId }
  | { kind: 'insert'; id: InsertId }
  | { kind: 'group'; id: GroupId }
  | { kind: 'effect'; insertId: InsertId; slotId: SlotId }
  | { kind: 'midiFx'; channelId: ChannelId; slotId: MidiFxSlotId }
  | { kind: 'pattern'; id: PatternId };

/** The answer's running state, shared by every action of it. */
export interface AnswerState {
  refs: Map<string, Ref>;
  changes: string[];
  warnings: string[];
  /** What the app itself did after the edit (settings, selection, windows). */
  ui: string[];
  /** What the answer's look-ups (query actions) found. */
  queries: { tool: string; args: Record<string, unknown>; result: unknown }[];
  after: AfterEdit[];
  beatPlan: BeatPlan | null;
  /** Selections are applied after the edit (the stores then point at committed things). */
  selectChannel: ChannelId | null;
  selectPattern: PatternId | null;
  /** Clips this answer created, moved, split or re-pointed. */
  clips: Set<ClipId>;
  /** The playlist span the answer edited. */
  touched: { from: Tick; to: Tick } | null;
  /** Mixer tracks whose fader the AI set itself (auto-level leaves them alone). */
  pinnedInserts: Set<InsertId>;
  /** Per-module state, keyed by module. */
  bag: Map<string, unknown>;
  /** Edits that reach outside the part being worked on (refused, or allowed once the musician approved). */
  outsideFocus: string[];
}

export function newAnswerState(): AnswerState {
  return {
    refs: new Map(),
    changes: [],
    warnings: [],
    ui: [],
    queries: [],
    after: [],
    beatPlan: null,
    selectChannel: null,
    selectPattern: null,
    clips: new Set(),
    touched: null,
    pinnedInserts: new Set(),
    bag: new Map(),
    outsideFocus: [],
  };
}

export interface OpContext {
  readonly services: Services;
  readonly draft: Draft<Project>;
  /** The draft, typed as a project (for read-only helpers). */
  readonly project: Project;
  /** The project before this answer (committed state; safe for memoized queries). */
  readonly base: Project;
  readonly answer: AiAnswer;
  readonly apply: ApplyContext;
  readonly state: AnswerState;
  readonly focus: FocusGuard;
  /** Ticks per bar in the current time signature. */
  bar(): Tick;
  channel(raw: unknown): ChannelId;
  insert(raw: unknown): InsertId;
  effect(raw: unknown): { insertId: InsertId; slotId: SlotId };
  /** A mixer group by id (grp_…), exact name or @ref of one made earlier in the answer. */
  group(raw: unknown): GroupId;
  /** A mixer snapshot by id (snap_…) or name (exact, else the only partial match). */
  snapshot(raw: unknown): SnapshotId;
  /** A pattern by "current", id, name or @ref (then redirected to the part's copy, in a focus). */
  pattern(raw: unknown): PatternId;
  plugin(raw: unknown, kind: PluginDef['kind']): PluginDef;
  /** A 1-based playlist track; fails when there is no such track. */
  lane(raw: unknown): LaneId;
  /** A clip by `clip` id, or by `track` + `bar` (the clip playing there). */
  clip(a: AiAction): Clip;
  remember(raw: unknown, r: Ref): void;
  warn(message: string): void;
  /** An extra change line (before the action's own one). */
  note(change: string): void;
  /** Records the playlist span (and clips) an action edited. */
  touch(from: Tick, to: Tick, clipIds?: readonly ClipId[]): void;
  /** Applies a preset and params from the action to a plugin instance; returns what changed. */
  settings(inst: Draft<PluginInstance>, def: PluginDef, a: AiAction): string[];
}

export function createOpContext(
  s: Services,
  d: Draft<Project>,
  answer: AiAnswer,
  apply: ApplyContext,
  state: AnswerState,
): OpContext {
  const project = d as unknown as Project;
  const base = s.doc.getState().project;
  const { refs, warnings } = state;
  const bar = () => ticksPerBar(d.transport.timeSig);

  const fromRef = <K extends Ref['kind']>(ref: string, kind: K): Extract<Ref, { kind: K }> | undefined => {
    if (!ref.startsWith('@')) return undefined;
    const r = refs.get(lower(ref));
    if (!r) fail(`nothing called ${ref} was created earlier in this answer`);
    if (r!.kind !== kind) fail(`${ref} is a ${r!.kind}, not a ${kind}`);
    return r as Extract<Ref, { kind: K }>;
  };
  const byName = <T extends { id: string; name: string }>(items: T[], ref: string): T | undefined => {
    const t = lower(ref);
    const exact = items.filter((x) => lower(x.name) === t);
    if (exact.length === 1) return exact[0];
    const partial = items.filter((x) => lower(x.name).includes(t));
    return partial.length === 1 ? partial[0] : undefined;
  };
  const channel = (raw: unknown): ChannelId => {
    const ref = str(raw) ?? fail('which channel?');
    const r = fromRef(ref, 'channel');
    if (r) return r.id;
    if (d.channels[ref as ChannelId]) return ref as ChannelId;
    const list = d.channelOrder.map((id) => d.channels[id]).filter((c) => !!c) as { id: string; name: string }[];
    return (byName(list, ref)?.id as ChannelId | undefined) ?? fail(`there is no channel "${ref}"`);
  };
  const insert = (raw: unknown): InsertId => {
    const ref = str(raw) ?? (typeof raw === 'number' ? String(raw) : fail('which mixer track?'));
    if (lower(ref) === 'master') return MASTER;
    const r = fromRef(ref, 'insert');
    if (r) return r.id;
    if (d.mixer.inserts[ref as InsertId]) return ref as InsertId;
    const m = /^(?:insert|track|mixer track)?\s*#?(\d+)$/i.exec(ref);
    if (m) return (d.mixer.order[Number(m[1])] as InsertId | undefined) ?? fail(`there is no mixer track ${m[1]}`);
    const list = d.mixer.order.map((id) => d.mixer.inserts[id]).filter((x) => !!x) as {
      id: string;
      name: string;
    }[];
    return (byName(list, ref)?.id as InsertId | undefined) ?? fail(`there is no mixer track "${ref}"`);
  };
  const effect = (raw: unknown): { insertId: InsertId; slotId: SlotId } => {
    const ref = str(raw) ?? fail('which effect?');
    const r = fromRef(ref, 'effect');
    if (r) return { insertId: r.insertId, slotId: r.slotId };
    for (const id of d.mixer.order) {
      const ins = d.mixer.inserts[id];
      if (ins?.fx.some((f) => f.id === ref)) return { insertId: id, slotId: ref as SlotId };
    }
    const m = /^(?:insert\s*)?(\w+)\s*[:/]\s*(?:slot\s*)?(\d+)$/i.exec(ref);
    if (m) {
      const insertId = insert(m[1]);
      const slot = d.mixer.inserts[insertId]?.fx[Number(m[2]) - 1];
      if (slot) return { insertId, slotId: slot.id };
    }
    return fail(`there is no effect "${ref}"`);
  };
  const group = (raw: unknown): GroupId => {
    const ref = str(raw) ?? fail('which mixer group?');
    const r = fromRef(ref, 'group');
    if (r) return r.id;
    const groups = d.mixer.groups ?? [];
    if (groups.some((g) => g.id === ref)) return ref as GroupId;
    return (byName(groups as { id: string; name: string }[], ref)?.id as GroupId | undefined) ?? fail(`there is no mixer group "${ref}"`);
  };
  const snapshot = (raw: unknown): SnapshotId => {
    const ref = str(raw) ?? fail('which mixer snapshot?');
    const snapshots = d.mixSnapshots ?? [];
    if (snapshots.some((x) => x.id === ref)) return ref as SnapshotId;
    return (byName(snapshots as { id: string; name: string }[], ref)?.id as SnapshotId | undefined) ?? fail(`there is no mixer snapshot "${ref}"`);
  };
  const findPattern = (raw: unknown): PatternId => {
    const ref = str(raw) ?? fail('which pattern?');
    if (lower(ref) === 'current') {
      // A pattern made earlier in this answer (add_pattern, beat) is the current one from then on.
      const fresh = state.selectPattern ?? state.beatPlan?.patternId;
      if (fresh && d.patterns[fresh]) return fresh;
      const cur = s.view.getState().currentPatternId;
      if (cur && d.patterns[cur]) return cur;
      return (d.patternOrder[0] as PatternId | undefined) ?? fail('there are no patterns');
    }
    const r = fromRef(ref, 'pattern');
    if (r) return r.id;
    if (d.patterns[ref as PatternId]) return ref as PatternId;
    const list = d.patternOrder.map((id) => d.patterns[id]).filter((x) => !!x) as { id: string; name: string }[];
    return (byName(list, ref)?.id as PatternId | undefined) ?? fail(`there is no pattern "${ref}"`);
  };
  const plugin = (raw: unknown, kind: PluginDef['kind']): PluginDef => {
    const id = str(raw) ?? fail('which plugin?');
    const def =
      s.plugins.get(id) ??
      s.plugins.list(kind).find((e) => lower(e.def.name) === lower(id) || lower(e.def.id) === lower(id))?.def;
    if (!def) fail(`there is no plugin "${id}"`);
    if (def!.kind !== kind) fail(`"${def!.name}" is an ${def!.kind}, not an ${kind}`);
    return def!;
  };
  const lane = (raw: unknown): LaneId => {
    const n = num(raw);
    if (n === undefined) return fail('which playlist track?');
    const id = d.playlist.laneOrder[Math.round(n) - 1];
    return (id as LaneId | undefined) ?? fail(`there is no playlist track ${Math.round(n)} (there are ${d.playlist.laneOrder.length})`);
  };
  const clip = (a: AiAction): Clip => {
    const id = str(a.clip);
    if (id) return (d.playlist.clips[id as ClipId] as Clip | undefined) ?? fail(`there is no clip "${id}"`);
    const at = num(a.bar);
    if (a.track === undefined || at === undefined) return fail('which clip? (give its id, or track and bar)');
    const laneId = lane(a.track);
    const tick = (at - 1) * bar();
    // The clip playing there; of overlapping ones, the latest-starting.
    let hit: Clip | undefined;
    for (const c of Object.values(d.playlist.clips) as Clip[])
      if (c.laneId === laneId && c.start <= tick && tick < c.start + c.length && (!hit || c.start >= hit.start)) hit = c;
    return hit ?? fail(`nothing plays on track ${String(a.track)} at bar ${at}`);
  };
  const remember = (raw: unknown, r: Ref) => {
    const ref = str(raw);
    if (ref) refs.set(lower(ref.startsWith('@') ? ref : `@${ref}`), r);
  };
  const settings = (inst: Draft<PluginInstance>, def: PluginDef, a: AiAction): string[] => {
    const out: string[] = [];
    const presetName = str(a.preset);
    if (presetName) {
      // The musician's own presets first (they name them), then the factory ones.
      const preset = presetChoices(def, s.presets)
        .reverse()
        .find((p) => lower(p.name) === lower(presetName));
      if (!preset) warnings.push(`${def.name} has no preset "${presetName}"`);
      else {
        const values = presetValues(def, preset);
        inst.params = values.params;
        if (values.state !== undefined) inst.state = values.state as never;
        out.push(`preset ${preset.name}`);
      }
    }
    if (Array.isArray(a.params)) {
      const specs = def.params as ParamSpecs;
      for (const e of a.params) {
        if (!isObj(e) || typeof e.name !== 'string') continue;
        const id = findParamId(specs, e.name);
        if (!id) {
          warnings.push(`${def.name} has no setting "${e.name}"`);
          continue;
        }
        const spec = specs[id] as ParamSpec;
        const v = coerceParam(spec, e.value);
        if (v === null) {
          warnings.push(`${def.name} ${id}: can't use ${JSON.stringify(e.value)}`);
          continue;
        }
        inst.params[id] = v;
        out.push(`${spec.label ?? id} ${formatValue(spec, v)}`);
      }
    }
    return out;
  };
  const touch = (from: Tick, to: Tick, clipIds: readonly ClipId[] = []) => {
    state.touched = state.touched
      ? { from: Math.min(state.touched.from, from), to: Math.max(state.touched.to, to) }
      : { from, to };
    for (const id of clipIds) state.clips.add(id);
  };

  const partial: Omit<OpContext, 'focus'> = {
    services: s,
    draft: d,
    project,
    base,
    answer,
    apply,
    state,
    bar,
    channel,
    insert,
    effect,
    group,
    snapshot,
    pattern: (raw) => findPattern(raw),
    plugin,
    lane,
    clip,
    remember,
    warn: (message) => warnings.push(message),
    note: (change) => state.changes.push(change),
    touch,
    settings,
  };
  const focus = createFocusGuard(partial, apply.focus ?? null);
  return { ...partial, focus, pattern: (raw) => focus.resolve(findPattern(raw)) };
}

/** An action handler: returns the change line for the chat (or null), or throws through `fail()`. */
export type OpHandler = (a: AiAction, c: OpContext) => string | null;

/** A group of actions: their handlers, schemas and their section of the studio prompt. */
export interface OpModule {
  handlers: Readonly<Record<string, OpHandler>>;
  schemas: readonly OpSchema[];
  prompt?: PromptSection;
  /** Runs after the answer's last action, inside its undo step. */
  beforeCommit?(c: OpContext): void;
}
