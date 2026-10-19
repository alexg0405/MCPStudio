/**
 * How the browser auditions a sound: a loop at the project's tempo (time-stretched keeping its pitch, or resampled like a
 * turntable, as you choose), starting on the next beat while the song plays; a tonal one-shot moved onto the song's key.
 * Pure: `previewPlan` turns what the analysis found and the settings into the engine's preview options.
 */
import { semitonesToKey } from './query';
import type { SampleAnalysis } from './types';

/**
 * The browser's choices for auditioning: whether to match the project's tempo, whether to stretch or resample to do it,
 * and whether to move a tonal sound into the song's key.
 */
export interface PreviewSettings {
  syncTempo: boolean;
  syncMode: 'stretch' | 'resample';
  inKey: boolean;
}

/** How a sound will be auditioned: the options for the engine and short notes saying what was done to it. */
export interface PreviewPlan {
  /** The engine's `PreviewOptions`. */
  opts: { rate?: number; stretch?: number; onBeat?: boolean; loop?: boolean };
  /** What was done, for the row's hint ("tempo 120 → 128", "up 3 semitones"). */
  notes: string[];
}

/** Sounds that have a note worth moving to the key: not drums (a snare has no pitch to tune). */
const TUNED = new Set(['tonal', '808', 'vocal']);

/** Tempos of the loop that might be what it plays at: itself, half and double (a loop read at half time). */
function nearestTempo(loop: number, project: number): number {
  let best = loop;
  for (const f of [1, 2, 0.5]) if (Math.abs(Math.log((loop * f) / project)) < Math.abs(Math.log(best / project))) best = loop * f;
  return best;
}

/**
 * Works out how to audition a sound at the project's tempo and key from its analysis and the settings (null analysis:
 * play it as it is).
 */
export function previewPlan(a: SampleAnalysis | null, settings: PreviewSettings, project: { bpm: number; key?: { root: number } }): PreviewPlan {
  const opts: PreviewPlan['opts'] = {};
  const notes: string[] = [];
  if (!a) return { opts, notes };
  if (a.kind === 'loop') {
    // Loops repeat until the next sound is picked or the same row is clicked again.
    opts.loop = true;
    if (settings.syncTempo && a.bpm && project.bpm > 0) {
      const from = nearestTempo(a.bpm, project.bpm);
      const ratio = from / project.bpm;
      if (Math.abs(ratio - 1) > 0.002) {
        if (settings.syncMode === 'stretch') opts.stretch = ratio;
        else opts.rate = 1 / ratio;
        notes.push(`${settings.syncMode === 'stretch' ? 'stretched' : 'resampled'} from ${Math.round(from * 10) / 10} to ${Math.round(project.bpm * 10) / 10} BPM`);
      }
      opts.onBeat = true;
    }
  } else if (a.kind === 'one-shot' && settings.inKey && project.key && a.root !== undefined && a.category && TUNED.has(a.category)) {
    const shift = semitonesToKey(a.root, project.key.root);
    if (shift !== 0) {
      opts.rate = Math.pow(2, shift / 12);
      notes.push(`${shift > 0 ? 'up' : 'down'} ${Math.abs(shift)} semitone${Math.abs(shift) === 1 ? '' : 's'} to the song key`);
    }
  }
  return { opts, notes };
}
