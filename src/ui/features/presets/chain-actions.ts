import { applyChain, allChains, chainTarget, saveInsertChain, type ChainMode } from '@app/actions/chains';
import { exportChainFile, findChainChoice, importChainFile, type ChainChoice, type ChainPreset } from '@app/chains';
import type { Services } from '@app/services';
import type { InsertId } from '@core/model/types';
import { insertLabel } from '@core/query/mixer';
import type { MenuEntry } from '../../controls/ContextMenu';
import { showDialog } from '../../controls/Dialog';
import { showFormDialog } from '../../controls/FormDialog';

const effectCount = (n: number) => `${n} effect${n === 1 ? '' : 's'}`;

/**
 * Puts a chain on a mixer insert. An insert with effects already gets one plain question (replace
 * them, or add the chain after them); with `mode` given, or on an empty insert, nothing is asked.
 * One undo step either way.
 */
export async function putChainOn(s: Services, chain: ChainPreset, insertId: InsertId, mode?: ChainMode): Promise<boolean> {
  const project = s.doc.getState().project;
  const insert = project.mixer.inserts[insertId];
  if (!insert) return false;
  let chosen = mode;
  if (!chosen) {
    if (insert.fx.length === 0) chosen = 'replace';
    else {
      const where = insertLabel(project, insertId);
      const answer = await showDialog({
        title: `Put “${chain.name}” on ${where}?`,
        message: `${where} already has ${effectCount(insert.fx.length)}.`,
        detail: 'Replace takes them off first. Add after keeps them and puts the chain behind them. Either one is a single undo step.',
        buttons: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'append', label: 'Add after them' },
          { id: 'replace', label: 'Replace them', primary: true },
        ],
        cancelId: 'cancel',
      });
      if (answer === 'cancel') return false;
      chosen = answer;
    }
  }
  return applyChain(s, insertId, chain, chosen) !== null;
}

/** Asks for a name and saves the insert's effects as one of your chains. */
export async function saveChainDialog(s: Services, insertId: InsertId, suggestion = ''): Promise<void> {
  const project = s.doc.getState().project;
  const insert = project.mixer.inserts[insertId];
  if (!insert) return;
  const where = insertLabel(project, insertId);
  if (insert.fx.length === 0) {
    s.session.getState().toast(`${where} has no effects to save yet. Add some, or put one of the vocal chains on it first.`, 'error');
    return;
  }
  const got = await showFormDialog({
    title: 'Save this track’s chain',
    message: `Saves the ${effectCount(insert.fx.length)} on ${where} with every setting, so you can put them on any track in any project.`,
    fields: [{ kind: 'text', key: 'name', label: 'Name', placeholder: 'e.g. My lead vocal' }],
    values: { name: suggestion },
    okLabel: 'Save',
  });
  const name = got ? String(got.name).trim() : '';
  if (!name) return;
  if (s.presets.findChain(name)) {
    const answer = await showDialog({
      title: 'Replace the chain?',
      message: `You already have a chain called “${name}”.`,
      detail: 'Replacing it keeps the name and saves these effects in it.',
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'replace', label: 'Replace', primary: true },
      ],
      cancelId: 'cancel',
    });
    if (answer !== 'replace') return;
  }
  const saved = saveInsertChain(s, insertId, name);
  if (saved) s.session.getState().toast(`Saved “${saved.name}”. It’s under Chains in the browser and in the track menu.`);
}

export async function renameChainDialog(s: Services, chain: ChainChoice): Promise<void> {
  if (chain.source !== 'user' || !chain.id) return;
  const got = await showFormDialog({
    title: 'Rename chain',
    fields: [{ kind: 'text', key: 'name', label: 'Name' }],
    values: { name: chain.name },
    okLabel: 'Rename',
  });
  const name = got ? String(got.name).trim() : '';
  if (!name || name === chain.name) return;
  if (!s.presets.renameChain(chain.id, name)) s.session.getState().toast(`You already have a chain called “${name}”.`, 'error');
}

export async function deleteChainDialog(s: Services, chain: ChainChoice): Promise<void> {
  if (chain.source !== 'user' || !chain.id) return;
  const answer = await showDialog({
    title: 'Delete the chain?',
    message: `“${chain.name}” will be gone from your chains.`,
    detail: 'Tracks that already use these effects keep them. To keep a copy, export it as a file first.',
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'delete', label: 'Delete', danger: true, primary: true },
    ],
    cancelId: 'cancel',
  });
  if (answer === 'delete') s.presets.removeChain(chain.id);
}

/** Menu entries for chains on one insert: apply any chain, save the insert's effects, import a file. */
export function chainMenuEntries(s: Services, insertId: InsertId): MenuEntry[] {
  const chains = allChains(s);
  const factory = chains.filter((c) => c.source === 'factory');
  const mine = chains.filter((c) => c.source === 'user');
  const item = (c: ChainChoice): MenuEntry => ({
    label: c.name,
    onSelect: () => void putChainOn(s, c, insertId),
    hint: `${c.description ?? c.name} (${effectCount(c.steps.length)})`,
  });
  const entries: MenuEntry[] = [{ kind: 'label', label: 'Vocal chains' }, ...factory.map(item)];
  if (mine.length) entries.push({ kind: 'separator' }, { kind: 'label', label: 'Your chains' }, ...mine.map(item));
  entries.push(
    { kind: 'separator' },
    {
      label: 'Save this track’s chain…',
      onSelect: () => void saveChainDialog(s, insertId),
      hint: 'Keep the effects on this track, with their settings, as a chain of your own',
    },
    {
      label: 'Import a chain file…',
      onSelect: () => void importChainFile(s),
      hint: 'Add a .agchain file to your chains',
    },
  );
  return entries;
}

/** What the chain commands do: the chain named in `args` (a name, or { chain, mode, insert }) on the selected track. */
export type ChainArgs = string | { chain?: string; mode?: ChainMode; insert?: string };

export function runChainCommand(s: Services, args: ChainArgs): void {
  const a = typeof args === 'string' ? { chain: args } : (args ?? {});
  const choice = a.chain ? findChainChoice(allChains(s), a.chain) : undefined;
  if (!choice) {
    s.session.getState().toast(a.chain ? `No chain called “${a.chain}”. Look under Chains in the browser.` : 'Say which chain to put on the track.', 'error');
    return;
  }
  const project = s.doc.getState().project;
  const named = a.insert ? project.mixer.order.find((id) => project.mixer.inserts[id]?.name.toLowerCase() === a.insert!.toLowerCase()) : undefined;
  void putChainOn(s, choice, named ?? chainTarget(s), a.mode === 'append' || a.mode === 'replace' ? a.mode : undefined);
}

export { exportChainFile };
