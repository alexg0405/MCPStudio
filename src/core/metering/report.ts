/**
 * The loudness report: what an offline listen to the song (or a range) measured, and how it reads as text. Pure; the
 * measuring is `app/metering/report.ts`.
 */
import type { TimeSignature } from '../model/types';
import { barOf } from '../time/bars';
import { streamingAdvice, type ServiceAdvice } from './targets';

/** A moment in the song: seconds into the measured part, and the song position (ticks) it was heard at. */
export interface Moment {
  sec: number;
  tick: number;
}

/**
 * What an offline listen measured for the song or a range of it: loudness, loudness range, peaks, the loudest moments
 * and where they are.
 */
export interface LoudnessReport {
  projectId: string;
  /** "the whole song", "bars 17–24", "your pattern on a loop". */
  what: string;
  /** Length of what was measured, seconds. */
  seconds: number;
  /** Where it started (ticks): the bar numbers of the moments below count from the song's start. */
  fromTick: number;
  integrated: number;
  /** Loudness range, LU. */
  range: number;
  /** The highest true peak of either channel (dBTP) and where; the highest sample peak (dBFS). */
  truePeakDb: number;
  truePeakAt: Moment | null;
  samplePeakDb: number;
  /** The loudest 400 ms and 3 s windows (LUFS) and where each ends. */
  maxMomentary: number;
  maxMomentaryAt: Moment | null;
  maxShortTerm: number;
  maxShortTermAt: Moment | null;
  /** Correlation of the whole part, −1…+1, and how much quieter it gets summed to mono (dB). */
  correlation: number;
  monoLossDb: number;
  /** What the services do to it. */
  services: ServiceAdvice[];
  /** Plain remarks ("true peak is over −1 dBTP"). */
  notes: string[];
  at: number;
}

const f1 = (v: number) => (Number.isFinite(v) ? (v < 0 ? '−' : v > 0 ? '+' : '') + Math.abs(v).toFixed(1) : '−∞');
const lufs = (v: number) => (Number.isFinite(v) ? `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}` : '−∞');

/** "bar 17.5" for a moment, so it can be found on the playlist. */
export function momentLabel(m: Moment | null, ts: TimeSignature): string {
  return m ? `bar ${barOf(m.tick, ts)}` : 'n/a';
}

/** Remarks about the numbers, in plain words. */
export function reportNotes(r: Pick<LoudnessReport, 'integrated' | 'truePeakDb' | 'range' | 'correlation' | 'monoLossDb'>): string[] {
  const notes: string[] = [];
  if (!Number.isFinite(r.integrated)) return ['Nothing audible was measured.'];
  if (r.truePeakDb > -1) notes.push(`The true peak is ${f1(r.truePeakDb)} dBTP: over −1 dBTP, so lossy encoders and some players can clip it. Lower the Limiter's ceiling.`);
  if (r.truePeakDb > 0) notes.push('It goes over 0 dBTP between the samples: it can distort on playback.');
  if (r.integrated > -9) notes.push('This is very loud: every streaming service turns it down, and it is likely squashed.');
  if (r.range < 3 && r.integrated > -14) notes.push(`The loudness range is only ${r.range.toFixed(1)} LU: very little dynamics.`);
  if (r.range > 15) notes.push(`The loudness range is ${r.range.toFixed(1)} LU: very dynamic; a quiet part may get lost on speakers.`);
  if (r.correlation < 0) notes.push('The channels are mostly out of phase: the song loses a lot in mono.');
  else if (r.monoLossDb < -3) notes.push(`Summed to mono it loses ${Math.abs(r.monoLossDb).toFixed(1)} dB: check the stereo width.`);
  return notes;
}

/** The report as text to paste anywhere. */
export function formatReport(r: LoudnessReport, ts: TimeSignature): string {
  const lines = [
    `Loudness report: ${r.what} (${r.seconds.toFixed(1)} s)`,
    `Integrated loudness: ${lufs(r.integrated)} LUFS`,
    `Loudness range: ${r.range.toFixed(1)} LU`,
    `True peak: ${f1(r.truePeakDb).replace('+', '')} dBTP at ${momentLabel(r.truePeakAt, ts)} (sample peak ${f1(r.samplePeakDb).replace('+', '')} dBFS)`,
    `Loudest momentary (400 ms): ${lufs(r.maxMomentary)} LUFS at ${momentLabel(r.maxMomentaryAt, ts)}`,
    `Loudest short-term (3 s): ${lufs(r.maxShortTerm)} LUFS at ${momentLabel(r.maxShortTermAt, ts)}`,
    `Stereo: correlation ${r.correlation.toFixed(2)}, ${f1(r.monoLossDb).replace('+', '')} dB in mono`,
  ];
  if (r.services.length) {
    lines.push('', 'What streaming services do:');
    for (const s of r.services) lines.push(`  ${s.service} (${lufs(s.target)} LUFS): ${s.text}`);
  }
  if (r.notes.length) lines.push('', ...r.notes);
  return lines.join('\n');
}

/** A compact object for the Studio and MCP. */
export function reportFacts(r: LoudnessReport, ts: TimeSignature) {
  return {
    measured: r.what,
    seconds: Math.round(r.seconds * 10) / 10,
    integrated_lufs: Number.isFinite(r.integrated) ? Math.round(r.integrated * 10) / 10 : null,
    loudness_range_lu: Math.round(r.range * 10) / 10,
    true_peak_dbtp: Number.isFinite(r.truePeakDb) ? Math.round(r.truePeakDb * 10) / 10 : null,
    true_peak_at: momentLabel(r.truePeakAt, ts),
    sample_peak_dbfs: Number.isFinite(r.samplePeakDb) ? Math.round(r.samplePeakDb * 10) / 10 : null,
    max_momentary_lufs: Number.isFinite(r.maxMomentary) ? Math.round(r.maxMomentary * 10) / 10 : null,
    max_momentary_at: momentLabel(r.maxMomentaryAt, ts),
    max_short_term_lufs: Number.isFinite(r.maxShortTerm) ? Math.round(r.maxShortTerm * 10) / 10 : null,
    max_short_term_at: momentLabel(r.maxShortTermAt, ts),
    correlation: Math.round(r.correlation * 100) / 100,
    mono_loss_db: Math.round(r.monoLossDb * 10) / 10,
    services: r.services.map((s) => `${s.service}: ${s.text}`),
    notes: r.notes,
  };
}

/** Builds a report's services and notes from its measurements (the rest is filled in by whoever measured). */
export function withAdvice<T extends Omit<LoudnessReport, 'services' | 'notes'>>(r: T): T & Pick<LoudnessReport, 'services' | 'notes'> {
  return { ...r, services: streamingAdvice(r.integrated, r.truePeakDb), notes: reportNotes(r) };
}
