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
const lengthOf = (pat: Pattern, timeSig: TimeSignature) => patternLength({ ...pat }, timeSig);

/** A channel's notes on a draft, sorted by start then key. */
const notesOf = (pat: Pattern, channelId: string): Note[] =>
  Object.values(pat.notes[channelId as keyof Pattern['notes']] ?? {}).sort((a, b) => a.tick - b.tick || a.key - b.key);

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
    write_notes: (action, context) => {
      const { draft } = context;
      const patternId = context.focus.writable(context.pattern(action.pattern));
      const channelId = context.channel(action.channel);
      const channel = draft.channels[channelId]!;
      if (channel.kind !== 'instrument') fail(`“${channel.name}” doesn't play notes`);
      const root = channel.kind === 'instrument' ? channel.rootKey : 60;
      const raw = Array.isArray(action.notes) ? action.notes : [];
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
      const pat = draft.patterns[patternId]!;
      if (action.replace !== false) {
        // Selected notes (a notes focus): only those are replaced.
        const only = context.focus.notes(patternId, channelId);
        if (only) for (const id of only) delete pat.notes[channelId]?.[id];
        else delete pat.notes[channelId];
      }
      addNotes(draft, patternId, channelId, notes.slice(0, 1024));
      // Grow an explicit pattern length to fit the notes.
      const end = Math.max(0, ...notes.map((n) => n.tick + n.length));
      if (pat.length !== undefined && end > pat.length) pat.length = Math.ceil(end / context.bar()) * context.bar();
      return `Wrote ${notes.length} note${notes.length === 1 ? '' : 's'} for “${channel.name}” in “${pat.name}”`;
    },

    clear_notes: (action, context) => {
      const { draft } = context;
      const patternId = context.focus.writable(context.pattern(action.pattern));
      const pat = draft.patterns[patternId]!;
      if (action.channel !== undefined) {
        const channelId = context.channel(action.channel);
        const only = context.focus.notes(patternId, channelId);
        // Selected notes (a notes focus): only those go.
        if (only && only.size === 0) fail(`none of “${draft.channels[channelId]!.name}”’s notes in “${pat.name}” are selected`);
        if (only) for (const id of only) delete pat.notes[channelId]?.[id];
        else delete pat.notes[channelId];
        return `Cleared “${draft.channels[channelId]!.name}” in “${pat.name}”`;
      }
      context.focus.wholePattern(patternId, null, 'clear notes');
      pat.notes = {} as never;
      return `Cleared “${pat.name}”`;
    },

    note_tool: (action, context) => {
      const { draft, services } = context;
      const id = str(action.tool) ?? fail('which tool?');
      const def =
        services.plugins.script(id) ??
        services.plugins.scripts().find((e) => lower(e.def.name) === lower(id) || lower(e.def.id) === lower(id))?.def;
      if (!def) fail(`there is no piano-roll tool "${id}"`);
      const patternId = context.focus.writable(context.pattern(action.pattern));
      const channelId = context.channel(action.channel);
      const channel = draft.channels[channelId]!;
      if (channel.kind !== 'instrument') fail(`“${channel.name}” has no notes`);
      const pat = draft.patterns[patternId]!;
      const values: Record<string, ParamValue> = {};
      const set: string[] = [];
      if (Array.isArray(action.params)) {
        const specs = def!.params as ParamSpecs;
        for (const e of action.params) {
          if (!isObj(e) || typeof e.name !== 'string') continue;
          const pidm = findParamId(specs, e.name);
          const v = pidm ? coerceParam(specs[pidm] as ParamSpec, e.value) : null;
          if (!pidm || v === null) {
            context.warn(`${def!.name}: can't set "${e.name}" to ${JSON.stringify(e.value)}`);
            continue;
          }
          values[pidm] = v;
          set.push(`${(specs[pidm] as ParamSpec).label ?? pidm} ${formatValue(specs[pidm] as ParamSpec, v)}`);
        }
      }
      // On the draft: notes written earlier in this answer are shaped too. Selected notes only, in a notes focus.
      const only = context.focus.notes(patternId, channelId);
      const notes = notesOf(pat as Pattern, channelId).filter((n) => !only || only.has(n.id));
      let out;
      try {
        out = runNoteScript(
          def!,
          {
            notes,
            grid: PPQ / 4,
            bpm: draft.transport.bpm,
            bar: context.bar(),
            length: lengthOf(pat as Pattern, draft.transport.timeSig),
            key: draft.transport.key ?? null,
          },
          values,
        );
      } catch (err) {
        fail(err instanceof NoteScriptError ? err.message : String(err));
      }
      if (notes.length === 0 && out!.length === 0)
        fail(`“${channel.name}” has no notes in “${pat.name}” for ${def!.name} to work on`);
      const plan = planNoteReplacement(notes, out!, () => newId.note());
      applyNoteReplacement(draft, patternId, channelId, plan);
      return `${def!.name} on “${channel.name}” in “${pat.name}”${set.length ? ` (${set.join(', ')})` : ''}`;
    },

    steps: (action, context) => {
      const { draft } = context;
      const patternId = context.focus.writable(context.pattern(action.pattern));
      const channelId = context.channel(action.channel);
      const channel = draft.channels[channelId]!;
      if (channel.kind !== 'instrument') fail(`“${channel.name}” has no steps`);
      context.focus.wholePattern(patternId, channelId, 'steps');
      const rootKey = channel.kind === 'instrument' ? channel.rootKey : 60;
      const where = `“${channel.name}” in “${draft.patterns[patternId]!.name}”`;
      const by = Math.round(num(action.by) ?? 1);
      switch (str(action.action)) {
        case 'fill': {
          const every = Math.max(1, Math.min(64, Math.round(num(action.every) ?? 4)));
          fillSteps(draft, patternId, channelId, every, { rootKey });
          return `Filled every ${every} steps of ${where}`;
        }
        case 'rotate':
          rotateSteps(draft, patternId, channelId, by);
          return `Rotated ${where} by ${by} steps`;
        case 'shift':
          shiftSteps(draft, patternId, channelId, by);
          return `Shifted ${where} by ${by} steps`;
        case 'reverse':
          reverseSteps(draft, patternId, channelId);
          return `Reversed ${where}`;
        case 'randomize': {
          const density = Math.min(1, Math.max(0, num(action.density) ?? 0.4));
          randomizeSteps(draft, patternId, channelId, { rootKey, rand: Math.random, density });
          return `Randomized ${where} (${Math.round(density * 100)}% of the steps)`;
        }
        case 'clear':
          clearSteps(draft, patternId, channelId);
          return `Cleared the steps of ${where}`;
        default:
          return fail(`unknown step action "${String(action.action)}"`);
      }
    },
  },
};
