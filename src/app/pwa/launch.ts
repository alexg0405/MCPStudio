import { importChainText } from '../chains';
import { importPresetText } from '../presets';
import { importRackText } from '../racks/library';
import type { Services } from '../services';

/**
 * "Open with AGstudio": the installed app is registered for .agproj, .agchain, .agpreset and .agrack files (the manifest's
 * file_handlers). Chrome hands the files to `launchQueue`; with the manifest's launch_handler (focus-existing) a file
 * opened while AGstudio is already running arrives in that same window instead of a second one.
 */

export type LaunchedKind = 'project' | 'chain' | 'preset' | 'rack' | 'unknown';

export function launchedKind(fileName: string): LaunchedKind {
  const name = fileName.toLowerCase();
  if (name.endsWith('.agproj')) return 'project';
  if (name.endsWith('.agchain')) return 'chain';
  if (name.endsWith('.agpreset')) return 'preset';
  if (name.endsWith('.agrack')) return 'rack';
  return 'unknown';
}

/** Which of the launched files to open as the project (the first one), and what each other file is. */
export function planLaunch(names: readonly string[]): { project: number | null; extraProjects: number; others: { index: number; kind: LaunchedKind }[] } {
  let project: number | null = null;
  let extraProjects = 0;
  const others: { index: number; kind: LaunchedKind }[] = [];
  names.forEach((name, index) => {
    const kind = launchedKind(name);
    if (kind === 'project') {
      if (project === null) project = index;
      else extraProjects++;
    } else others.push({ index, kind });
  });
  return { project, extraProjects, others };
}

/** What Chrome passes to the consumer. */
export interface LaunchParams {
  readonly files: readonly FileSystemFileHandle[];
}

interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void | Promise<void>): void;
}

/** Opens what the app was launched with: the project, and the chains, presets and racks added to the libraries. */
export async function openLaunchedFiles(s: Services, handles: readonly FileSystemFileHandle[]): Promise<void> {
  const toast = s.session.getState().toast;
  const plan = planLaunch(handles.map((h) => h.name));
  // Chains and presets first: they do not replace anything, and a project open may wait on an "unsaved changes" question.
  for (const { index, kind } of plan.others) {
    const handle = handles[index] as FileSystemFileHandle;
    try {
      const text = await (await handle.getFile()).text();
      if (kind === 'chain') importChainText(s, text);
      else if (kind === 'preset') importPresetText(s, text);
      else if (kind === 'rack') importRackText(s, text);
      else toast(`AGstudio can't open "${handle.name}": it opens .agproj projects, .agchain chains, .agpreset presets and .agrack racks.`, 'error');
    } catch (e) {
      toast(`Could not read "${handle.name}": ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }
  if (plan.project !== null) {
    const handle = handles[plan.project] as FileSystemFileHandle;
    try {
      // The handle goes along, so Save writes back to the same file.
      await s.files.openFile(await handle.getFile(), handle);
      if (plan.extraProjects > 0) toast(`AGstudio opens one project at a time: opened "${handle.name}".`);
    } catch (e) {
      toast(`Could not open "${handle.name}": ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }
}

/** Starts receiving launched files. False where the browser has no launch queue (a normal tab in another browser). */
export function installLaunchConsumer(s: Services, target: { launchQueue?: LaunchQueue } = globalThis as { launchQueue?: LaunchQueue }): boolean {
  if (!target.launchQueue) return false;
  target.launchQueue.setConsumer(async (params) => {
    if (params.files.length > 0) await openLaunchedFiles(s, params.files);
  });
  return true;
}
