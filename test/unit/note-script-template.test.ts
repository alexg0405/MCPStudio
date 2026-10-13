/** The note-script template (`npm run new:plugin -- --kind note-script`) is a working script. */
import { describe, expect, it } from 'vitest';
import { runNoteScript } from '@app/actions/note-scripts';
import { validateNoteScriptDef } from '@app/plugins/registry';
import template from '../../templates/note-script/index';
import { note } from '../helpers/notes';

describe('note-script template', () => {
  const def = { ...template, id: 'user.echo', name: 'Echo' };

  it('is a valid definition once the scaffolder fills in the id', () => {
    expect(validateNoteScriptDef(def)).toEqual([]);
  });

  it('adds fading echoes and keeps the original notes', () => {
    const out = runNoteScript(
      def,
      { notes: [note('a', 0, 60)], grid: 240, bar: 3840, length: 3840, key: null },
      {
        echoes: 2,
        delay: 1,
        decay: 0.5,
        climb: 1,
      },
    );
    expect(out.map((n) => [n.id ?? null, n.tick, n.key, n.velocity])).toEqual([
      ['a', 0, 60, 0.8],
      [null, 960, 62, 0.4],
      [null, 1920, 64, 0.2],
    ]);
  });
});
