/**
 * Test-renders a plugin draft in a hidden iframe (plugin-test.html → smoke-page.ts), so a draft that
 * throws, hangs or blows up can't take the app with it. Resolves with what the render found.
 */
import type { SmokeReport } from './builder';

export const SMOKE_TIMEOUT_MS = 45_000;

export function smokeTest(folder: string, timeoutMs = SMOKE_TIMEOUT_MS): Promise<SmokeReport> {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(folder))
    return Promise.resolve({ problems: [`"${folder}" is not a plugin folder name.`], peakDb: null });
  return new Promise((resolve) => {
    const nonce = Math.random().toString(36).slice(2);
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;top:-10px;border:0;visibility:hidden';
    frame.src = `/plugin-test.html?folder=${encodeURIComponent(folder)}&nonce=${nonce}`;
    const done = (report: SmokeReport) => {
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      frame.remove();
      resolve(report);
    };
    const onMessage = (e: MessageEvent<{ nonce?: string; report?: SmokeReport }>) => {
      if (e.source !== frame.contentWindow || e.origin !== location.origin || e.data?.nonce !== nonce) return;
      done(e.data.report ?? { problems: ['The test page sent no report.'], peakDb: null });
    };
    const timer = window.setTimeout(
      () =>
        done({
          problems: [
            `The test render didn't finish within ${Math.round(timeoutMs / 1000)} seconds: the plugin is far too slow, or loops forever.`,
          ],
          peakDb: null,
        }),
      timeoutMs,
    );
    window.addEventListener('message', onMessage);
    document.body.append(frame);
  });
}
