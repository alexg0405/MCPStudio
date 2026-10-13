import { describe, expect, it, vi } from 'vitest';
import { defineNoteScript, p } from '@agstudio/sdk';
import { createTestServices } from '@app/testing';
import type { ChannelId, NoteId, PatternId } from '@core/model/types';
import { addNotes } from '@core/ops/notes';
import { notesSorted } from '@core/query/queries';
import { layout, note } from '../../../test/helpers/notes';
import {
  applyNoteScript,
  checkScriptOutput,
  NoteScriptError,
  runNoteScript,
  ScriptPreview,
  scriptSeed,
  scriptTarget,
} from './note-scripts';

function setup() {
  const s = createTestServices();
  const p = s.doc.getState().project;
  const cid = p.channelOrder[0] as ChannelId;
  const pid = p.patternOrder[0] as PatternId;
  s.session.getState().selectChannel(cid);
  s.editor.getState().setPianoRoll({ snap: 'step' });
  s.history.transact('seed', (d) =>
    addNotes(d, pid, cid, [note('a', 10, 60), note('b', 250, 64), note('c', 700, 67, 480, { pan: 0.5 })]),
  );
  const notes = () => layout(notesSorted(s.doc.getState().project.patterns[pid]!.notes[cid]));
  return { s, cid, pid, notes };
}

const offset = defineNoteScript({
  id: 'test.offset',
  name: 'Offset',
  version: 1,
  params: { by: p.int(0, 960, 100) },
  run: (ctx) => ctx.notes.map((n) => ({ ...n, tick: n.tick + ctx.values.by })),
});

describe('note script runner', () => {
  it('finds the built-in tools in the registry', () => {
    const { s } = setup();
    const ids = s.plugins.scripts().map((e) => e.def.id);
    expect(ids).toContain('agstudio.notes.quantize');
    expect(ids).toContain('agstudio.notes.arpeggiate');
    expect(s.plugins.list().some((e) => e.def.id.startsWith('agstudio.notes.'))).toBe(false);
  });

  it('targets the selection, or every note of the channel', () => {
    const { s } = setup();
    const t = scriptTarget(s)!;
    expect(t.fromSelection).toBe(false);
    expect(t.notes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(t).toMatchObject({ grid: 240, bar: 3840, length: 3840, key: null });
    s.editor.getState().selectNotes(['b'] as NoteId[]);
    expect(scriptTarget(s)?.notes.map((n) => n.id)).toEqual(['b']);
    expect(scriptTarget(s)?.fromSelection).toBe(true);
  });

  it('applies a script as one undo step and keeps the result selected', () => {
    const { s, notes } = setup();
    s.editor.getState().selectNotes(['a', 'b'] as NoteId[]);
    expect(applyNoteScript(s, s.plugins.script('agstudio.notes.quantize')!)).toBe(true);
    expect(notes()).toEqual(['0:60:240', '240:64:240', '700:67:480']);
    expect(s.editor.getState().noteSelection).toEqual(['a', 'b']);
    expect(s.history.status().undoLabel).toBe('Quantize');
    s.history.undo();
    expect(notes()).toEqual(['10:60:240', '250:64:240', '700:67:480']);
  });

  it('previews live through a gesture: cancel restores, commit is one undo step', () => {
    const { s, notes } = setup();
    const before = s.doc.getState().project;
    const chop = s.plugins.script('agstudio.notes.chop')!;
    const preview = new ScriptPreview(s, chop, scriptTarget(s)!);
    expect(preview.update({ mode: 'parts', parts: 2 })).toBe(true);
    expect(notes()).toHaveLength(6);
    expect(preview.update({ mode: 'parts', parts: 4 })).toBe(true);
    expect(notes()).toHaveLength(12);
    expect(preview.update({ mode: 'parts', parts: 3 })).toBe(true);
    expect(notes()).toHaveLength(9);
    preview.cancel();
    expect(s.doc.getState().project).toEqual(before);
    expect(s.history.status().undoLabel).toBe('seed');

    const again = new ScriptPreview(s, chop, scriptTarget(s)!);
    again.update({ mode: 'parts', parts: 4 });
    again.update({ mode: 'parts', parts: 2 });
    again.commit();
    expect(notes()).toHaveLength(6);
    expect(s.history.status().undoLabel).toBe('Chop');
    s.history.undo();
    expect(s.doc.getState().project).toEqual(before);
    s.history.redo();
    expect(notes()).toHaveLength(6);
  });

  it('keeps optional fields scripts leave out', () => {
    const { s, pid, cid } = setup();
    applyNoteScript(s, offset, { by: 10 });
    const c = notesSorted(s.doc.getState().project.patterns[pid]!.notes[cid]).find((n) => n.id === 'c');
    expect(c).toMatchObject({ tick: 710, pan: 0.5 });
  });

  it('reports scripts that throw, mutate their input or return malformed notes', () => {
    const { s, notes } = setup();
    const toast = vi.spyOn(s.session.getState(), 'toast');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const throwing = defineNoteScript({
      id: 't.x',
      name: 'Broken',
      version: 1,
      params: {},
      run: () => {
        throw new Error('boom');
      },
    });
    expect(applyNoteScript(s, throwing)).toBe(false);
    const mutating = defineNoteScript({
      id: 't.m',
      name: 'Mutating',
      version: 1,
      params: {},
      run: (ctx) => {
        (ctx.notes[0] as { tick: number }).tick = 5;
        return ctx.notes;
      },
    });
    expect(applyNoteScript(s, mutating)).toBe(false);
    expect(notes()).toEqual(['10:60:240', '250:64:240', '700:67:480']);
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast.mock.calls[0]?.[0]).toMatch(/Broken failed: boom/);
    error.mockRestore();

    expect(() => checkScriptOutput('X', 'nope')).toThrow(NoteScriptError);
    expect(() => checkScriptOutput('X', [{ tick: 0, length: 1, key: Number.NaN, velocity: 1 }])).toThrow(/key/);
    expect(() => checkScriptOutput('X', [{ tick: 0, length: 1, key: 1, velocity: 1, muted: 1 }])).toThrow(/muted/);
    expect(checkScriptOutput('X', [{ id: 7, tick: 0, length: 1, key: 1, velocity: 1, extra: true }])).toEqual([
      { tick: 0, length: 1, key: 1, velocity: 1 },
    ]);

    // A preview keeps the last good result when an update fails.
    let fail = false;
    const flaky = defineNoteScript({
      id: 't.f',
      name: 'Flaky',
      version: 1,
      params: { by: p.int(0, 100, 10) },
      run: (ctx) => {
        if (fail) throw new Error('nope');
        return ctx.notes.map((n) => ({ ...n, tick: n.tick + ctx.values.by }));
      },
    });
    const preview = new ScriptPreview(s, flaky, scriptTarget(s)!);
    preview.update();
    fail = true;
    expect(preview.update({ by: 50 })).toBe(false);
    expect(preview.error).toMatch(/nope/);
    expect(notes()).toEqual(['20:60:240', '260:64:240', '710:67:480']);
    preview.commit();
  });

  it('seeds rand from the script, the notes and its seed param only', () => {
    const notes = [note('a', 0), note('b', 240)];
    const base = scriptSeed('x', notes, { seed: 1, density: 0.2 });
    expect(scriptSeed('x', notes, { seed: 1, density: 0.9 })).toBe(base);
    expect(scriptSeed('x', notes, { seed: 2, density: 0.2 })).not.toBe(base);
    expect(scriptSeed('y', notes, { seed: 1 })).not.toBe(base);
    expect(scriptSeed('x', [note('a', 0)], { seed: 1 })).not.toBe(base);
    const randoms = defineNoteScript({
      id: 'test.rand',
      name: 'Rand',
      version: 1,
      params: {},
      run: (ctx) => [{ tick: Math.floor(ctx.rand() * 1000), length: 1, key: 60, velocity: 1 }],
    });
    const input = { notes, grid: 240, bar: 3840, length: 3840, key: null };
    expect(runNoteScript(randoms, input)).toEqual(runNoteScript(randoms, input));
  });
});
