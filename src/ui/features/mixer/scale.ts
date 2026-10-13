/**
 * Shared vertical scale of mixer faders and meters: both span the same height minus FADER_PAD at
 * each end (half the fader cap), and map gain through the fader taper, so a meter reaching the
 * fader cap means the signal is at the fader's level.
 */
import { gainToFader } from '@core/model/fader';

/** Half the fader cap height, CSS px: the cap's centre travels within [PAD, height - PAD]. */
export const FADER_PAD = 6;
export const FADER_CAP = FADER_PAD * 2;

/** Lowest level a meter shows. */
export const FLOOR_DB = -90;

/** dB → 0–1 position on the fader/meter scale. */
export function dbToPosition(db: number): number {
  return db <= FLOOR_DB ? 0 : gainToFader(Math.pow(10, db / 20));
}
