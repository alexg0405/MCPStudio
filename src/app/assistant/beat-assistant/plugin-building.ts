/**
 * Hand-off to the plugin builder: writing a new plugin an answer asked for, and installing or discarding the
 * draft it made. The builder carries the SDK guide and every template (~65 kB), so it loads when a plugin is
 * first built.
 */
import type { BuildStage, PluginDraft, PluginSpec } from '../../ai/builder';
import type { PluginMessage } from '../state';
import { errorText, isAbortError } from './errors';
import type { AssistantSession } from './session';

/** How long (ms) to wait for hot reload to bring an installed plugin into the registry. */
const PLUGIN_LOAD_TIMEOUT_MS = 15_000;

const loadBuilder = () => import('../../ai/builder');

/** The test render's peak, as a sentence for the draft's message ("" when there was none). */
function peakNote(draft: PluginDraft): string {
  const peakDb = draft.report?.peakDb;
  return peakDb != null ? ` Test render peak ${Math.round(peakDb)} dBFS.` : '';
}

/** "after 2 fixes" for a draft that needed fix rounds ("" when it worked the first time). */
function fixRoundsNote(draft: PluginDraft): string {
  if (!draft.rounds) return '';
  return ` after ${draft.rounds} fix${draft.rounds === 1 ? '' : 'es'}`;
}

/**
 * Has the plugin builder write a new plugin (asked for by an answer's build_plugin action). Its result
 * arrives as a message with Install and Discard.
 */
export async function buildPlugin(session: AssistantSession, spec: PluginSpec): Promise<void> {
  const { services, store } = session;
  const alreadyBuilding = store.getState().building;
  if (alreadyBuilding) {
    session.say('assistant', `I'm still building “${alreadyBuilding.name}”; one plugin at a time.`, { error: true });
    return;
  }
  const route = await session.route();
  if (!route) {
    session.say(
      'assistant',
      'Writing a plugin needs an AI (your Claude subscription, ChatGPT through Codex, or an API key); none is set up.',
      { error: true },
    );
    return;
  }
  const abort = new AbortController();
  session.buildAbort = abort;
  const showStage = (stage: BuildStage, round: number) =>
    store.setState({ building: { name: spec.name, kind: spec.kind, stage, round } });
  showStage('writing', 0);
  try {
    const { PluginBuilder, MAX_FIX_ROUNDS } = await loadBuilder();
    const builder = new PluginBuilder({ fetch: session.fetchImpl, smoke: session.smoke });
    const takenIds = [
      ...services.plugins.list().map((entry) => entry.def.id),
      ...services.plugins.scripts().map((entry) => entry.def.id),
    ];
    const result = await builder.build(spec, {
      model: session.modelFor(route),
      backend: route,
      signal: abort.signal,
      progress: showStage,
      taken: takenIds,
    });
    if (result.ok) {
      const { draft } = result;
      session.say('assistant', draft.message || `“${draft.name}” is ready.`, {
        detail: `Checked and test-rendered${fixRoundsNote(draft)}.${peakNote(draft)}`,
        plugin: { draft, state: 'draft' },
      });
    } else {
      session.say('assistant', `I couldn't get “${spec.name}” working after ${MAX_FIX_ROUNDS} rounds of fixes.`, {
        error: true,
        warnings: result.problems.slice(0, 8),
        ...(result.draft ? { plugin: { draft: result.draft, state: 'failed' as const } } : {}),
      });
    }
  } catch (error) {
    if (isAbortError(error)) session.say('assistant', `Stopped building “${spec.name}”.`);
    else session.say('assistant', errorText(error), { error: true });
  } finally {
    session.buildAbort = null;
    store.setState({ building: null });
  }
}

/** Stops the plugin build in flight, if any. */
export function cancelBuild(session: AssistantSession): void {
  session.buildAbort?.abort();
}

function setPluginState(session: AssistantSession, messageId: number, state: PluginMessage['state']): void {
  session.store.setState((current) => ({
    messages: current.messages.map((message) =>
      message.id === messageId && message.plugin ? { ...message, plugin: { ...message.plugin, state } } : message,
    ),
  }));
}

/** Waits for hot reload to bring a newly installed plugin into the registry; false if it takes too long. */
function waitForPlugin(session: AssistantSession, pluginId: string): Promise<boolean> {
  const { plugins } = session.services;
  if (plugins.get(pluginId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const stopWatching = plugins.subscribe(() => {
      if (!plugins.get(pluginId)) return;
      clearTimeout(timer);
      stopWatching();
      resolve(true);
    });
    const timer = setTimeout(() => {
      stopWatching();
      resolve(false);
    }, PLUGIN_LOAD_TIMEOUT_MS);
  });
}

/** Installs a checked draft: it moves into plugins/ and hot reload adds it to the browser. */
export async function installPlugin(session: AssistantSession, messageId: number): Promise<void> {
  const message = session.store.getState().messages.find((m) => m.id === messageId);
  if (!message?.plugin || message.plugin.state !== 'draft') return;
  const { draft } = message.plugin;
  const { services } = session;
  setPluginState(session, messageId, 'installing');
  try {
    const { installDraft } = await loadBuilder();
    const { replaced } = await installDraft(session.fetchImpl, draft.id);
    const isLoaded = await waitForPlugin(session, draft.id);
    setPluginState(session, messageId, 'installed');
    const backupNote = replaced ? ' (the old version is in plugins/_backup)' : '';
    const note = isLoaded
      ? `Installed “${draft.name}”${backupNote}. Find it in the browser under Plugins.`
      : `Installed “${draft.name}” in plugins/${draft.folder}; it appears once the app reloads it.`;
    services.session.getState().toast(note);
  } catch (error) {
    setPluginState(session, messageId, 'draft');
    services.session.getState().toast(errorText(error), 'error');
  }
}

/** Throws a draft away: its files are removed and the message says so. */
export async function discardPlugin(session: AssistantSession, messageId: number): Promise<void> {
  const message = session.store.getState().messages.find((m) => m.id === messageId);
  const plugin = message?.plugin;
  if (!plugin || (plugin.state !== 'draft' && plugin.state !== 'failed')) return;
  setPluginState(session, messageId, 'discarded');
  await loadBuilder()
    .then(({ discardDraft }) => discardDraft(session.fetchImpl, plugin.draft.id))
    .catch(() => {});
}
