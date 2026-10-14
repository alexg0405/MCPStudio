/** Notes in patterns: write, clear, piano-roll tools and step-sequencer tools. */
import type { Note, Pattern, TimeSignature } from '@core/model/types';
import { newId } from '@core/model/ids';
import { applyNoteReplacement, planNoteReplacement } from '@core/ops/note-replace';
import { addNotes } from '@core/ops/notes';
import { clearSteps, fillSteps, randomizeSteps, reverseSteps, rotateSteps, shiftSteps } from '@core/ops/steps';
import { patternLength } from '@core/query/queries';
import { PPQ, TICKS_PER_STEP } from '@core/time/ppq';
import { formatValue, type ParamSpec, type ParamSpecs, type ParamValue } from '@agstudio/sdk';
import { NoteScriptError, runNoteScript } from '../../actions/note-scripts';
import * as S from '../schema/parts';
import { fail, type OpModule } from './context';
import { coerceParam, findParamId, isObj, lower, num, str } from './values';

/** Pattern length on a draft (the memoized query would keep a stale answer for the same draft object). */
const lengthOf = (pat: Pattern, ts: TimeSignature) => patternLength({ ...pat }, ts);

/** A channel's notes on a draft, sorted by start then key. */
const notesOf = (pat: Pattern, cid: string): Note[] =>
  Object.values(pat.notes[cid as keyof Pattern['notes']] ?? {}).sort((a, b) => a.tick - b.tick || a.key - b.key);

export const notes: OpModule = {
  schemas: [
    S.op(
      'write_notes',
      'Writes notes for one channel in a pattern.',
      {
        pattern: S.PATTERN,
        channel: S.CHANNEL,
        replace: S.bool("true (default) replaces that channel's notes in the pattern; false adds to them."),
        notes: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              step: S.num('1/16 step from the pattern start (bar b beat q = (b-1)*16+(q-1)*4); fractions allowed.'),
              len: S.num('Length in steps (default 1).'),
              key: S.int('MIDI note (C4 = 60). Omit for drum channels (they play their root key).'),
              vel: S.num('Velocity 0..1 (default 0.8).'),
            },
            required: ['step'],
          },
        },
      },
      ['pattern', 'channel', 'notes'],
    ),
    S.op(
      'clear_notes',
      "Removes a channel's notes from a pattern (all channels when channel is omitted).",
      { pattern: S.PATTERN, channel: S.CHANNEL },
      ['pattern'],
    ),
    S.op(
      'note_tool',
      'Runs a piano-roll tool from the catalog ("Piano-roll tools") on one channel’s notes in a pattern: quantize, humanize, strum, arpeggiate, legato, chords, transpose, generate… It sees notes written earlier in the same answer.',
      {
        tool: S.str('Tool id from the catalog, e.g. "agstudio.notes.humanize".'),
        pattern: S.PATTERN,
        channel: S.CHANNEL,
        params: { ...S.PARAMS, description: 'Tool settings: name = param id from the catalog; value in its unit.' },
      },
      ['tool', 'pattern', 'channel'],
    ),
    S.op(
      'steps',
      'Step-sequencer tools for one channel in a pattern (drum and other step parts).',
      {
        pattern: S.PATTERN,
        channel: S.CHANNEL,
        action: {
          type: 'string',
          enum: ['fill', 'rotate', 'shift', 'reverse', 'randomize', 'clear'],
          description:
            'fill = a hit every N steps; rotate wraps around the pattern; shift moves without wrapping; randomize replaces the steps with random hits.',
        },
        every: S.int('fill: a hit every N steps (2 = eighths, 4 = quarter notes, 8 = half notes).'),
        by: S.int('rotate/shift: how many 1/16 steps (negative = earlier).'),
        density: S.num('randomize: share of steps that get a hit, 0..1 (default 0.4).'),
      },
      ['pattern', 'channel', 'action'],
    ),
  ],
  prompt: {
    id: 'notes',
    order: 85,
    text: 'Writing notes directly ("write_notes"): steps from 0 within the pattern, keys as MIDI numbers (C4 = 60), lengths in steps. Drum channels take no key.',
  },
  handlers: {
    write_notes: (a, c) => {
      const { d } = c;
      const pid = c.focus.writable(c.pattern(a.pattern));
      const cid = c.channel(a.channel);
      const ch = d.channels[cid]!;
      if (ch.kind !== 'instrument') fail(`“${ch.name}” doesn't play notes`);
      const root = ch.kind === 'instrument' ? ch.rootKey : 60;
      const raw = Array.isArray(a.notes) ? a.notes : [];
      const notes: Note[] = [];
      for (const n of raw) {
        if (!isObj(n)) continue;
        const step = num(n.step);
        if (step === undefined || step < 0) continue;
        const len = num(n.len) ?? 1;
        const key = num(n.key);
        const vel = num(n.vel);
        notes.push({
          id: newId.note(),
          tick: Math.round(step * TICKS_PER_STEP),
          length: Math.max(10, Math.round(Math.max(0.05, len) * TICKS_PER_STEP)),
          key: Math.max(0, Math.min(127, Math.round(key ?? root))),
          velocity: Math.max(0, Math.min(1, vel !== undefined && vel > 1 ? vel / 127 : (vel ?? 0.8))),
        });
      }
      const pat = d.patterns[pid]!;
      if (a.replace !== false) {
        // Selected notes (a notes focus): only those are replaced.
        const only = c.focus.notes(pid, cid);
        if (only) for (const id of only) delete pat.notes[cid]?.[id];
        else delete pat.notes[cid];
      }
      addNotes(d, pid, cid, notes.slice(0, 1024));
      // Grow an explicit pattern length to fit the notes.
      const end = Math.max(0, ...notes.map((n) => n.tick + n.length));
      if (pat.length !== undefined && end > pat.length) pat.length = Math.ceil(end / c.bar()) * c.bar();
      return `Wrote ${notes.length} note${notes.length === 1 ? '' : 's'} for “${ch.name}” in “${pat.name}”`;
    },

    clear_notes: (a, c) => {
      const { d } = c;
      const pid = c.focus.writable(c.pattern(a.pattern));
      const pat = d.patterns[pid]!;
      if (a.channel !== undefined) {
        const cid = c.channel(a.channel);
        const only = c.focus.notes(pid, cid);
        if (only) for (const id of only) delete pat.notes[cid]?.[id];
        else delete pat.notes[cid];
        return `Cleared “${d.channels[cid]!.name}” in “${pat.name}”`;
      }
      c.focus.wholePattern(pid, null, 'clear notes');
      pat.notes = {} as never;
      return `Cleared “${pat.name}”`;
    },

    note_tool: (a, c) => {
      const { d, s } = c;
      const id = str(a.tool) ?? fail('which tool?');
      const def =
        s.plugins.script(id) ??
        s.plugins.scripts().find((e) => lower(e.def.name) === lower(id) || lower(e.def.id) === lower(id))?.def;
      if (!def) fail(`there is no piano-roll tool "${id}"`);
      const pid = c.focus.writable(c.pattern(a.pattern));
      const cid = c.channel(a.channel);
      const ch = d.channels[cid]!;
      if (ch.kind !== 'instrument') fail(`“${ch.name}” has no notes`);
      const pat = d.patterns[pid]!;
      const values: Record<string, ParamValue> = {};
      const set: string[] = [];
      if (Array.isArray(a.params)) {
        const specs = def!.params as ParamSpecs;
        for (const e of a.params) {
          if (!isObj(e) || typeof e.name !== 'string') continue;
          const pidm = findParamId(specs, e.name);
          const v = pidm ? coerceParam(specs[pidm] as ParamSpec, e.value) : null;
          if (!pidm || v === null) {
            c.warn(`${def!.name}: can't set "${e.name}" to ${JSON.stringify(e.value)}`);
            continue;
          }
          values[pidm] = v;
          set.push(`${(specs[pidm] as ParamSpec).label ?? pidm} ${formatValue(specs[pidm] as ParamSpec, v)}`);
        }
      }
      // On the draft: notes written earlier in this answer are shaped too. Selected notes only, in a notes focus.
      const only = c.focus.notes(pid, cid);
      const notes = notesOf(pat as Pattern, cid).filter((n) => !only || only.has(n.id));
      let out;
      try {
        out = runNoteScript(
          def!,
          {
            notes,
            grid: PPQ / 4,
            bar: c.bar(),
            length: lengthOf(pat as Pattern, d.transport.timeSig),
            key: d.transport.key ?? null,
          },
          values,
        );
      } catch (err) {
        fail(err instanceof NoteScriptError ? err.message : String(err));
      }
      if (notes.length === 0 && out!.length === 0)
        fail(`“${ch.name}” has no notes in “${pat.name}” for ${def!.name} to work on`);
      const plan = planNoteReplacement(notes, out!, () => newId.note());
      applyNoteReplacement(d, pid, cid, plan);
      return `${def!.name} on “${ch.name}” in “${pat.name}”${set.length ? ` (${set.join(', ')})` : ''}`;
    },

    steps: (a, c) => {
      const { d } = c;
      const pid = c.focus.writable(c.pattern(a.pattern));
      const cid = c.channel(a.channel);
      const ch = d.channels[cid]!;
      if (ch.kind !== 'instrument') fail(`“${ch.name}” has no steps`);
      c.focus.wholePattern(pid, cid, 'steps');
      const rootKey = ch.kind === 'instrument' ? ch.rootKey : 60;
      const where = `“${ch.name}” in “${d.patterns[pid]!.name}”`;
      const by = Math.round(num(a.by) ?? 1);
      switch (str(a.action)) {
        case 'fill': {
          const every = Math.max(1, Math.min(64, Math.round(num(a.every) ?? 4)));
          fillSteps(d, pid, cid, every, { rootKey });
          return `Filled every ${every} steps of ${where}`;
        }
        case 'rotate':
          rotateSteps(d, pid, cid, by);
          return `Rotated ${where} by ${by} steps`;
        case 'shift':
          shiftSteps(d, pid, cid, by);
          return `Shifted ${where} by ${by} steps`;
        case 'reverse':
          reverseSteps(d, pid, cid);
          return `Reversed ${where}`;
        case 'randomize': {
          const density = Math.min(1, Math.max(0, num(a.density) ?? 0.4));
          randomizeSteps(d, pid, cid, { rootKey, rand: Math.random, density });
          return `Randomized ${where} (${Math.round(density * 100)}% of the steps)`;
        }
        case 'clear':
          clearSteps(d, pid, cid);
          return `Cleared the steps of ${where}`;
        default:
          return fail(`unknown step action "${String(a.action)}"`);
      }
    },
  },
};
