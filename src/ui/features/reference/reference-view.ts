/** What the Reference window shows, as plain data (the component only draws it). */
import { keyName } from '@core/dj/key';
import type { Project, ReferenceTrack } from '@core/model/types';
import { mainTone, TONE_BANDS, type ToneComparison } from '@core/reference/bands';
import { modeOfScale } from '@core/reference/key';
import { referenceKeyName, sectionKindName } from '@core/reference/track';

export interface StripPart {
  label: string;
  bars: number;
  /** 0–1 */
  energy: number;
  kind: string;
  /** Share of the strip's width, 0–100. */
  widthPct: number;
}

/** Sections as a strip: widths follow bars (on a scale shared with the other strip), heights follow energy. */
export function stripParts(parts: readonly { label: string; bars: number; energy: number; kind: string }[], scaleBars: number): StripPart[] {
  const scale = Math.max(1, scaleBars);
  return parts.map((p) => ({ ...p, widthPct: Math.max(0.5, (100 * p.bars) / scale) }));
}

/** The reference's sections for the strip. */
export const referenceStrip = (ref: ReferenceTrack): { label: string; bars: number; energy: number; kind: string }[] =>
  ref.sections.map((s) => ({ label: sectionKindName(s.kind), bars: s.bars, energy: s.energy, kind: s.kind }));

export interface BandRow {
  id: string;
  label: string;
  refDb: number;
  /** Null until the mix has been listened to. */
  mixDb: number | null;
  /** Mix minus reference with the overall offset taken out; null before listening. */
  diffDb: number | null;
  off: boolean;
}

/** A band's dB share as a bar length, 0–1 (−45 dB and below is empty). */
export const bandFill = (db: number): number => Math.max(0, Math.min(1, (db + 45) / 45));

/** A band's difference to the reference as text ("+2.3 dB", "−1.0 dB", "0.0 dB"), or empty before the mix was listened to. */
export function diffText(diffDb: number | null): string {
  if (diffDb === null) return '';
  const plusOrMinus = diffDb > 0 ? '+' : diffDb < 0 ? '−' : '';
  return `${plusOrMinus}${Math.abs(diffDb).toFixed(1)} dB`;
}

/** The reference's tonal balance as bar rows, with the mix's next to it once it has been listened to. */
export function bandRows(ref: ReferenceTrack, comparison: ToneComparison | null): BandRow[] {
  const tone = mainTone(ref);
  return TONE_BANDS.map((b, i) => {
    const c = comparison?.bands[i];
    return {
      id: b.id,
      label: b.label,
      refDb: tone[i] ?? -60,
      mixDb: c ? c.mixDb : null,
      diffDb: c ? c.diffDb : null,
      off: !!comparison?.off.some((o) => o.index === i),
    };
  });
}

export interface FactRow {
  label: string;
  reference: string;
  mine: string;
  hint: string;
}

const sign = (x: number, digits = 1) => `${x < 0 ? '−' : ''}${Math.abs(x).toFixed(digits)}`;
const bpm = (x: number) => (Math.abs(x - Math.round(x)) < 0.005 ? String(Math.round(x)) : x.toFixed(1));

/** Tempo, key, loudness, true peak and width side by side (the song's loudness numbers once it was listened to). */
export function factRows(p: Project, ref: ReferenceTrack, song: { lufs: number; truePeakDb: number | null; width: number } | null): FactRow[] {
  const key = p.transport.key;
  const mineKey = key ? keyName({ root: key.root, mode: modeOfScale(key.scale) }) : null;
  const tempoNote = ref.bpm === null ? '' : Math.abs(p.transport.bpm - ref.bpm) < 0.05 ? ' (the same)' : ` (${p.transport.bpm > ref.bpm ? '+' : '−'}${bpm(Math.abs(p.transport.bpm - ref.bpm))})`;
  const heard = (v: string) => (song ? v : '—');
  return [
    { label: 'Tempo', reference: ref.bpm === null ? 'no steady beat' : `${bpm(ref.bpm)} BPM`, mine: `${bpm(p.transport.bpm)} BPM${tempoNote}`, hint: 'Beats per minute. Match tempo and key sets yours to the reference’s' },
    {
      label: 'Key',
      reference: referenceKeyName(ref) ?? 'not found',
      mine: mineKey ?? 'not set',
      hint: 'The musical key (Camelot code in brackets). Match tempo and key moves your pitched notes there; drums stay',
    },
    {
      label: 'Loudness',
      reference: `${sign(ref.lufs)} LUFS`,
      mine: song && Number.isFinite(song.lufs) ? `${sign(song.lufs)} LUFS` : '—',
      hint: 'Integrated loudness in LUFS (louder is closer to 0). Yours is measured when you press Show the tonal difference or Match loudness',
    },
    {
      label: 'True peak',
      reference: `${sign(ref.truePeakDb)} dBTP`,
      mine: song?.truePeakDb !== null && song?.truePeakDb !== undefined && Number.isFinite(song.truePeakDb) ? `${sign(song.truePeakDb)} dBTP` : '—',
      hint: 'The highest level between samples, in dBTP (below −1 is safe to encode)',
    },
    { label: 'Stereo width', reference: ref.width.toFixed(2), mine: heard(song ? song.width.toFixed(2) : ''), hint: 'Side energy over mid energy: 0 is mono, about 1 is very wide' },
  ];
}
