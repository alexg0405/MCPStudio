import { galleryBundle, type GalleryItem } from '@app/plugins/gallery';
import { shareBundle } from '@app/plugins/bundle-export';
import { inspectBundle, installBundle } from '@app/plugins/bundle-install';
import { packPlugins, usedUserPlugins } from '@app/plugins/project-plugins';
import { PluginServerError } from '@app/plugins/server';
import { PluginActionError, type InstallMode, type InstallResult } from '@app/plugins/types';
import type { MissingPluginsInfo } from '@app/project-files';
import type { Services } from '@app/services';
import { BUNDLE_EXTENSION } from '@core/plugin-bundle/manifest';
import { installDialogText, problemLines, usageSentence } from './describe';
import { showDialog } from '../../controls/Dialog';
import { showFormDialog } from '../../controls/FormDialog';
import { pickBundleFile } from './pick-file';

/**
 * Sharing and installing plugins: the questions to the musician (what is this plugin, what can it do, install it? replace
 * or copy? include my plugins in this song?) around the work `UserPlugins` does. Nothing is installed without the install
 * dialog being answered, whoever started it: the menu, a dropped file, a gallery button, a command from Studio or an AI app.
 */

const say = (s: Services, text: string, kind?: 'error') => s.session.getState().toast(text, kind);

/** A refusal in a dialog: what happened and the reasons, one per line. */
async function explain(title: string, message: string, problems: readonly string[] = []): Promise<void> {
  await showDialog({
    title,
    message: problems.length > 0 ? `${message}\n\n${problemLines(problems)}` : message,
    buttons: [{ id: 'ok', label: 'OK', primary: true }],
    cancelId: 'ok',
  });
}

/** Tells the musician what went wrong with an install or another action, in words (a toast, or a dialog when there is a list). */
export async function reportFailure(s: Services, error: unknown, what: string): Promise<void> {
  if (error instanceof PluginActionError) {
    if (error.problems.length > 0) await explain(`Could not ${what}`, error.message, error.problems);
    else say(s, error.message, 'error');
    return;
  }
  if (error instanceof PluginServerError) {
    say(s, error.message, 'error');
    return;
  }
  say(s, `Could not ${what}: ${error instanceof Error ? error.message : String(error)}`, 'error');
}

/** The sentence after an install: what happened and where to find it. */
function installedSentence(result: InstallResult): string {
  const what = result.replaced ? `Updated “${result.name}”` : `Installed “${result.name}”`;
  const presets = result.presetsAdded > 0 ? `, with ${result.presetsAdded} preset${result.presetsAdded === 1 ? '' : 's'}` : '';
  if (!result.loaded)
    return `${what} in plugins/${result.folder}${presets}, but it did not load${result.loadError ? `: ${result.loadError}` : ' yet'}. See My plugins.`;
  return `${what}${presets}. Find it in the browser under Plugins.`;
}

/**
 * Shows what a bundle is (name, author, what it can and cannot do, files, presets, a plugin with the same id) and installs
 * it when the musician says so. `onlyId` is for "update from a bundle": a bundle for another plugin is refused.
 * Returns what was installed, or null when it was refused, cancelled or failed (the musician has been told why).
 */
export async function importBundleBytes(s: Services, bytes: Uint8Array, options: { onlyId?: string; origin?: 'gallery' } = {}): Promise<InstallResult | null> {
  const up = s.userPlugins;
  const checked = await inspectBundle(up, bytes);
  if (!checked.ok) {
    await explain('This is not a plugin AGstudio can install', 'The file did not pass the safety checks, so nothing was installed.', checked.problems);
    return null;
  }
  const { inspection } = checked;
  const { manifest } = inspection.bundle;
  if (options.onlyId && manifest.id !== options.onlyId) {
    await explain('That is a different plugin', `This bundle is “${manifest.name}” (${manifest.id}), not the plugin you are updating (${options.onlyId}).`);
    return null;
  }
  const text = installDialogText(inspection);
  const { collision } = inspection;
  if (inspection.cannotInstall || collision.kind === 'identical') {
    await showDialog({ ...text, buttons: [{ id: 'close', label: 'Close', primary: true }], cancelId: 'close' });
    return null;
  }
  let mode: InstallMode;
  if (collision.kind === 'none') {
    const answer = await showDialog({
      ...text,
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'install', label: 'Install', primary: true },
      ],
      cancelId: 'cancel',
    });
    if (answer !== 'install') return null;
    mode = 'new';
  } else {
    const isNewer = collision.relation === 'newer';
    const answer = await showDialog({
      ...text,
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'copy', label: 'Install as a copy', primary: !isNewer },
        { id: 'replace', label: isNewer ? 'Update' : 'Replace', primary: isNewer },
      ],
      cancelId: 'cancel',
    });
    if (answer === 'cancel') return null;
    mode = answer === 'copy' ? 'copy' : 'replace';
  }
  try {
    const result = await installBundle(up, inspection.bundle, mode);
    if (options.origin) up.meta.set(result.id, { origin: options.origin });
    say(s, installedSentence(result), result.loaded ? undefined : 'error');
    return result;
  } catch (error) {
    await reportFailure(s, error, `install “${manifest.name}”`);
    return null;
  }
}

/** Asks for a `.agplugin` file and installs it (after the install dialog). */
export async function importBundleFile(s: Services, options: { onlyId?: string } = {}): Promise<InstallResult | null> {
  const file = await pickBundleFile();
  if (!file) return null;
  return importBundleBytes(s, new Uint8Array(await file.arrayBuffer()), options);
}

/** Installs a gallery plugin: packs it into a bundle and goes through the same dialog as any other bundle. */
export async function installGalleryItem(s: Services, item: GalleryItem): Promise<InstallResult | null> {
  return importBundleBytes(s, await galleryBundle(item), { origin: 'gallery' });
}

/** Bundles dropped on the window: each is checked and asked about, one after the other. */
export async function importDroppedBundles(s: Services, files: readonly File[]): Promise<void> {
  for (const file of files) await importBundleBytes(s, new Uint8Array(await file.arrayBuffer()));
}

/** Asks who made it and what it is, then saves the plugin as a `.agplugin` file. */
export async function sharePlugin(s: Services, id: string): Promise<void> {
  const up = s.userPlugins;
  try {
    const row = up.userRow(id);
    const values = await showFormDialog({
      title: `Share “${row.name}”`,
      message: `Packs this plugin's code and your presets for it into one ${BUNDLE_EXTENSION} file. Whoever gets it sees what it can do before installing it.`,
      fields: [
        { kind: 'text', key: 'author', label: 'Made by', placeholder: 'Your name (optional)' },
        { kind: 'text', key: 'description', label: 'About it', placeholder: 'What it does, in a sentence (optional)', multiline: true },
      ],
      values: { author: up.meta.get(id).author ?? '', description: row.description },
      okLabel: 'Save file',
    });
    if (!values) return;
    const packed = await shareBundle(up, id, { author: String(values.author).trim(), description: String(values.description).trim() });
    const presets = packed.presetCount > 0 ? ` with ${packed.presetCount} preset${packed.presetCount === 1 ? '' : 's'}` : '';
    const skipped = packed.skipped.length > 0 ? ` (left out: ${packed.skipped.join(', ')})` : '';
    say(s, `Saved ${packed.fileName}${presets}${skipped}. Send it to a friend: they drop it on AGstudio to install it.`);
  } catch (error) {
    await reportFailure(s, error, 'share this plugin');
  }
}

/** Save As: offers to carry the user plugins the song uses (off by default). Resolves their bundles, none, or null to cancel the save. */
export async function chooseEmbeddedPlugins(s: Services): Promise<Map<string, Uint8Array> | null> {
  const up = s.userPlugins;
  await up.refresh().catch(() => {});
  const used = up.hasServer ? usedUserPlugins(up) : [];
  if (used.length === 0) return new Map();
  const names = used.map(({ row }) => row.name).join(', ');
  const values = await showFormDialog({
    title: 'Include your plugins in this file?',
    message: `This song uses ${used.length === 1 ? 'a plugin' : 'plugins'} of your own: ${names}. A friend who opens the file without them hears silence where they should be.`,
    fields: [
      {
        kind: 'choice',
        key: 'include',
        label: 'Include them',
        options: [
          { value: 'no', label: 'No: the file only names them (the usual choice)' },
          { value: 'yes', label: `Yes: carry ${names} inside the file` },
        ],
      },
      { kind: 'info', text: 'Whoever opens the file is shown what each plugin can do and chooses whether to install it.' },
    ],
    values: { include: 'no' },
    okLabel: 'Continue to save',
  });
  if (!values) return null;
  if (values.include !== 'yes') return new Map();
  const packed = await packPlugins(up, used.map(({ row }) => row.id));
  for (const failure of packed.failed) say(s, `“${failure.name}” was left out: ${failure.reason}`, 'error');
  return packed.bundles;
}

/** What a project that opened with missing plugins shows: which ones, and the ways to get them. */
export async function offerMissingPlugins(s: Services, info: MissingPluginsInfo): Promise<void> {
  const ids = [...info.missing.keys()];
  const carried = ids.filter((id) => info.embedded.has(id));
  const lines = ids.map((id) => `• ${id}: ${usageSentence(info.missing.get(id)!)}`);
  const hasCarried = carried.length > 0;
  const answer = await showDialog({
    title: ids.length === 1 ? 'This song needs a plugin you do not have' : 'This song needs plugins you do not have',
    message: [`“${info.name}” uses ${ids.length === 1 ? 'this plugin' : 'these plugins'}, which ${ids.length === 1 ? 'is' : 'are'} not installed here:`, ...lines].join('\n'),
    detail: hasCarried
      ? 'The file carries its own copy of the plugin. You will see what it can do before anything is installed. Until then, those parts are silent.'
      : 'Until it is installed those parts are silent. If you have the plugin as a file (.agplugin), import it; the song picks it up as soon as it loads.',
    buttons: [
      { id: 'later', label: 'Not now' },
      { id: 'file', label: 'Import a plugin file…' },
      ...(hasCarried ? [{ id: 'carried', label: 'Install the plugins from this song', primary: true }] : []),
    ],
    cancelId: 'later',
  });
  if (answer === 'carried') {
    for (const id of carried) await importBundleBytes(s, info.embedded.get(id) as Uint8Array);
  } else if (answer === 'file') {
    await importBundleFile(s);
  }
}
