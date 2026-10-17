/**
 * Runs before every browser test file (vite.config.ts, project `audio`).
 *
 * Entity ids are random, and noisy kernels (the Pluck's excitation, hats, noise oscillators) seed their random
 * numbers from the id of the channel or effect slot they live in (engine/host.ts `seedFor`). With real random ids
 * the same song renders slightly differently every run, so level and tempo assertions with tight tolerances
 * (the style palette's ±2.5 dB, the DJ analysis' BPM) passed or failed by luck. A fixed id stream makes every
 * file's renders repeatable. Each test file runs in its own page, so every file starts the same stream.
 */
import { seededBytes, setIdSource } from '@core/model/ids';

setIdSource(seededBytes(0x5eed));

// Each file's page shares the origin's storage with the files before it: a setting one file saves (the Studio's
// autoplay, prefs, a remembered layout) would otherwise leak into the next and make results depend on file order.
try {
  localStorage.clear();
  sessionStorage.clear();
} catch {
  /* storage unavailable */
}
