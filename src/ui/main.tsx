import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createServices } from '@app/services';
import { ServicesProvider } from './services-context';
import { registerFeatures } from './features';
import { installKeyboard } from './keyboard';
import { applyDefaultLayout } from './workspace/layouts';
import { App } from './shell/App';
import './theme/tokens.css';
import './theme/base.css';

// Composition root: long-lived objects are created once, outside React.
const services = createServices();
registerFeatures(services);
installKeyboard(services);
applyDefaultLayout(services);

if (import.meta.env.DEV) {
  // Debug handle for the console and for automated checks: stores, commands, keymap (engine from M1).
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
