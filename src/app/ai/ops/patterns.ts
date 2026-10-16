/** Patterns: add, rename/recolor/resize, remove. */
import { makePattern, paletteColor } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import type { Project } from '@core/model/types';
import { addPattern, clonePattern, movePattern, removePattern, setPatternProps } from '@core/ops/playlist';
import { stepsPerBar } from '@core/time/ppq';
import * as S from '../schema/parts';
import { fail, type OpModule } from './context';
import { num, r2, str } from './values';

/** A pattern holds at most this many steps (the editors' limit; two bars of 16ths is 32). */
const MAX_STEPS = 512;

/** The length in bars a pattern can have, kept inside the step limit. */
function clampBars(bars: number, timeSig: Project['transport']['timeSig']): number {
  const per = stepsPerBar(timeSig);
  return Math.max(1 / per, Math.min(bars, MAX_STEPS / per));
}

export const patterns: OpModule = {
  schemas: [
    S.op('add_pattern', 'Adds a pattern: empty, or a copy of another one (from), or split by channel.', {
      ref: S.REF,
      name: S.str('Pattern name (a copy defaults to “… copy”; split ones to “… · channel”).'),
      bars: S.num('Length in bars (default: grows with its notes).'),
      from: { ...S.PATTERN, description: 'Copy this pattern (all its notes) instead of starting empty.' },
      split_by_channel: S.bool('With from: instead of one copy, one new pattern per channel that has notes, each holding only that channel’s notes. The original stays.'),
    }),
    S.op(
      'edit_pattern',
      'Changes a pattern.',
      {
        pattern: S.PATTERN,
        name: S.str('New name.'),
        color: S.str('Hex color.'),
        bars: S.num('Length in bars.'),
        position: S.int('Move it to this 1-based place in the pattern list.'),
      },
      ['pattern'],
    ),
    S.op('remove_pattern', 'Deletes a pattern and its playlist clips.', { pattern: S.PATTERN }, ['pattern']),
  ],
  handlers: {
    add_pattern: (a, c) => {
      const { d } = c;
      if (a.from !== undefined && !(a.split_by_channel === true)) {
        const src = c.pattern(a.from);
        const id = newId.pattern();
        const name = str(a.name) ?? `${d.patterns[src]!.name} copy`;
        clonePattern(d, src, id, name);
        const bars = num(a.bars);
        if (bars !== undefined && bars > 0) {
          const fit = clampBars(bars, d.transport.timeSig);
          d.patterns[id]!.length = Math.round(fit * c.bar());
          d.patterns[id]!.stepCount = Math.max(1, Math.round(fit * stepsPerBar(d.transport.timeSig)));
        }
        c.remember(a.ref, { kind: 'pattern', id });
        c.state.selectPattern = id;
        return `Copied “${d.patterns[src]!.name}” as “${name}”`;
      }
      if (a.from !== undefined) {
        const src = c.pattern(a.from);
        const from = d.patterns[src]!;
        const made: string[] = [];
        const base = str(a.name) ?? from.name;
        let at = d.patternOrder.indexOf(src);
        for (const cid of d.channelOrder) {
          const notes = Object.values(from.notes[cid] ?? {});
          if (!notes.length) continue;
          const id = newId.pattern();
          const pat = makePattern(`${base} · ${d.channels[cid]!.name}`, paletteColor(d.patternOrder.length), id);
          pat.stepCount = from.stepCount;
          if (from.length !== undefined) pat.length = from.length;
          pat.notes[cid] = Object.fromEntries(
            notes.map((n) => {
              const nid = newId.note();
              return [nid, { ...n, id: nid }];
            }),
          );
          addPattern(d, pat, ++at);
          made.push(pat.name);
        }
        if (!made.length) fail(`“${from.name}” has no notes to split`);
        return `Split “${from.name}” into ${made.length} pattern${made.length === 1 ? '' : 's'} (one per channel)`;
      }
      const id = newId.pattern();
      const name = str(a.name) ?? `Pattern ${d.patternOrder.length + 1}`;
      addPattern(d, makePattern(name, paletteColor(d.patternOrder.length), id));
      const bars = num(a.bars);
      if (bars !== undefined && bars > 0) {
        const fit = clampBars(bars, d.transport.timeSig);
        d.patterns[id]!.length = Math.round(fit * c.bar());
        d.patterns[id]!.stepCount = Math.max(1, Math.round(fit * stepsPerBar(d.transport.timeSig)));
      }
      c.remember(a.ref, { kind: 'pattern', id });
      c.state.selectPattern = id;
      return `Added pattern “${name}”`;
    },

    edit_pattern: (a, c) => {
      const { d } = c;
      let id = c.pattern(a.pattern);
      const out: string[] = [];
      const bars = num(a.bars);
      // A new length changes what plays: in a part of the song, on the part's own copy.
      if (bars !== undefined && bars > 0) id = c.focus.writable(id);
      const position = num(a.position);
      if (position !== undefined) {
        movePattern(d, id, Math.round(position) - 1);
        out.push(`place ${d.patternOrder.indexOf(id) + 1}`);
      }
      const name = str(a.name);
      const color = str(a.color);
      if (name || color) setPatternProps(d, id, { ...(name ? { name } : {}), ...(color ? { color } : {}) });
      if (name) out.push(`renamed “${name}”`);
      if (bars !== undefined && bars > 0) {
        const fit = clampBars(bars, d.transport.timeSig);
        d.patterns[id]!.length = Math.round(fit * c.bar());
        d.patterns[id]!.stepCount = Math.max(1, Math.round(fit * stepsPerBar(d.transport.timeSig)));
        out.push(`${r2(fit)} bars`);
      }
      return out.length ? `Pattern “${d.patterns[id]!.name}”: ${out.join(', ')}` : null;
    },

    remove_pattern: (a, c) => {
      const { d } = c;
      const id = c.pattern(a.pattern);
      if (d.patternOrder.length <= 1) fail('the project needs at least one pattern');
      c.focus.owned(id, 'remove pattern');
      const name = d.patterns[id]!.name;
      removePattern(d, id);
      return `Deleted pattern “${name}”`;
    },
  },
};
