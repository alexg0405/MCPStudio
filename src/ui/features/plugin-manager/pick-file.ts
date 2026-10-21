/**
 * The file chooser for plugin bundles. The UI layer reaches the platform only through app services, and a hidden
 * `<input type=file>` is plain DOM, so it lives here instead of in `@platform`.
 */
import { BUNDLE_EXTENSION } from '@core/plugin-bundle/manifest';

/** Asks for one `.agplugin` file; null when the musician cancels. A chooser needs a recent click, as every file chooser does. */
export function pickBundleFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = BUNDLE_EXTENSION;
    input.style.display = 'none';
    const done = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => done(null), { once: true });
    document.body.append(input);
    input.click();
  });
}
