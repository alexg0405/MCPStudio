/**
 * Loudness targets and what streaming services do to a song. Pure.
 *
 * Services measure a song's integrated loudness (BS.1770) and play it at their own reference level: louder songs are
 * turned down to it, and some turn quieter songs up (as far as the peaks allow). The numbers are the services'
 * published normalization levels; they change from time to time, so the window says "about".
 */

export interface LoudnessTarget {
  id: string;
  /** "Spotify, YouTube, Tidal: −14 LUFS". */
  label: string;
  lufs: number;
  /** The true peak ceiling that goes with it (dBTP). */
  truePeak: number;
  hint: string;
}

/** The targets the Meters window offers next to the song's own (its style's, or a reference's). */
export const STREAMING_TARGETS: readonly LoudnessTarget[] = [
  { id: 'streaming', label: 'Streaming (−14 LUFS)', lufs: -14, truePeak: -1, hint: 'Spotify, YouTube, Tidal and Amazon Music play songs at about −14 LUFS' },
  { id: 'apple', label: 'Apple Music (−16 LUFS)', lufs: -16, truePeak: -1, hint: 'Apple Music with Sound Check plays songs at about −16 LUFS' },
  { id: 'broadcast', label: 'Broadcast (−23 LUFS)', lufs: -23, truePeak: -1, hint: 'EBU R128 television and radio: −23 LUFS, true peak at most −1 dBTP' },
];

/** A streaming service and the loudness it plays songs at (LUFS), and whether it also turns quieter songs up. */
export interface Service {
  id: string;
  name: string;
  /** The level the service plays at (LUFS). */
  lufs: number;
  /** Whether it also turns quieter songs up. */
  raises: boolean;
}

/** The services the loudness advice covers, with their published reference levels. */
export const SERVICES: readonly Service[] = [
  { id: 'spotify', name: 'Spotify', lufs: -14, raises: true },
  { id: 'youtube', name: 'YouTube', lufs: -14, raises: false },
  { id: 'apple', name: 'Apple Music', lufs: -16, raises: true },
  { id: 'tidal', name: 'Tidal', lufs: -14, raises: false },
  { id: 'amazon', name: 'Amazon Music', lufs: -14, raises: false },
  { id: 'ebu', name: 'Broadcast (EBU R128)', lufs: -23, raises: true },
];

/**
 * What one service would do to a song: its reference level (LUFS), the gain it applies (dB) and a plain sentence about
 * it.
 */
export interface ServiceAdvice {
  service: string;
  /** Its reference level (LUFS). */
  target: number;
  /** The gain it applies to this song, dB (negative: turned down). 0 when it leaves the song alone. */
  changeDb: number;
  /** One plain sentence: "turns it down 1.3 dB", "leaves it as it is". */
  text: string;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const fmt = (v: number) => Math.abs(v).toFixed(1).replace('-', '');

/**
 * What each service does to a song of this integrated loudness and true peak. A raise is limited by the peaks: it
 * stops where the true peak would pass −1 dBTP (the service does not clip the song).
 */
export function streamingAdvice(integrated: number, truePeakDb: number | null): ServiceAdvice[] {
  if (!Number.isFinite(integrated)) return [];
  return SERVICES.map((s): ServiceAdvice => {
    const diff = s.lufs - integrated;
    if (diff < -0.05) return { service: s.name, target: s.lufs, changeDb: round1(diff), text: `turns it down ${fmt(diff)} dB` };
    if (diff > 0.05 && s.raises) {
      const room = truePeakDb !== null && Number.isFinite(truePeakDb) ? -1 - truePeakDb : Infinity;
      const up = Math.min(diff, Math.max(0, room));
      if (up < 0.05) return { service: s.name, target: s.lufs, changeDb: 0, text: 'leaves it as it is (its peaks leave no room to turn it up)' };
      return { service: s.name, target: s.lufs, changeDb: round1(up), text: `turns it up ${fmt(up)} dB${up < diff - 0.05 ? ' (as far as its peaks allow)' : ''}` };
    }
    return { service: s.name, target: s.lufs, changeDb: 0, text: diff > 0.05 ? 'leaves it as it is (quieter than its level, and it does not turn songs up)' : 'leaves it as it is' };
  });
}

/** How the song compares with a target: "2.3 LU louder than the target" or "on target". */
export function againstTarget(lufs: number, target: number): string {
  if (!Number.isFinite(lufs)) return '';
  const d = lufs - target;
  if (Math.abs(d) < 0.5) return 'on target';
  return `${Math.abs(d).toFixed(1)} LU ${d > 0 ? 'louder' : 'quieter'} than the target`;
}
