/** Patterns: add, rename/recolor/resize, remove. */
import { makePattern, paletteColor } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import { addPattern, removePattern, setPatternProps } from '@core/ops/playlist';
import { stepsPerBar } from '@core/time/ppq';
import * as S from '../schema/parts';
import { fail, type OpModule } from './context';
import { num, r2, str } from './values';

export const patterns: OpModule = {
  schemas: [
    S.op('add_pattern', 'Adds an empty pattern.', {
      ref: S.REF,
      name: S.str('Pattern name.'),
      bars: S.num('Length in bars (default: grows with its notes).'),
    }),
    S.op(
      'edit_pattern',
      'Changes a pattern.',
      { pattern: S.PATTERN, name: S.str('New name.'), color: S.str('Hex color.'), bars: S.num('Length in bars.') },
      ['pattern'],
    ),
    S.op('remove_pattern', 'Deletes a pattern and its playlist clips.', { pattern: S.PATTERN }, ['pattern']),
  ],
  handlers: {
    add_pattern: (a, c) => {
      const { d } = c;
      const id = newId.pattern();
      const name = str(a.name) ?? `Pattern ${d.patternOrder.length + 1}`;
      addPattern(d, makePattern(name, paletteColor(d.patternOrder.length), id));
      const bars = num(a.bars);
      if (bars !== undefined && bars > 0) {
        d.patterns[id]!.length = Math.round(bars * c.bar());
        d.patterns[id]!.stepCount = Math.max(1, Math.round(bars * stepsPerBar(d.transport.timeSig)));
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
      const name = str(a.name);
      const color = str(a.color);
      if (name || color) setPatternProps(d, id, { ...(name ? { name } : {}), ...(color ? { color } : {}) });
      if (name) out.push(`renamed “${name}”`);
      if (bars !== undefined && bars > 0) {
        d.patterns[id]!.length = Math.round(bars * c.bar());
        d.patterns[id]!.stepCount = Math.max(1, Math.round(bars * stepsPerBar(d.transport.timeSig)));
        out.push(`${r2(bars)} bars`);
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
