import { duplicatePlugin, renamePlugin, renameProblem } from '@app/plugins/plugin-edit';
import type { PluginRow, TrashRow } from '@app/plugins/types';
import type { Services } from '@app/services';
import { placeCount } from '@core/query/plugin-usage';
import { usageSentence, problemLines } from './describe';
import { importBundleFile, reportFailure } from './flows';
import { showDialog } from '../../controls/Dialog';
import { showFormDialog } from '../../controls/FormDialog';

/** What the manager's buttons do: each asks what it needs to (a name, "are you sure") and then calls `UserPlugins`. */

const say = (s: Services, text: string, kind?: 'error') => s.session.getState().toast(text, kind);

/** How a plugin in use is told about: "Used in 2 places in this song: …" or an empty string. */
const usedLine = (row: PluginRow) => (placeCount(row.usedIn) > 0 ? `It is used in ${usageSentence(row.usedIn)}.` : '');

/** Makes a copy of a plugin under a name the musician chooses. */
export async function duplicateRow(s: Services, row: PluginRow, suggestedName?: string): Promise<void> {
  const values = await showFormDialog({
    title: `Duplicate “${row.name}”`,
    message: 'Makes a new plugin of yours with the same code, so you can change it without touching the original.',
    fields: [{ kind: 'text', key: 'name', label: 'Name of the copy', placeholder: 'e.g. Tape Stop Deluxe' }],
    values: { name: suggestedName ?? '' },
    okLabel: 'Duplicate',
  });
  if (!values) return;
  try {
    const copy = await duplicatePlugin(s.userPlugins, row.id, String(values.name));
    say(s, `Made “${copy.name}” (plugins/${copy.folder}). Find it in the browser under Plugins; Edit code opens it.`);
  } catch (error) {
    await reportFailure(s, error, 'duplicate this plugin');
  }
}

/** Renames a plugin's id: asks for the new id, says what will follow, and does it as one undo step for the song. */
export async function renameRow(s: Services, row: PluginRow, suggestedId?: string): Promise<void> {
  const values = await showFormDialog({
    title: `Change the id of “${row.name}”`,
    message: `The id is the plugin's identity in projects and presets (now ${row.id}). Changing it moves the code to a new folder and points this song, your presets and your chains at the new id.`,
    fields: [
      { kind: 'text', key: 'id', label: 'New id', placeholder: 'user.my-plugin' },
      { kind: 'info', text: `${usedLine(row) || 'This song does not use it.'} Songs you saved earlier keep the old id and would need it back: they will not find the renamed plugin.` },
    ],
    values: { id: suggestedId ?? row.id },
    okLabel: 'Change id',
  });
  if (!values) return;
  const newId = String(values.id).trim();
  const problem = renameProblem(s.userPlugins, row.id, newId);
  if (problem) {
    say(s, problem, 'error');
    return;
  }
  try {
    const result = await renamePlugin(s.userPlugins, row.id, newId);
    say(s, `Renamed to ${result.to}: ${result.projectPlaces} place${result.projectPlaces === 1 ? '' : 's'} in the song and ${result.savedThings} preset or chain step${result.savedThings === 1 ? '' : 's'} follow. Undo brings the song back to ${result.from}; the old folder is in plugins/_trash.`);
  } catch (error) {
    await reportFailure(s, error, 'change the id');
  }
}

/** Switches a plugin off after saying what stops sounding. */
export async function disableRow(s: Services, row: PluginRow): Promise<void> {
  const used = usedLine(row);
  const answer = await showDialog({
    title: `Switch off “${row.name}”?`,
    message: `AGstudio stops loading it (its folder moves to plugins/_disabled). ${used ? `${used} Those parts go silent until you switch it back on.` : 'Nothing in this song uses it.'}`,
    detail: 'Nothing is deleted. Switch it back on from My plugins.',
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'disable', label: 'Switch off', primary: true },
    ],
    cancelId: 'cancel',
  });
  if (answer !== 'disable') return;
  try {
    await s.userPlugins.disable(row.id);
    say(s, `“${row.name}” is switched off.`);
  } catch (error) {
    await reportFailure(s, error, 'switch it off');
  }
}

export async function enableRow(s: Services, row: PluginRow): Promise<void> {
  try {
    await s.userPlugins.enable(row.id);
    say(s, `“${row.name}” is switched on again.`);
  } catch (error) {
    await reportFailure(s, error, 'switch it on');
  }
}

/** Deletes a plugin to the trash after saying what it takes with it. */
export async function deleteRow(s: Services, row: PluginRow): Promise<void> {
  const used = usedLine(row);
  const answer = await showDialog({
    title: `Delete “${row.name}”?`,
    message: `Its folder moves to plugins/_trash, so it can be brought back from My plugins. ${used ? `${used} Those parts go silent.` : 'Nothing in this song uses it.'}`,
    detail: 'Your presets for it stay in this browser.',
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'delete', label: 'Delete', danger: true, primary: true },
    ],
    cancelId: 'cancel',
  });
  if (answer !== 'delete') return;
  try {
    await s.userPlugins.trash(row.id);
    say(s, `“${row.name}” is in the trash. My plugins can bring it back.`);
  } catch (error) {
    await reportFailure(s, error, 'delete it');
  }
}

export async function restoreRow(s: Services, row: TrashRow): Promise<void> {
  try {
    const folder = await s.userPlugins.restore(row.entry);
    say(s, `Restored plugins/${folder}. It loads in a moment.`);
  } catch (error) {
    await reportFailure(s, error, 'restore it');
  }
}

/** Runs the safety scan and the type check and tells the result. */
export async function checkRow(s: Services, row: PluginRow): Promise<void> {
  try {
    const problems = await s.userPlugins.check(row.id);
    if (problems.length === 0) say(s, `“${row.name}” passed the safety scan and the type check.`);
    else
      await showDialog({
        title: `“${row.name}” has problems`,
        message: problemLines(problems),
        buttons: [{ id: 'ok', label: 'OK', primary: true }],
        cancelId: 'ok',
      });
  } catch (error) {
    await reportFailure(s, error, 'check it');
  }
}

/** Updates a plugin from a newer bundle file: asks for the file, shows what it is and what changes, and installs over it. */
export async function updateRow(s: Services, row: PluginRow): Promise<void> {
  await importBundleFile(s, { onlyId: row.id });
}

export async function openFolderRow(s: Services, row?: PluginRow): Promise<void> {
  try {
    await s.userPlugins.openFolder(row?.id);
  } catch (error) {
    await reportFailure(s, error, 'open the folder');
  }
}
