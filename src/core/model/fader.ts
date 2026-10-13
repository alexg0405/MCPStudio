/**
 * Mixer fader taper. Insert volume is stored as linear gain (1 = 0 dB, at most +5.6 dB like FL).
 * Faders and the master volume knob move along a dB-style taper instead: 0 dB sits at 80% of the
 * travel, the top is +5.6 dB and the bottom is silence. In between the gain follows a power law,
 * so the upper travel is close to linear in dB and the quiet end is compressed (like a console).
 */

/** Largest insert volume: +5.6 dB. */
export const MAX_INSERT_VOLUME = 1.905;

/** Fader position (0–1) of unity gain. */
export const UNITY_POSITION = 0.8;

/** gain = (position / UNITY_POSITION) ^ EXPONENT, chosen so position 1 is exactly MAX_INSERT_VOLUME. */
const EXPONENT = Math.log(MAX_INSERT_VOLUME) / Math.log(1 / UNITY_POSITION);

/** Fader travel 0–1 → linear gain. */
export function faderToGain(position: number): number {
  if (!(position > 0)) return 0;
  if (position >= 1) return MAX_INSERT_VOLUME;
  return Math.min(MAX_INSERT_VOLUME, Math.pow(position / UNITY_POSITION, EXPONENT));
}

/** Linear gain → fader travel 0–1 (inverse of faderToGain). */
export function gainToFader(gain: number): number {
  if (!(gain > 0)) return 0;
  return Math.min(1, UNITY_POSITION * Math.pow(gain, 1 / EXPONENT));
}

/** Linear gain → decibels (-Infinity for silence). */
export function gainToDecibels(gain: number): number {
  return gain > 0 ? 20 * Math.log10(gain) : -Infinity;
}

/** "-6.0 dB", "+2.5 dB", "0.0 dB", "-∞ dB". */
export function formatGain(gain: number): string {
  const db = gainToDecibels(gain);
  if (!(db > -120)) return '-∞ dB';
  const text = db.toFixed(1);
  if (text === '-0.0' || text === '0.0') return '0.0 dB';
  return `${db > 0 ? '+' : ''}${text} dB`;
}
