import { Profiler, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createServices } from '@app/services';
import { installAudioUnlock } from '@app/audio-unlock';
import { resumeAfterReload } from '@app/resume-playback';
import { installSessionPersistence, restoredMissingNotice, startSession } from '@app/persistence/session';
import { loadRecentFiles } from '@app/persistence/recent-files';
import { applyView } from '@app/persistence/view-snapshot';
import { installPluginDiscovery } from '@app/plugins/discover';
import { installStorage } from '@app/storage/service';
import { PluginRegistry } from '@app/plugins/registry';
import { ServicesProvider } from './services-context';
import { registerFeatures } from './features';
import { offerRecovery } from './features/files/recovery';
import { installKeyboard } from './keyboard';
import { applyDefaultLayout } from './workspace/layouts';
import { App } from './shell/App';
import { startPrefetching } from './workspace/lazy';
import './theme/tokens.css';
import './theme/themes.css';
import './theme/base.css';

/** React commit counter (dev): idle playback should not re-render anything. `ms` adds up the render time of the commits. */
const reactPerf = { commits: 0, ms: 0 };
function onRender(_id: string, _phase: string, actualDuration: number) {
  if (reactPerf.commits === 0) performance.mark('ag:first-commit');
  reactPerf.commits++;
  reactPerf.ms += actualDuration;
}

// Composition root: long-lived objects are created once, outside React.
// Startup marks (DevTools > Performance > Timings): where the time before the first paint goes.
const mark = (name: string) => performance.mark(`ag:${name}`);
mark('script');
const plugins = new PluginRegistry();
// Plugin modules and this tab's saved state (its project before a reload, crashed sessions to offer for
// recovery) load side by side.
const [, start] = await Promise.all([
  installPluginDiscovery(plugins).then(() => mark('plugins')),
  startSession().then((r) => (mark('session'), r)),
]);
mark('loaded');
const restored = start.restored;
const services = createServices({ plugins, ...(restored ? { project: restored.project } : {}) });
mark('services');
registerFeatures(services);
mark('features');
installKeyboard(services);
installAudioUnlock(services.engine);
if (restored) {
  const { name, fileKey, dirty } = restored.file;
  services.files.store.setState({ name, fileKey, handle: restored.handle });
  if (dirty) services.history.markUnsaved();
}
if (!restored || !applyView(services, restored.view, restored.project)) applyDefaultLayout(services);
const persistence = installSessionPersistence(services, start.sessionId);
// Which audio this tab uses, published for the clean-up of unused audio. Development builds only log what
// the automatic clean-up would remove (localStorage 'agstudio:gc-dry-run' = '0' turns that off).
installStorage(services, start.sessionId, {
  dryRunOnly: import.meta.env.DEV && globalThis.localStorage?.getItem('agstudio:gc-dry-run') !== '0',
});
void loadRecentFiles();
// Reloaded mid-song (the dev server does that when code changes): carry on playing.
resumeAfterReload(services, restored?.transport);

// AI apps connect through the dev server (MCP): this tab answers their calls. No-op without HMR.
services.mcp.start(import.meta.hot);

if (import.meta.hot) {
  // AudioWorklet code changed (see the ag:worklet-hmr Vite plugin): restart audio with a fresh context.
  import.meta.hot.on('ag:worklet-changed', (data: { file?: string }) => {
    void services.rebootEngine().then(() => {
      const name = data.file?.split('/').slice(-2).join('/') ?? 'worklet';
      services.session.getState().toast(`Reloaded audio code (${name})`);
    });
  });
}

if (import.meta.env.DEV) {
  // Debug handle for the console and for automated checks: stores, history, commands, engine.
  const { pianoRollPerf } = await import('./features/piano-roll/controller');
  const { frameStats } = await import('./frame-loop');
  Object.assign(window, {
    __ag: Object.assign(services, { perf: { pianoRoll: pianoRollPerf, react: reactPerf, frames: frameStats } }),
  });
  const perf = new URLSearchParams(location.search).get('perf');
  if (perf) (await import('./perf-fixtures')).applyPerfFixture(services, perf);
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
mark('render');
createRoot(root).render(
  <StrictMode>
    <Profiler id="app" onRender={onRender}>
      <ServicesProvider services={services}>
        <App />
      </ServicesProvider>
    </Profiler>
  </StrictMode>,
);

// After the first paint: fetch the code of windows and features that load on first use.
requestAnimationFrame(() => setTimeout(startPrefetching, 0));

// A reload restore with sounds whose audio is gone says so, as crash recovery does (after the first paint).
if (restored) {
  void restoredMissingNotice(restored)
    .then((notice) => notice && services.session.getState().toast(notice, 'error'))
    .catch((e: unknown) => console.warn('Could not check for missing sounds:', e));
}

if (start.recovery.length > 0) void offerRecovery(services, start.recovery, persistence);
// First start: say what everything is (Help → Getting started brings it back). Not over crash recovery.
else if (!services.prefs.getState().welcomeSeen && !new URLSearchParams(location.search).has('perf'))
  services.commands.run('help.welcome');
