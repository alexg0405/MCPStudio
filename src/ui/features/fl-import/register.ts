import type { Services } from '@app/services';
import type { FlpImportOutcome } from '@app/actions/flp-import';
import { showDialog } from '../../controls/Dialog';
import { addMenuItems, cmd } from '../../shell/menus';
import { whenIdle } from '../../workspace/lazy';

/** FL Studio projects in (File menu, drops) and finding the samples an imported project is missing. */
export const order = 6;

const isFlp = (name: string) => /\.flp$/i.test(name);
const isZip = (name: string) => /\.zip$/i.test(name);

/** The FL import code (a parser and a mapper, ~30 kB) loads when you first import, not at startup. */
const flpActions = () => import('@app/actions/flp-import');
/** The zip check for dropped zips (is it a loop package with a project in it?): loads when a zip is dropped. */
const flpPackage = () => import('@core/io/flp-package');

const toast = (s: Services, text: string, kind?: 'error') => s.session.getState().toast(text, kind);

async function withBusy<T>(s: Services, run: () => Promise<T>): Promise<T> {
  s.files.store.setState({ busy: 'opening' });
  try {
    return await run();
  } finally {
    s.files.store.setState({ busy: null });
  }
}

/** The import report: what came across, what didn't and what to do about it. */
async function showReport(s: Services, out: FlpImportOutcome): Promise<void> {
  const missing = out.report.missingSamples.length > 0;
  const message = [out.headline, ...out.details.map((d) => `• ${d}`)].join('\n');
  const choice = await showDialog({
    title: `Imported “${out.name}” from FL Studio`,
    message,
    detail: 'It opened as a new project: save it to keep it (File > Save as…).',
    buttons: [
      ...(missing ? [{ id: 'find' as const, label: 'Find missing samples…' }] : []),
      { id: 'ok' as const, label: 'OK', primary: true },
    ],
    cancelId: 'ok',
  });
  // The dialog click is a fresh user gesture, so the file chooser may open.
  if (choice === 'find') await findMissing(s);
}

/** Imports an FL file and shows the report (errors as a toast). */
export async function importFl(s: Services, file: File): Promise<void> {
  toast(s, `Importing “${file.name}”…`);
  try {
    const { importFlpFile } = await flpActions();
    const out = await withBusy(s, () => importFlpFile(s, file));
    if (out) await showReport(s, out);
  } catch (e) {
    toast(s, e instanceof Error ? e.message : String(e), 'error');
  }
}

/** Matches audio files (or zips) to the project's missing samples by file name. */
async function relink(s: Services, files: File[]): Promise<void> {
  if (files.length === 0) return;
  try {
    const { relinkMissingSamples } = await flpActions();
    const res = await relinkMissingSamples(s, files);
    if (res.found.length === 0 && res.stillMissing.length === 0) {
      toast(s, 'No samples are missing in this project.');
      return;
    }
    const left = res.stillMissing.length;
    const found = res.found.length;
    toast(
      s,
      found === 0
        ? `None of those files are named like the ${left} missing sample${left === 1 ? '' : 's'} (${res.stillMissing.slice(0, 3).join(', ')}${left > 3 ? '…' : ''}).`
        : `Found ${found} sample${found === 1 ? '' : 's'}${left ? `; ${left} still missing (${res.stillMissing.slice(0, 3).join(', ')}${left > 3 ? '…' : ''})` : ''}.`,
      found === 0 ? 'error' : undefined,
    );
  } catch (e) {
    toast(s, e instanceof Error ? e.message : String(e), 'error');
  }
}

async function findMissing(s: Services): Promise<void> {
  const { missingSamples, pickSampleFiles } = await flpActions();
  const missing = await missingSamples(s);
  if (missing.length === 0) {
    toast(s, 'No samples are missing in this project.');
    return;
  }
  toast(
    s,
    `Choose the audio files (or a zip) for: ${missing
      .slice(0, 4)
      .map((r) => r.name)
      .join(', ')}${missing.length > 4 ? '…' : ''}`,
  );
  await relink(s, await pickSampleFiles());
}

export function register(services: Services): void {
  const { commands } = services;
  // Fetched in idle time, so the first import (which needs the click it came from) doesn't wait for the network.
  whenIdle(() => void flpActions());
  const idle = (s: Services) => s.files.store.getState().busy === null;

  commands.register({
    id: 'file.importFlp',
    gesture: true,
    title: 'Import FL Studio project…',
    category: 'File',
    hint: 'Open an FL Studio project (.flp, or a zipped loop package with its samples) as a new project',
    enabled: idle,
    run: async (s) => {
      const { pickFlpFile } = await flpActions();
      const file = await pickFlpFile();
      if (file) await importFl(s, file);
    },
  });
  commands.register({
    id: 'file.findMissingSamples',
    gesture: true,
    title: 'Find missing samples…',
    category: 'File',
    hint: 'Choose audio files or a zip; samples the project is missing (silent ones) are matched by file name',
    enabled: idle,
    run: (s) => findMissing(s),
  });
  addMenuItems('file', [cmd('file.importFlp', 21), cmd('file.findMissingSamples', 63)]);

  if (typeof window === 'undefined') return; // Node tests
  // An .flp dropped anywhere imports it; a zip is a loop package (with an .flp) or samples to find.
  window.addEventListener(
    'drop',
    (e) => {
      const files = [...(e.dataTransfer?.files ?? [])];
      const flp = files.find((f) => isFlp(f.name));
      const zips = files.filter((f) => isZip(f.name));
      if (!flp && zips.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (flp) {
        void importFl(services, flp);
        return;
      }
      void (async () => {
        const zip = zips[0] as File;
        const { isZip: isZipBytes, zipHasFlp } = await flpPackage();
        // Peek for a project: zipped loop packages import, zips of audio fill missing samples.
        const bytes = new Uint8Array(await zip.arrayBuffer());
        if (!isZipBytes(bytes)) {
          toast(services, `“${zip.name}” isn't a zip file.`, 'error');
          return;
        }
        if (zipHasFlp(bytes)) {
          await importFl(services, zip);
          return;
        }
        await relink(services, zips);
      })().catch((e: unknown) => toast(services, e instanceof Error ? e.message : String(e), 'error'));
    },
    true,
  );
}
