/**
 * Running note scripts (piano-roll tools) on the selected channel's notes: builds the script's
 * context, checks what it returns, and applies the result as one undo step, or live through a
 * history gesture while its dialog is open.
 */
import {
  resolveValues,
  type AnyNoteScriptDef,
  type NoteScriptContext,
  type ParamValue,
  type ScriptNote,
} from '@agstudio/sdk';
import { seeded } from '@agstudio/sdk/notes';
import type { Gesture } from '@core/history/history';
import { newId } from '@core/model/ids';
import type { ChannelId, Note, NoteId, PatternId, SongKey } from '@core/model/types';
import { applyNoteReplacement, planNoteReplacement, type NoteReplacement } from '@core/ops/note-replace';
import { notesSorted, patternLength } from '@core/query/queries';
import { PPQ, ticksPerBar } from '@core/time/ppq';
import { gridTicks } from '@core/time/snap';
import type { Services } from '../services';

/** A script returning more notes than this is treated as broken. */
export const MAX_SCRIPT_NOTES = 50_000;

export class NoteScriptError extends Error {
  override name = 'NoteScriptError';
}

/** What a script runs on: the notes plus the piano roll's grid, the bar and pattern lengths and the key. */
export interface ScriptInput {
  notes: readonly Note[];
  grid: number;
  bar: number;
  length: number;
  key: SongKey | null;
}

/** Where a script's result goes, and what it works on. */
export interface ScriptTarget extends ScriptInput {
  channelId: ChannelId;
  patternId: PatternId;
  /** True when the input is the note selection (the result is selected afterwards). */
  fromSelection: boolean;
}

/** The selected instrument channel's notes in the current pattern (the selection, or all of them). */
export function scriptTarget(s: Services): ScriptTarget | null {
  const project = s.doc.getState().project;
  const channelId = s.session.getState().selectedChannelId;
  const patternId = s.view.getState().currentPatternId;
  const pattern = patternId ? project.patterns[patternId] : undefined;
  const channel = channelId ? project.channels[channelId] : undefined;
  if (!channelId || !patternId || !pattern || channel?.kind !== 'instrument') return null;
  const all = notesSorted(pattern.notes[channelId]);
  const sel = new Set(s.editor.getState().noteSelection);
  const selected = sel.size > 0 ? all.filter((n) => sel.has(n.id)) : [];
  const { timeSig, key } = project.transport;
  const pr = s.editor.getState().pianoRoll;
  return {
    channelId,
    patternId,
    notes: selected.length > 0 ? selected : all,
    fromSelection: selected.length > 0,
    grid: gridTicks(pr.snap, timeSig, pr.pxPerTick),
    bar: ticksPerBar(timeSig),
    length: patternLength(pattern, timeSig),
    key: key ?? null,
  };
}

/** A frozen copy of a note as scripts see it. */
function toScriptNote(n: Note): ScriptNote {
  const out: ScriptNote = { id: n.id, tick: n.tick, length: n.length, key: n.key, velocity: n.velocity };
  if (n.pan !== undefined) out.pan = n.pan;
  if (n.release !== undefined) out.release = n.release;
  if (n.fine !== undefined) out.fine = n.fine;
  if (n.muted !== undefined) out.muted = n.muted;
  return Object.freeze(out);
}

/**
 * The seed of a script's `rand()`: its id, the notes it gets and its `seed` param when it has one.
 * Other param values don't count, so dragging a knob in the dialog doesn't reshuffle the result.
 */
export function scriptSeed(id: string, notes: readonly Note[], values: Readonly<Record<string, ParamValue>>): number {
  let h = 0x811c9dc5;
  const mix = (v: number) => {
    h ^= v | 0;
    h = Math.imul(h, 0x01000193);
  };
  for (const c of `${id}|${String(values.seed ?? '')}`) mix(c.charCodeAt(0));
  for (const n of notes) {
    mix(n.tick);
    mix(n.key);
    mix(n.length);
  }
  return h >>> 0;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Checks a script's return value and copies it into plain notes. Throws NoteScriptError when it's malformed. */
export function checkScriptOutput(name: string, out: unknown): ScriptNote[] {
  if (!Array.isArray(out)) throw new NoteScriptError(`${name} must return an array of notes (got ${typeof out})`);
  if (out.length > MAX_SCRIPT_NOTES)
    throw new NoteScriptError(`${name} returned ${out.length} notes (the limit is ${MAX_SCRIPT_NOTES})`);
  return out.map((raw: unknown, i) => {
    if (!raw || typeof raw !== 'object') throw new NoteScriptError(`${name}: note ${i} is not an object`);
    const r = raw as Record<string, unknown>;
    for (const field of ['tick', 'length', 'key', 'velocity'])
      if (!isNum(r[field])) throw new NoteScriptError(`${name}: note ${i} has no valid ${field}`);
    const note: ScriptNote = {
      ...(typeof r.id === 'string' ? { id: r.id } : {}),
      tick: r.tick as number,
      length: r.length as number,
      key: r.key as number,
      velocity: r.velocity as number,
    };
    for (const field of ['pan', 'release', 'fine'] as const) {
      const v = r[field];
      if (v === undefined) continue;
      if (!isNum(v)) throw new NoteScriptError(`${name}: note ${i} has an invalid ${field}`);
      note[field] = v;
    }
    if (r.muted !== undefined) {
      if (typeof r.muted !== 'boolean') throw new NoteScriptError(`${name}: note ${i} has an invalid muted flag`);
      note.muted = r.muted;
    }
    return note;
  });
}

/** Runs a script on some notes and returns its checked result. Throws NoteScriptError when the script fails. */
export function runNoteScript(
  def: AnyNoteScriptDef,
  input: ScriptInput,
  values?: Readonly<Record<string, unknown>>,
): ScriptNote[] {
  const resolved = resolveValues(def.params, values) as Record<string, ParamValue>;
  const ctx: NoteScriptContext = {
    notes: Object.freeze(input.notes.map(toScriptNote)),
    values: Object.freeze({ ...resolved }),
    ppq: PPQ,
    grid: Math.max(1, input.grid),
    bar: input.bar,
    length: input.length,
    key: input.key ? Object.freeze({ root: input.key.root, scale: input.key.scale }) : null,
    rand: seeded(scriptSeed(def.id, input.notes, resolved)),
  };
  let out: unknown;
  try {
    out = def.run(Object.freeze(ctx));
  } catch (err) {
    throw new NoteScriptError(`${def.name} failed: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  return checkScriptOutput(def.name, out);
}

/** Runs a script on the piano roll's notes as one undo step. Returns false (and toasts) when it fails. */
export function applyNoteScript(
  s: Services,
  def: AnyNoteScriptDef,
  values?: Readonly<Record<string, unknown>>,
  target: ScriptTarget | null = scriptTarget(s),
): boolean {
  if (!target) return false;
  let plan: NoteReplacement;
  try {
    plan = planNoteReplacement(target.notes, runNoteScript(def, target, values), () => newId.note());
  } catch (err) {
    reportScriptError(s, err);
    return false;
  }
  s.history.transact(def.name, (d) => applyNoteReplacement(d, target.patternId, target.channelId, plan));
  if (target.fromSelection) s.editor.getState().selectNotes(plan.write.map((n) => n.id));
  return true;
}

export function reportScriptError(s: Services, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message, err instanceof NoteScriptError ? err.cause : err);
  s.session.getState().toast(message, 'error');
}

/**
 * A script's result shown live while its dialog is open: every `update` re-runs the script on the
 * original notes and rewrites the document through one history gesture (the engine plays the
 * preview). `commit` keeps it as one undo step; `cancel` restores the notes and the selection.
 */
export class ScriptPreview {
  private gesture: Gesture | null = null;
  /** Ids for the new notes, reused across updates so a preview only rewrites what changed. */
  private readonly pool: NoteId[] = [];
  private added = 0;
  private readonly selectionBefore: readonly NoteId[];
  /** The message of the last failed update (null after a successful one). */
  error: string | null = null;

  constructor(
    private readonly s: Services,
    readonly def: AnyNoteScriptDef,
    readonly target: ScriptTarget,
  ) {
    this.selectionBefore = s.editor.getState().noteSelection;
  }

  /** Shows the result for `values`. Returns false (keeping the last preview) when the script fails. */
  update(values?: Readonly<Record<string, unknown>>): boolean {
    const { target } = this;
    let plan: NoteReplacement;
    try {
      plan = planNoteReplacement(target.notes, runNoteScript(this.def, target, values), (i) => {
        while (this.pool.length <= i) this.pool.push(newId.note());
        return this.pool[i] as NoteId;
      });
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      return false;
    }
    this.error = null;
    const stale = this.pool.slice(plan.added, this.added);
    this.added = plan.added;
    // Another edit may have committed the gesture (it can't while the modal dialog is up, but be safe).
    if (!this.gesture?.active) this.gesture = this.s.history.gesture(this.def.name);
    this.gesture.update((d) => applyNoteReplacement(d, target.patternId, target.channelId, plan, stale));
    if (target.fromSelection) this.s.editor.getState().selectNotes(plan.write.map((n) => n.id));
    return true;
  }

  commit(): void {
    this.gesture?.commit();
    this.gesture = null;
  }

  cancel(): void {
    this.gesture?.cancel();
    this.gesture = null;
    this.s.editor.getState().selectNotes(this.selectionBefore);
  }
}
