/**
 * The piano roll's right-click menus (on notes, on an empty spot), the toolbar's Tools menu and the
 * song key menu. Entries use plain names; "…" means a dialog opens first. Other features add
 * entries through `addContextMenuItems('pianoRoll.note' | 'pianoRoll.empty', …)`.
 */
import { getScale, keyLabel, PITCH_NAMES, SCALES } from '@agstudio/sdk/notes';
import { applyNoteScript, scriptTarget } from '@app/actions/note-scripts';
import type { Services } from '@app/services';
import { formatChord } from '@core/commands/keymap';
import type { SongKey } from '@core/model/types';
import { setSongKey } from '@core/ops/notes';
import type { MenuEntry } from '../../controls/ContextMenu';
import { extraMenuItems, type MenuScopes } from '../../context-menus';
import { noteTarget } from './commands';
import { openNoteScript, scriptMenu } from './tools';

/** The ids of the built-in note scripts the menus and commands run. */
export const SCRIPT = {
  quantize: 'agstudio.notes.quantize',
  humanize: 'agstudio.notes.humanize',
  legato: 'agstudio.notes.legato',
  chop: 'agstudio.notes.chop',
  glue: 'agstudio.notes.glue',
  strum: 'agstudio.notes.strum',
  arpeggiate: 'agstudio.notes.arpeggiate',
  flip: 'agstudio.notes.flip',
  randomize: 'agstudio.notes.randomize',
  transpose: 'agstudio.notes.transpose',
  chords: 'agstudio.notes.chords',
} as const;

/** A plain (clickable) menu entry. */
type MenuItem = Extract<MenuEntry, { kind?: 'item' }>;

/** The first shortcut bound to a command, formatted for this platform. */
function shortcut(s: Services, command: string): string | undefined {
  const chord = s.keymap.chordsFor(command)[0];
  return chord ? formatChord(chord, s.platform) : undefined;
}

/** A menu item that runs a command (disabled when the command is). */
function command(s: Services, id: string, label?: string, args?: unknown): MenuItem {
  const def = s.commands.get(id);
  const key = shortcut(s, id);
  return {
    label: label ?? def?.title ?? id,
    disabled: !s.commands.isEnabled(id),
    ...(key ? { shortcut: key } : {}),
    onSelect: () => s.commands.run(id, args),
  };
}

/** A menu item that opens a note script's dialog (absent when the script isn't installed). */
function tool(s: Services, id: string, label: string, commandId?: string): MenuItem[] {
  if (!s.plugins.script(id)) return [];
  const key = commandId ? shortcut(s, commandId) : undefined;
  return [
    {
      label,
      disabled: !scriptTarget(s),
      ...(key ? { shortcut: key } : {}),
      onSelect: () => void openNoteScript(s, id),
    },
  ];
}

/** The tools everyone reaches for, by plain name. */
function commonTools(s: Services): MenuEntry[] {
  return [
    ...tool(s, SCRIPT.quantize, 'Quantize…', 'pianoRoll.quantizeTool'),
    command(s, 'pianoRoll.quantize', 'Snap starts to the grid'),
    command(s, 'pianoRoll.legato', 'Make legato'),
    ...tool(s, SCRIPT.humanize, 'Humanize…'),
    ...tool(s, SCRIPT.strum, 'Strum…', 'pianoRoll.strum'),
    ...tool(s, SCRIPT.arpeggiate, 'Arpeggiate…', 'pianoRoll.arpeggiate'),
    ...tool(s, SCRIPT.chop, 'Chop…', 'pianoRoll.chop'),
    ...tool(s, SCRIPT.glue, 'Glue…', 'pianoRoll.glue'),
    ...tool(s, SCRIPT.chords, 'Make chords…'),
  ];
}

function transposeMenu(s: Services): MenuEntry[] {
  return [
    command(s, 'pianoRoll.transpose', 'Up a semitone', 1),
    command(s, 'pianoRoll.transpose', 'Down a semitone', -1),
    command(s, 'pianoRoll.transpose', 'Up an octave', 12),
    command(s, 'pianoRoll.transpose', 'Down an octave', -12),
    { kind: 'separator' },
    command(s, 'pianoRoll.transposeInKey', 'Up one note of the scale', 1),
    command(s, 'pianoRoll.transposeInKey', 'Down one note of the scale', -1),
    ...tool(s, SCRIPT.transpose, 'Transpose…'),
  ];
}

/** "C minor", or "none". */
export function songKeyName(key: SongKey | undefined | null): string {
  return key ? keyLabel(key.root, key.scale) : 'none';
}

/** Sets the song key (one undo step), or clears it with null. */
export function setKey(s: Services, key: SongKey | null): void {
  s.history.transact(key ? `Song key: ${songKeyName(key)}` : 'No song key', (d) => setSongKey(d, key));
}

/** Pick a root (each entry reads as a whole key, e.g. "A minor"), a scale, and what the key does. */
export function keyMenu(s: Services): MenuEntry[] {
  const key = s.doc.getState().project.transport.key;
  const scale = key?.scale ?? 'major';
  const scaleName = getScale(scale).label.toLowerCase();
  return [
    { kind: 'label', label: 'Song key' },
    { label: 'No key', checked: !key, onSelect: () => setKey(s, null) },
    ...PITCH_NAMES.map((name, root): MenuEntry => ({
      label: `${name} ${scaleName}`,
      checked: key?.root === root,
      onSelect: () => setKey(s, { root, scale }),
    })),
    {
      kind: 'submenu',
      label: 'Scale',
      items: () =>
        SCALES.map((sc) => ({
          label: sc.label,
          checked: !!key && key.scale === sc.id,
          onSelect: () => setKey(s, { root: key?.root ?? 0, scale: sc.id }),
        })),
    },
    { kind: 'separator' },
    command(s, 'pianoRoll.scaleHighlight', 'Highlight the scale’s rows'),
    command(s, 'pianoRoll.scaleSnap', 'Scale lock'),
    command(s, 'pianoRoll.chordHighlight', 'Highlight the chord tones'),
  ];
}

/** Right-click on notes: tools for the selection (the clicked note is selected first). */
export function noteMenu(s: Services, ctx: MenuScopes['pianoRoll.note']): MenuEntry[] {
  const t = noteTarget(s);
  const count = t?.selected.length ?? 0;
  const allMuted = !!t && count > 0 && t.selected.every((n) => n.muted);
  return [
    { kind: 'label', label: count === 1 ? '1 note selected' : `${count} notes selected` },
    ...commonTools(s),
    { kind: 'submenu', label: 'Transpose', items: () => transposeMenu(s) },
    { kind: 'submenu', label: 'More tools', items: () => scriptMenu(s) },
    { kind: 'separator' },
    command(s, 'pianoRoll.selectSameKey', 'Select every note on the same key'),
    command(s, 'pianoRoll.toggleMute', allMuted ? 'Unmute' : 'Mute'),
    { kind: 'separator' },
    command(s, 'pianoRoll.cut', 'Cut'),
    command(s, 'pianoRoll.copy', 'Copy'),
    command(s, 'pianoRoll.duplicate', 'Duplicate'),
    { ...command(s, 'pianoRoll.delete', 'Delete'), danger: true },
    ...extraMenuItems('pianoRoll.note', ctx, s),
  ];
}

/** Right-click on an empty spot: paste, select, tools for every note, the song key. */
export function emptyMenu(s: Services, ctx: MenuScopes['pianoRoll.empty']): MenuEntry[] {
  const key = s.doc.getState().project.transport.key;
  const hasNotes = (noteTarget(s)?.notes.length ?? 0) > 0;
  return [
    command(s, 'pianoRoll.paste', 'Paste'),
    command(s, 'pianoRoll.selectAll', 'Select all notes'),
    { kind: 'separator' },
    { kind: 'label', label: hasNotes ? 'Tools (for every note)' : 'No notes yet: draw some, or generate them' },
    ...(hasNotes ? commonTools(s) : []),
    { kind: 'submenu', label: hasNotes ? 'More tools' : 'Tools', items: () => scriptMenu(s) },
    { kind: 'separator' },
    { kind: 'submenu', label: `Key: ${songKeyName(key)}`, items: () => keyMenu(s) },
    ...extraMenuItems('pianoRoll.empty', ctx, s),
  ];
}

/** The toolbar's Tools button: the common tools by name, then every script by category. */
export function toolsMenu(s: Services): MenuEntry[] {
  const t = noteTarget(s);
  const count = t?.selected.length ?? 0;
  const label = !t
    ? 'Select an instrument channel first'
    : count > 0
      ? `For the ${count} selected note${count === 1 ? '' : 's'}`
      : 'For every note (select notes to change only those)';
  return [
    { kind: 'label', label },
    ...commonTools(s),
    { kind: 'separator' },
    ...scriptMenu(s),
    { kind: 'separator' },
    command(s, 'pianoRoll.selectSameKey', 'Select every note on the same key'),
    command(s, 'pianoRoll.toggleMute', 'Mute or unmute the selection'),
  ];
}

/** Applies a script with its default settings, without a dialog (Make legato). */
export function quickScript(s: Services, id: string): boolean {
  const def = s.plugins.script(id);
  return !!def && applyNoteScript(s, def, {});
}
