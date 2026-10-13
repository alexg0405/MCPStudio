/**
 * Piano-roll tools (note scripts) in the UI: running one opens a dialog generated from its params
 * with a live preview (a history gesture: OK commits one undo step, Cancel restores), and the menus
 * listing every script in the registry by category. Menus are built when they open, so scripts
 * that hot-reload, appear or disappear show up right away.
 */
import { resolveValues, type ParamValue } from '@agstudio/sdk';
import { applyNoteScript, ScriptPreview, scriptTarget } from '@app/actions/note-scripts';
import type { ScriptEntry } from '@app/plugins/registry';
import type { Services } from '@app/services';
import type { MenuEntry } from '../../controls/ContextMenu';
import { showFormDialog, type FormDialogOptions, type FormValues } from '../../controls/FormDialog';
import type { DynamicMenuEntry } from '../../shell/menus';

/** Values each script's dialog last applied (this session), so it reopens where you left it. */
const lastValues = new Map<string, Record<string, ParamValue>>();

export interface OpenScriptOptions {
  /** Replaces the dialog (tests drive it directly). */
  form?: (options: FormDialogOptions<FormValues>) => Promise<FormValues | null>;
  /** Schedules coalesced preview updates (default: the next animation frame). */
  schedule?: (fn: () => void) => void;
}

/** The next animation frame, or 50 ms when frames are paused (a hidden tab or pane). */
const nextFrame = (fn: () => void) => {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  setTimeout(run, 50);
};

/**
 * Runs a note script on the piano roll's notes: right away when it has no params, else through its
 * dialog with a live preview. Resolves true when the result was applied.
 */
export async function openNoteScript(s: Services, id: string, opts: OpenScriptOptions = {}): Promise<boolean> {
  const def = s.plugins.script(id);
  if (!def) {
    s.session.getState().toast(`Note script "${id}" is not installed`, 'error');
    return false;
  }
  const target = scriptTarget(s);
  if (!target) {
    s.session.getState().toast('Select an instrument channel to use piano roll tools');
    return false;
  }
  const keys = Object.keys(def.params);
  if (keys.length === 0) return applyNoteScript(s, def, {}, target);

  const values = resolveValues(def.params, lastValues.get(id)) as FormValues;
  const preview = new ScriptPreview(s, def, target);
  let shown: string | null = null;
  const update = (v: FormValues) => {
    preview.update(v);
    // One toast per distinct error while the dialog is open.
    if (preview.error && preview.error !== shown) s.session.getState().toast(preview.error, 'error');
    shown = preview.error;
  };
  update(values);

  let pending: FormValues | null = null;
  const flush = () => {
    const v = pending;
    pending = null;
    if (v) update(v);
  };
  const schedule = opts.schedule ?? nextFrame;
  const form = opts.form ?? showFormDialog;
  const result = await form({
    title: def.name,
    ...(def.description ? { message: def.description } : {}),
    fields: [
      { kind: 'info', text: targetSummary(target.notes.length, target.fromSelection) },
      ...keys.map((key) => ({ kind: 'param' as const, key, spec: def.params[key]! })),
      {
        kind: 'info',
        text: 'Live preview: the piano roll already shows the result and follows every change. Apply keeps it; Cancel puts the notes back.',
      },
    ],
    values,
    okLabel: 'Apply',
    onChange: (v) => {
      const idle = pending === null;
      pending = v;
      if (idle) schedule(flush);
    },
  });
  if (!result) {
    pending = null;
    preview.cancel();
    return false;
  }
  pending = result;
  flush();
  if (preview.error) {
    preview.cancel();
    return false;
  }
  preview.commit();
  lastValues.set(id, { ...result });
  return true;
}

/** What a tool works on, in words. */
export function targetSummary(count: number, fromSelection: boolean): string {
  if (fromSelection) return `Works on the ${count} selected note${count === 1 ? '' : 's'}.`;
  if (count === 0) return 'This channel has no notes in the pattern yet; tools that write notes will add them.';
  return `Works on all ${count} note${count === 1 ? '' : 's'} of this channel (select notes first to change only those).`;
}

/** Forgets the remembered dialog values (tests). */
export function resetScriptValues(): void {
  lastValues.clear();
}

function scriptLabel(e: ScriptEntry): string {
  const dots = Object.keys(e.def.params).length > 0 ? '…' : '';
  return `${e.def.name}${dots}${e.source === 'user' ? ' (user)' : ''}`;
}

/** Scripts grouped by category ("Other" for none), in the registry's order. */
export function scriptsByCategory(s: Services): [string, ScriptEntry[]][] {
  const groups = new Map<string, ScriptEntry[]>();
  for (const e of s.plugins.scripts()) {
    const category = e.def.category?.trim() || 'Other';
    const list = groups.get(category);
    if (list) list.push(e);
    else groups.set(category, [e]);
  }
  return [...groups];
}

/** Context-menu entries: one submenu per category. */
export function scriptMenu(s: Services): MenuEntry[] {
  const groups = scriptsByCategory(s);
  if (groups.length === 0) return [{ kind: 'label', label: 'No note scripts installed' }];
  const disabled = !scriptTarget(s);
  return groups.map(([category, list]) => ({
    kind: 'submenu',
    label: category,
    items: list.map((e) => ({ label: scriptLabel(e), disabled, onSelect: () => void openNoteScript(s, e.def.id) })),
  }));
}

/** Menu-bar entries (Edit > Piano roll tools): the same, as nested dynamic entries. */
export function scriptMenuBarEntries(s: Services): DynamicMenuEntry[] {
  const groups = scriptsByCategory(s);
  if (groups.length === 0) return [{ label: 'No note scripts installed', disabled: true, run: () => {} }];
  const disabled = !scriptTarget(s);
  return groups.map(([category, list]) => ({
    label: category,
    run: () => {},
    children: list.map((e) => ({
      label: scriptLabel(e),
      hint: e.def.description ?? e.def.name,
      disabled,
      run: () => void openNoteScript(s, e.def.id),
    })),
  }));
}
