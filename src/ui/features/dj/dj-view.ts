/** What the DJ window shows, as plain functions (tested in Node). */
import type { AnalysisStatus } from '@app/dj/library';
import type { EnergyShape } from '@core/dj/order';
import type { MixTransitionStyle, TransitionRecipe } from '@core/dj/plan';
import type { TrackAnalysis } from '@core/dj/types';
import { camelotHue, keyName } from '@core/dj/wheel';

/** "3:07", "1:02:05". */
export function formatLength(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec)) return '–';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** SVG polyline points of an energy curve in a w × h box (at most `max` points, averaged). */
export function sparkPoints(energy: readonly number[], w: number, h: number, max = 48): string {
  if (energy.length === 0) return '';
  const n = Math.min(max, energy.length);
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * energy.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * energy.length) / n));
    let sum = 0;
    for (let k = a; k < b; k++) sum += energy[k] ?? 0;
    const v = Math.min(1, Math.max(0, sum / (b - a)));
    const x = n === 1 ? w / 2 : (i / (n - 1)) * w;
    pts.push(`${Math.round(x * 10) / 10},${Math.round((h - 1 - v * (h - 2)) * 10) / 10}`);
  }
  return pts.join(' ');
}

/** The key badge: its text, hint and color (by its place on the wheel; minor keys darker). */
export function keyBadge(a: TrackAnalysis | null): { text: string; hint: string; color: string | null } {
  const k = a?.key;
  if (!k) return { text: '–', hint: 'Key: not known yet', color: null };
  const hue = camelotHue(k.camelot);
  const sure = k.confidence >= 0.3;
  return {
    text: k.camelot,
    hint: `Key: ${keyName(k)} (${k.camelot} on the Camelot wheel)${sure ? '' : ', not sure'}. Songs next to each other on the wheel (±1, or A↔B) mix smoothly`,
    color: hue ? `hsl(${hue[0]} 55% ${hue[1]}%)` : null,
  };
}

/** A song's tempo as text: one decimal, "no beat" when it has none, a dash when not analyzed. */
export function bpmText(a: TrackAnalysis | null): string {
  if (!a) return '–';
  if (!a.grid) return 'no beat';
  return String(Math.round(a.grid.bpm * 10) / 10);
}

/** The status cell: "Analyzing 40 %", "Queued", "Couldn't analyze", or '' when done. */
export function statusText(a: TrackAnalysis | null, st: AnalysisStatus | undefined, analyzerMissing: boolean): string {
  if (a) return '';
  if (st?.state === 'running') return `Analyzing ${Math.round(st.fraction * 100)} %`;
  if (st?.state === 'error') return "Couldn't analyze";
  return analyzerMissing ? 'Not analyzed' : 'Queued';
}

/** The choices of the Order option, with their hints. */
export const ORDER_CHOICES: readonly { value: 'auto' | 'keep'; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Studio orders the songs: keys that fit (Camelot wheel), close tempos, and the energy shape you pick. Pinned songs keep their place' },
  { value: 'keep', label: 'Keep', hint: 'The songs play in the order of the list (drag rows to reorder)' },
];

/** The choices of the Energy option, with their hints. */
export const ENERGY_CHOICES: readonly { value: EnergyShape; label: string; hint: string }[] = [
  { value: 'party', label: 'Party', hint: 'Warm up, a first peak, a breather, then the biggest peak to close' },
  { value: 'build', label: 'Build', hint: 'From the calmest song to the hottest' },
  { value: 'peak-time', label: 'Peak time', hint: 'Hot from early on, hottest at the end' },
  { value: 'chill', label: 'Chill', hint: 'Small energy changes, long smooth transitions' },
];

/** The choices of the Transitions option, with their hints. */
export const TRANSITION_CHOICES: readonly { value: MixTransitionStyle; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Each transition by the songs: 16 bars (32 for chill), shorter where keys clash, a cut where tempos are too far apart' },
  { value: 'smooth', label: 'Smooth', hint: 'Long 32-bar blends' },
  { value: 'quick', label: 'Quick', hint: 'Short 8-bar blends' },
  { value: 'cut', label: 'Cut', hint: 'Straight cuts on the downbeat, with an echo on the last beat' },
];

/** The recipes a single transition can be changed to, with their hints. */
export const RECIPE_CHOICES: readonly { value: TransitionRecipe; label: string; hint: string }[] = [
  { value: 'bass-swap', label: 'Bass swap', hint: 'The next song comes in without its bass; halfway its bass comes in as this one’s goes' },
  { value: 'filter', label: 'Filter out', hint: 'Like the bass swap, and this song fades into a low-pass filter (good when the energy drops)' },
  { value: 'echo', label: 'Echo out', hint: 'The next song creeps in without its bass; this one stops on a downbeat with an echo' },
  { value: 'cut', label: 'Cut', hint: 'A cut on the downbeat with an echo on the last beat' },
];

/** The overlap lengths (bars) a transition can be set to (besides a cut). */
export const LENGTH_CHOICES: readonly number[] = [4, 8, 16, 32];

/** "1:05:00" mix length line: "12 songs · 54:20". */
export function libraryLine(count: number, seconds: number): string {
  return `${count} song${count === 1 ? '' : 's'}${seconds > 0 ? ` · ${formatLength(seconds)}` : ''}`;
}

/** What the empty music library says about where music comes from. */
export const EMPTY_TEXT = 'Add your own music files (MP3, AAC, WAV, FLAC). Streaming services like Spotify can’t be mixed: their audio is locked.';

/** A fixed mix tempo is held within this range (BPM); "Fixed" starts at the default. */
export const MIN_MIX_BPM = 50;
/** The highest fixed mix tempo (BPM). */
export const MAX_MIX_BPM = 250;
/** The tempo "Fixed" starts at (BPM). */
export const DEFAULT_FIXED_BPM = 124;

/** The longest length target that can be asked for (minutes). */
export const MAX_LENGTH_TARGET_MIN = 600;
