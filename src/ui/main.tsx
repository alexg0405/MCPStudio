import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createServices } from '@app/services';
import { installAudioUnlock } from '@app/audio-unlock';
import { installSessionSave, loadSession } from '@app/persistence/session-restore';
import { installPluginDiscovery } from '@app/plugins/discover';
import { PluginRegistry } from '@app/plugins/registry';
import { ServicesProvider } from './services-context';
import { registerFeatures } from './features';
import { installKeyboard } from './keyboard';
import { applyDefaultLayout } from './workspace/layouts';
import { App } from './shell/App';
import './theme/tokens.css';
import './theme/base.css';

// Composition root: long-lived objects are created once, outside React.
const plugins = new PluginRegistry();
await installPluginDiscovery(plugins);
const restored = loadSession();
const services = createServices({ plugins, ...(restored ? { project: restored.project } : {}) });
registerFeatures(services);
installKeyboard(services);
installAudioUnlock(services.engine);
if (restored?.view && Object.keys(restored.view.windows ?? {}).length > 0) {
  const pattern = restored.view.currentPatternId;
  services.view.setState({
    ...restored.view,
    currentPatternId:
      pattern && restored.project.patterns[pattern] ? pattern : services.view.getState().currentPatternId,
  });
} else {
  applyDefaultLayout(services);
}
installSessionSave(services);

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
  Object.assign(window, { __ag: services });
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <ServicesProvider services={services}>
      <App />
    </ServicesProvider>
  </StrictMode>,
);
