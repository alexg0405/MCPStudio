import type { BundleInspection } from '@app/plugins/types';
import { kindName } from '@core/plugin-bundle/capabilities';
import type { PluginUse } from '@core/query/plugin-usage';
import { placeCount } from '@core/query/plugin-usage';

/** What a dialog shows: a title, a message that keeps its line breaks, and a quieter line under it. */
export interface DialogText {
  title: string;
  message: string;
  detail: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const kilobytes = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** "Slows the sound…" kept to a sentence or two. */
const quoted = (text: string) => (text.trim() ? `“${text.trim()}”` : '');

/** The paragraph about a plugin with the same id, when there is one. */
function collisionText(inspection: BundleInspection): string {
  const { collision, bundle } = inspection;
  if (collision.kind === 'none') return '';
  if (collision.kind === 'identical') return 'This exact plugin is already installed, so there is nothing to do.';
  const where = collision.isDisabled ? ' (it is switched off)' : '';
  const their = collision.installedVersion === null ? 'a version that does not load' : `version ${collision.installedVersion}`;
  const relation =
    collision.relation === 'newer'
      ? `This bundle is newer (version ${bundle.manifest.version}).`
      : collision.relation === 'same'
        ? `This bundle has the same version (${bundle.manifest.version}) but different code.`
        : `This bundle is older (version ${bundle.manifest.version}).`;
  return [
    `You already have a different plugin with the id ${bundle.manifest.id}: ${their}${where}. ${relation}`,
    'Replace puts this one in its place (the old folder is kept in plugins/_backup, and songs keep their settings). Install as a copy keeps both.',
  ].join('\n');
}

/**
 * What the install dialog says about a bundle that passed the checks: what it is, who made it, what it can and cannot do
 * (in plain words), which files and presets come with it and whether it meets a plugin with the same id. The musician
 * decides after reading this; nothing has been installed yet.
 */
export function installDialogText(inspection: BundleInspection): DialogText {
  const { manifest, files, presets } = inspection.bundle;
  const bytes = files.reduce((sum, file) => sum + file.content.length, 0);
  const by = manifest.author ? ` by ${manifest.author}` : '';
  const lines = [
    `${manifest.name} is ${kindName(manifest.kind)}${by} (version ${manifest.version}, ${plural(files.length, 'file', 'files')}, ${kilobytes(bytes)}).`,
    quoted(manifest.description),
    '',
    'What it can do',
    ...inspection.capabilities.can.map((line) => `• ${line}`),
    '',
    'What it cannot do',
    ...inspection.capabilities.cannot.map((line) => `• ${line}`),
    '',
    `Files: ${files.map((file) => file.path).join(', ')}`,
    presets.length > 0 ? `Presets: ${presets.length} (${inspection.newPresets} new to you)` : 'Presets: none',
  ];
  const collision = collisionText(inspection);
  if (collision) lines.push('', collision);
  if (inspection.cannotInstall) lines.push('', inspection.cannotInstall);
  return {
    title: `Install “${manifest.name}”?`,
    message: lines.filter((line, i) => line !== '' || lines[i - 1] !== '').join('\n'),
    detail: inspection.capabilities.caution,
  };
}

/** "3 places: the channel Bell, the track Master" for a plugin's use in the open song; "" when it is not used. */
export function usageSentence(use: PluginUse): string {
  const count = placeCount(use);
  if (count === 0) return '';
  const names = [
    ...use.channels.map((channel) => `the channel ${channel.name}`),
    ...use.inserts.map((insert) => `the track ${insert.name}`),
  ];
  const shown = names.slice(0, 4).join(', ');
  return `${plural(count, 'place', 'places')} in this song: ${shown}${names.length > 4 ? ` and ${names.length - 4} more` : ''}`;
}

/** The problems of a refused bundle or draft as lines for a dialog (at most eight, then "and N more"). */
export function problemLines(problems: readonly string[]): string {
  const shown = problems.slice(0, 8).map((problem) => `• ${problem}`);
  if (problems.length > 8) shown.push(`…and ${problems.length - 8} more`);
  return shown.join('\n');
}
