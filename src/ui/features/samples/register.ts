import type { Services } from '@app/services';
import { loadSampleFolders } from '@app/persistence/sample-folders';
import { addBrowserSection } from '../../shell/Browser';
import { SampleFoldersSection } from './SampleFolders';

/** The user's sample folders in the browser. */
export function register(services: Services): void {
  addBrowserSection({
    id: 'sample-folders',
    title: 'Sample folders',
    icon: 'folder',
    order: 25,
    component: SampleFoldersSection,
  });
  void loadSampleFolders().catch((e: unknown) => {
    console.warn('Sample folders unavailable:', e);
    services.session.getState().toast("Couldn't load your sample folders.", 'error');
  });
}
