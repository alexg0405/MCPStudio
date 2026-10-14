import { Profiler, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createServices } from '@app/services';
import { installAudioUnlock } from '@app/audio-unlock';
import { installSessionPersistence, startSession } from '@app/persistence/session';
import { loadRecentFiles } from '@app/persistence/recent-files';
import { applyView } from '@app/persistence/view-snapshot';
import { installPluginDiscovery } from '@app/plugins/discover';
import { PluginRegistry } from '@app/plugins/registry';
import { ServicesProvider } from './services-context';
import { registerFeatures } from './features';
import { offerRecovery } from './features/files/recovery';
import { installKeyboard } from './keyboard';
import { applyDefaultLayout } from './workspace/layouts';
import { App } from './shell/App';
import './theme/tokens.css';
import './theme/themes.css';
import './theme/base.css';

/** React commit counter (dev): idle playback should not re-render anything. */
const reactPerf = { commits: 0 };
function onRender() {
  reactPerf.commits++;
}

// Composition root: long-lived objects are created once, outside React.
const plugins = new PluginRegistry();
await installPluginDiscovery(plugins);
// This tab's state before a reload, and crashed sessions to offer for recovery.
const start = await startSession();
const restored = start.restored;
const services = createServices({ plugins, ...(restored ? { project: restored.project } : {}) });
registerFeatures(services);
installKeyboard(services);
installAudioUnlock(services.engine);
if (restored) {
  const { name, fileKey, dirty } = restored.file;
  services.files.store.setState({ name, fileKey, handle: restored.handle });
  if (dirty) services.history.markUnsaved();
}
if (!restored || !applyView(services, restored.view, restored.project)) applyDefaultLayout(services);
const persistence = installSessionPersistence(services, start.sessionId);
void loadRecentFiles();

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
  Object.assign(window, { __ag: Object.assign(services, { perf: { pianoRoll: pianoRollPerf, react: reactPerf } }) });
  const perf = new URLSearchParams(location.search).get('perf');
  if (perf) (await import('./perf-fixtures')).applyPerfFixture(services, perf);
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <Profiler id="app" onRender={onRender}>
      <ServicesProvider services={services}>
        <App />
      </ServicesProvider>
    </Profiler>
  </StrictMode>,
);

if (start.recovery.length > 0) void offerRecovery(services, start.recovery, persistence);
// First start: say what everything is (Help → Getting started brings it back). Not over crash recovery.
else if (!services.prefs.getState().welcomeSeen && !new URLSearchParams(location.search).has('perf'))
  services.commands.run('help.welcome');
