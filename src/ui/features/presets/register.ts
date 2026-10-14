import type { Services } from '@app/services';
import { addBrowserSection } from '../../shell/Browser';
import { PresetsSection } from './PresetsSection';

/** Presets in the browser (yours, and a search over every plugin's); the preset bar lives in plugin windows. */
export function register(_services: Services): void {
  addBrowserSection({ id: 'presets', title: 'Presets', icon: 'sparkle', order: 12, component: PresetsSection });
}
