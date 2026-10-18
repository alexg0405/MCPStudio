/**
 * Text and judgement for the Meters window: how a reading is written, whether it is fine, and the plain-words
 * warnings. Pure, so they are tested without a screen.
 */

/** "−14.2" for a loudness in LUFS, "−∞" for silence. */
export function lufsText(lufs: number): string {
  if (!Number.isFinite(lufs)) return '−∞';
  return `${lufs < 0 ? '−' : ''}${Math.abs(lufs).toFixed(1)}`;
}

/** "−1.2" for a peak in dB, "+0.3" above zero, "−∞" for silence. */
export function peakDbText(db: number): string {
  if (!Number.isFinite(db)) return '−∞';
  return `${db < 0 ? '−' : '+'}${Math.abs(db).toFixed(1)}`;
}

/** "+0.82" for a correlation. */
export function correlationText(value: number): string {
  return `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(2)}`;
}

/** "42 %" for a width share (0 to 1). */
export function widthText(share: number): string {
  return `${Math.round(Math.max(0, Math.min(1, share)) * 100)} %`;
}

/** How a loudness stands against the target: on it (within 1 LU), near it (within 3 LU) or off it. No target: neutral. */
export function loudnessState(lufs: number, target: number | null): 'none' | 'ok' | 'near' | 'off' {
  if (target === null || !Number.isFinite(lufs)) return 'none';
  const distance = Math.abs(lufs - target);
  if (distance <= 1) return 'ok';
  return distance <= 3 ? 'near' : 'off';
}

/** A true peak: fine up to −1 dBTP (what streaming services ask for), a warning up to 0, hot above (it can clip). */
export function peakState(db: number): 'none' | 'ok' | 'warn' | 'hot' {
  if (!Number.isFinite(db)) return 'none';
  if (db > 0) return 'hot';
  return db > -1 ? 'warn' : 'ok';
}

/** The stereo numbers the warnings read. */
export interface StereoReadings {
  correlation: number;
  corrLow: number;
  monoLossLow: number;
  /** Level of the bass band, dBFS. */
  levelLow: number;
}

/** The bass is only judged when there is some (under this the band is silence and its phase means nothing), dBFS. */
export const BASS_AUDIBLE_DB = -50;

/** The bass band's phase problem in plain words, or null when it is fine. */
export function monoWarning(r: StereoReadings): string | null {
  if (r.levelLow > BASS_AUDIBLE_DB && r.corrLow < 0) {
    return `The bass (below 150 Hz) is out of phase: it loses ${Math.abs(r.monoLossLow).toFixed(0)} dB when the song is played in mono (phones, clubs, some speakers). Check the polarity, or use the Stereo effect's mono bass.`;
  }
  if (r.correlation < -0.2) return 'The two channels mostly cancel each other: the song will sound thin or vanish in mono.';
  return null;
}
