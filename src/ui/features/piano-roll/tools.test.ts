import { beforeEach, describe, expect, it } from 'vitest';
import { defineNoteScript } from '@agstudio/sdk';
import { createTestServices } from '@app/testing';
import type { ChannelId, NoteId, PatternId } from '@core/model/types';
import { addNotes, editNotes } from '@core/ops/notes';
import type { MenuEntry } from '../../controls/ContextMenu';
import type { FormDialogOptions, FormValues } from '../../controls/FormDialog';
import { addContextMenuItems } from '../../context-menus';
import { layout, note } from '../../../../test/helpers/notes';
import { noteTarget, pianoRollCommands as pr } from './commands';
import { emptyMenu, noteMenu, toolsMenu } from './menus';
import { register } from './register';
import { openNoteScript, resetScriptValues, scriptMenuBarEntries } from './tools';
import { drawKey, movedKeys, stampKeys, stampName } from './stamp';
import { formatLaneValue, laneEdit, laneValue, valueAtY } from './lanes';

function setup() {
  const s = createTestServices();
  register(s);
  const p0 = s.doc.getState().project;
  const cid = p0.channelOrder[0] as ChannelId;
  const pid = p0.patternOrder[0] as PatternId;
  s.session.getState().selectChannel(cid);
  s.editor.getState().setPianoRoll({ snap: 'step' });
  s.history.transact('seed', (d) =>
    addNotes(d, pid, cid, [note('a', 0, 60, 960), note('b', 0, 64, 960), note('c', 0, 67, 960), note('d', 1920, 60)]),
  );
  const notes = () => layout(noteTarget(s)!.notes);
  return { s, cid, pid, notes };
}

/** A dialog stand-in: records the options, lets the test edit values, then OK or Cancel. */
function fakeForm() {
  let opened: FormDialogOptions<FormValues> | null = null;
  let finish: ((v: FormValues | null) => void) | null = null;
  return {
    form: (o: FormDialogOptions<FormValues>) => {
      opened = o;
      return new Promise<FormValues | null>((resolve) => (finish = resolve));
    },
    get options() {
      return opened as FormDialogOptions<FormValues> | null;
    },
    change(values: Partial<FormValues>) {
      opened!.onChange?.({ ...opened!.values, ...values } as FormValues);
    },
    ok(values: Partial<FormValues> = {}) {
      finish!({ ...opened!.values, ...values } as FormValues);
    },
    cancel() {
      finish!(null);
    },
  };
}

const now = (fn: () => void) => fn();
const find = (items: MenuEntry[], label: string): MenuEntry | undefined =>
  items.find((i) => 'label' in i && i.label === label);
const sub = (items: MenuEntry[], label: string): MenuEntry[] => {
  const entry = find(items, label);
  if (entry?.kind !== 'submenu') throw new Error(`no submenu ${label}`);
  return typeof entry.items === 'function' ? entry.items() : entry.items;
};
const click = (items: MenuEntry[], label: string) => {
  const entry = find(items, label);
  if (!entry || entry.kind !== undefined) throw new Error(`no item ${label}`);
  entry.onSelect();
};

beforeEach(() => resetScriptValues());

describe('note script dialogs', () => {
  it('preview live while the dialog is open and apply as one undo step', async () => {
    const { s, notes } = setup();
    const f = fakeForm();
    const done = openNoteScript(s, 'agstudio.notes.strum', { form: f.form, schedule: now });
    expect(f.options?.title).toBe('Strum');
    // The dialog explains the tool, what it works on and that it previews live.
    expect(f.options?.message).toMatch(/strumming a guitar/);
    const info = (f.options?.fields ?? []).flatMap((x) => (x.kind === 'info' ? [x.text] : []));
    expect(info[0]).toBe('Works on all 4 notes of this channel (select notes first to change only those).');
    expect(info[1]).toMatch(/Live preview/);
    expect(f.options?.fields.map((x) => (x.kind === 'param' ? x.key : x.kind))).toContain('time');
    // The default strum (1/8 beat) is already previewed.
    expect(notes()).toEqual(['0:60:960', '60:64:900', '120:67:840', '1920:60:240']);
    f.change({ time: 0.5 });
    expect(notes()).toEqual(['0:60:960', '240:64:720', '480:67:480', '1920:60:240']);
    f.ok({ time: 0.5 });
    expect(await done).toBe(true);
    expect(s.history.status().undoLabel).toBe('Strum');
    s.history.undo();
    expect(notes()).toEqual(['0:60:960', '0:64:960', '0:67:960', '1920:60:240']);
  });

  it('Cancel restores the notes and leaves no undo step', async () => {
    const { s, notes } = setup();
    const before = s.doc.getState().project;
    const f = fakeForm();
    const done = openNoteScript(s, 'agstudio.notes.arpeggiate', { form: f.form, schedule: now });
    expect(notes().length).toBeGreaterThan(4);
    f.cancel();
    expect(await done).toBe(false);
    expect(s.doc.getState().project).toEqual(before);
    expect(s.history.status().undoLabel).toBe('seed');
  });

  it('reopens with the values last applied', async () => {
    const { s } = setup();
    const first = fakeForm();
    const done = openNoteScript(s, 'agstudio.notes.chop', { form: first.form, schedule: now });
    first.ok({ parts: 3, mode: 'parts' });
    await done;
    const second = fakeForm();
    void openNoteScript(s, 'agstudio.notes.chop', { form: second.form, schedule: now });
    expect(second.options?.values).toMatchObject({ parts: 3, mode: 'parts' });
    second.cancel();
  });

  it('runs scripts without params directly, and the menus follow the registry', async () => {
    const { s, notes } = setup();
    const up = defineNoteScript({
      id: 'user.up',
      name: 'Octave up',
      version: 1,
      category: 'Mine',
      params: {},
      run: (ctx) => ctx.notes.map((n) => ({ ...n, key: n.key + 12 })),
    });
    expect(sub(toolsMenu(s), 'Timing').length).toBeGreaterThan(2);
    const first = toolsMenu(s)[0];
    expect(first?.kind === 'label' && first.label).toBe('For every note (select notes to change only those)');
    expect(toolsMenu(s).map((e) => ('label' in e ? e.label : ''))).toEqual(
      expect.arrayContaining(['Quantize…', 'Make legato', 'Humanize…', 'Strum…', 'Arpeggiate…']),
    );
    expect(find(toolsMenu(s), 'Mine')).toBeUndefined();
    s.plugins.sync('user', [{ path: '/plugins/up/index.ts', def: up }]);
    const mine = sub(toolsMenu(s), 'Mine');
    expect(mine.map((e) => ('label' in e ? e.label : ''))).toEqual(['Octave up (user)']);
    click(mine, 'Octave up (user)');
    expect(notes()).toEqual(['0:72:960', '0:76:960', '0:79:960', '1920:72:240']);
    expect(s.history.status().undoLabel).toBe('Octave up');
    // The menu bar's Edit > Piano roll tools lists it too.
    const bar = scriptMenuBarEntries(s);
    expect(bar.find((e) => e.label === 'Mine')?.children?.[0]?.label).toBe('Octave up (user)');
    // Parameterised scripts end in "…".
    expect(bar.find((e) => e.label === 'Timing')?.children?.map((c) => c.label)).toContain('Quantize…');
    expect(await openNoteScript(s, 'user.gone')).toBe(false);
  });

  it('keeps the selection on the result when the input was the selection', async () => {
    const { s } = setup();
    s.editor.getState().selectNotes(['d'] as NoteId[]);
    const f = fakeForm();
    const done = openNoteScript(s, 'agstudio.notes.chop', { form: f.form, schedule: now });
    f.ok({ mode: 'parts', parts: 2 });
    await done;
    const sel = s.editor.getState().noteSelection;
    expect(sel).toHaveLength(2);
    expect(sel).toContain('d');
  });
});

describe('piano roll menus and commands', () => {
  it('right-click on notes: select same key, mute, transpose, tools', () => {
    const { s, cid, pid, notes } = setup();
    s.editor.getState().selectNotes(['d'] as NoteId[]);
    const ctx = { channelId: cid, patternId: pid, noteIds: ['d'] as NoteId[], tick: 1920, key: 60 };
    const menu = noteMenu(s, ctx);
    expect(find(menu, 'Quantize…')).toBeTruthy();
    expect(find(menu, 'Chop…')).toBeTruthy();
    click(menu, 'Select every note on the same key');
    expect([...s.editor.getState().noteSelection].sort()).toEqual(['a', 'd']);
    click(noteMenu(s, ctx), 'Mute');
    expect(noteTarget(s)!.selected.every((n) => n.muted)).toBe(true);
    click(noteMenu(s, ctx), 'Unmute');
    expect(noteTarget(s)!.selected.some((n) => n.muted)).toBe(false);
    click(sub(noteMenu(s, ctx), 'Transpose'), 'Up one note of the scale');
    expect(notes()).toEqual(['0:62:960', '0:64:960', '0:67:960', '1920:62:240']);
    expect(sub(noteMenu(s, ctx), 'More tools').length).toBeGreaterThan(3);
  });

  it('features can add entries to the note and empty menus', () => {
    const { s, cid, pid } = setup();
    const off = addContextMenuItems('pianoRoll.empty', (c) => [{ label: `Extra at ${c.tick}`, onSelect: () => {} }]);
    const menu = emptyMenu(s, { channelId: cid, patternId: pid, tick: 480, key: 60 });
    expect(find(menu, 'Extra at 480')).toBeTruthy();
    expect(find(menu, 'Key: none')).toBeTruthy();
    off();
  });

  it('sets the song key from the empty-space menu', () => {
    const { s, cid, pid } = setup();
    const ctx = { channelId: cid, patternId: pid, tick: 0, key: 60 };
    click(sub(emptyMenu(s, ctx), 'Key: none'), 'D major');
    expect(s.doc.getState().project.transport.key).toEqual({ root: 2, scale: 'major' });
    click(sub(sub(emptyMenu(s, ctx), 'Key: D major'), 'Scale'), 'Dorian');
    expect(s.doc.getState().project.transport.key).toEqual({ root: 2, scale: 'dorian' });
    click(sub(emptyMenu(s, ctx), 'Key: D dorian'), 'No key');
    expect(s.doc.getState().project.transport.key).toBeUndefined();
  });

  it('quick legato (Mod+L) and the dialog shortcuts are piano-roll commands', () => {
    const { s, notes } = setup();
    expect(s.commands.run('pianoRoll.legato')).toBe(true);
    expect(notes()).toEqual(['0:60:1920', '0:64:1920', '0:67:1920', '1920:60:240']);
    expect(s.keymap.chordsFor('pianoRoll.legato')).toEqual(['Meta+L']);
    expect(s.keymap.chordsFor('pianoRoll.arpeggiate')).toEqual(['Alt+A']);
    expect(s.keymap.chordsFor('pianoRoll.tool.mute')).toEqual(['T']);
    pr.selectSameKey(s, [67]);
    expect(s.editor.getState().noteSelection).toEqual(['c']);
  });
});

describe('drawing helpers', () => {
  const am = { root: 9, scale: 'minor' };

  it('stamps chords and snaps drawn keys to the scale', () => {
    expect(stampKeys(60, '', 0, null)).toEqual([60]);
    expect(stampName(stampKeys(60, 'm7', 0, null))).toBe('Cm7');
    expect(stampName([60])).toBe('');
    expect(stampKeys(60, 'm7', 0, null)).toEqual([60, 63, 67, 70]);
    expect(stampKeys(60, 'major', 1, null)).toEqual([64, 67, 72]);
    expect(stampKeys(62, 'diatonic', 0, am)).toEqual([62, 65, 69]);
    expect(stampKeys(62, 'diatonic7', 0, null)).toEqual([62, 65, 69, 72]);
    expect(stampKeys(60, 'not-a-chord', 0, null)).toEqual([60]);
    expect(drawKey(61, true, am)).toBe(60);
    expect(drawKey(61, false, am)).toBe(61);
    expect(drawKey(61, true, null)).toBe(61);
  });

  it('moves notes by semitones, or by scale steps when snapping', () => {
    expect(movedKeys([60, 64], 60, 62, false, null)).toEqual([62, 66]);
    expect(movedKeys([120, 125], 120, 130, false, null)).toEqual([122, 127]);
    // A minor: C E → D F (one scale step).
    expect(movedKeys([60, 64], 60, 62, true, am)).toEqual([62, 65]);
    expect(movedKeys([60, 64], 60, 61, true, am)).toEqual([60, 64]);
  });

  it('maps event lane values', () => {
    const n = note('x', 0, 60, 240, { pan: -0.5, fine: 25 });
    expect(laneValue(n, 'pan')).toBe(-0.5);
    expect(laneValue(n, 'fine')).toBe(0.25);
    expect(laneValue(n, 'release')).toBe(0.5);
    expect(laneEdit(n.id, 'fine', -0.333)).toEqual({ id: 'x', fine: -33 });
    expect(laneEdit(n.id, 'velocity', 0)).toEqual({ id: 'x', velocity: 0.01 });
    expect(valueAtY(3, 76, 'velocity')).toBe(1);
    expect(valueAtY(73, 76, 'velocity')).toBe(0);
    expect(valueAtY(38, 76, 'pan')).toBe(0);
    expect(valueAtY(3, 76, 'pan')).toBe(1);
    expect(formatLaneValue('pan', -0.25)).toBe('Pan 25% left');
    expect(formatLaneValue('fine', 0.1)).toBe('Fine pitch +10 ct');
  });
});

describe('event lane edits', () => {
  it('write the optional note fields', () => {
    const { s, pid, cid } = setup();
    s.history.transact('Pan', (d) =>
      editNotes(d, pid, cid, [laneEdit('a' as NoteId, 'pan', 0.75), laneEdit('b' as NoteId, 'release', 0.2)]),
    );
    const byId = new Map(noteTarget(s)!.notes.map((n) => [n.id, n]));
    expect(byId.get('a' as NoteId)?.pan).toBe(0.75);
    expect(byId.get('b' as NoteId)?.release).toBe(0.2);
  });
});
