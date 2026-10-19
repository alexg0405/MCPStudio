/** The choices the audio half of the Export dialog offers, with the words that explain them (pure). */
import type { AudioExportSettings } from '@app/export/audio-export';
import { MP3_SAMPLE_RATES, type AudioCodec } from '@app/export/encode';
import { planExport, planSeconds, type ExportRange, type NamedExportRange } from '@app/export/plan';
import type { PrefsState } from '@app/stores/prefs';
import type { Project } from '@core/model/types';
import type { ExportSpan } from './export-store';
import { formatTime } from './export-text';

/** The part of the view the export plan reads (the current pattern and the loop region). */
type PlanView = Parameters<typeof planExport>[1];

/** The sample rates the dialog offers, in Hz. */
const SAMPLE_RATES_HZ = [44100, 48000, 96000];

/** The MP3 bit rates that get a word in the menu (kbps). */
const BEST_MP3_KBPS = 320;
const SMALLEST_MP3_KBPS = 128;

/** The file formats, with a plain explanation each (shown under the buttons and in the hint bar). */
export const CODECS: readonly { value: AudioCodec; label: string; note: string }[] = [
  {
    value: 'wav',
    label: 'WAV',
    note: 'Uncompressed: exactly what AGstudio rendered. Every app and DAW reads it; the biggest files.',
  },
  {
    value: 'flac',
    label: 'FLAC',
    note: 'Lossless like WAV (nothing is lost) at about half the size. Most players and DAWs read it.',
  },
  {
    value: 'mp3',
    label: 'MP3',
    note: 'Small files for sharing and phones. Some detail is lost; 320 kbps sounds closest to the original.',
  },
];

/** The words for a file format. */
export function codecInfo(codec: AudioCodec): (typeof CODECS)[number] {
  return CODECS.find((c) => c.value === codec) ?? CODECS[0]!;
}

/** The WAV bit depths (how the samples are stored). */
export const WAV_DEPTHS: readonly { value: PrefsState['exportFormat']; label: string; hint: string }[] = [
  { value: 'pcm16', label: '16-bit', hint: 'CD quality, with dither (a tiny noise that hides rounding)' },
  { value: 'pcm24', label: '24-bit', hint: 'Studio quality: more detail in quiet parts' },
  { value: 'float32', label: '32-bit float', hint: 'Never clips, even above 0 dB: best for mixing elsewhere' },
];

/** The sample rates that fit the chosen format (MP3 supports fewer). */
export function sampleRatesFor(codec: AudioCodec): number[] {
  return codec === 'mp3' ? SAMPLE_RATES_HZ.filter((rate) => MP3_SAMPLE_RATES.includes(rate)) : SAMPLE_RATES_HZ;
}

/** An MP3 bit rate as the menu shows it ("320 kbps (best)"). */
export function mp3BitrateLabel(kbps: number): string {
  if (kbps === BEST_MP3_KBPS) return `${kbps} kbps (best)`;
  if (kbps === SMALLEST_MP3_KBPS) return `${kbps} kbps (smallest)`;
  return `${kbps} kbps`;
}

/** What the progress bar says while the export runs. */
export function audioStageText(progress: { stage: string; label?: string }): string {
  if (progress.stage === 'encode') return progress.label === 'Zip' ? 'Packing the .zip' : 'Encoding';
  return progress.label ? `Rendering ${progress.label}` : 'Rendering';
}

/** The hint on the Export button: it says what the click asks for next. */
export function audioStartHint(settings: Pick<AudioExportSettings, 'stems' | 'stemsTo'>, codecLabel: string): string {
  if (!settings.stems) return `Choose where to save the ${codecLabel} file, then it is rendered`;
  if (settings.stemsTo === 'folder') return 'Choose a folder, then the stems are rendered into it';
  return 'Choose where to save the .zip, then the stems are rendered';
}

/** One choice in the Range section: a named range of the song, or the span the dialog was opened for. */
export type RangeChoice = NamedExportRange | 'span';

/** The range a choice stands for ('span' without a span falls back to the whole song). */
export function rangeOfChoice(choice: RangeChoice, span: ExportSpan | null): ExportRange {
  if (choice !== 'span') return choice;
  return span ? { from: span.from, to: span.to } : 'song';
}

/** The choice that starts selected: the span the dialog was opened for, else the song when it has content, else the pattern. */
export function initialRangeChoice(project: Project, view: PlanView, span: ExportSpan | null): RangeChoice {
  if (span) return 'span';
  const songPlan = planExport(project, view, 'song');
  return 'error' in songPlan ? 'pattern' : 'song';
}

/** A range row: its words, and how long it is ("8 bars, 0:16") or null when it cannot be exported now. */
export interface RangeOption {
  value: RangeChoice;
  label: string;
  hint: string;
  info: string | null;
}

/** "8 bars, 0:16" for a range, or null when there is nothing to export in it. */
function describeRange(project: Project, view: PlanView, range: ExportRange): string | null {
  const plan = planExport(project, view, range);
  if ('error' in plan) return null;
  const seconds = planSeconds(project, plan);
  const bars = Math.round(plan.bars * 100) / 100;
  return `${bars} bar${bars === 1 ? '' : 's'}, ${formatTime(seconds)}`;
}

/** The rows of the Range section, each with its length (or null for "not available"). */
export function rangeOptions(project: Project, view: PlanView, span: ExportSpan | null): RangeOption[] {
  const patternName = view.currentPatternId ? project.patterns[view.currentPatternId]?.name : '—';
  const choices: Omit<RangeOption, 'info'>[] = [
    { value: 'song', label: 'Song', hint: 'The whole playlist, from bar 1 to the end of the last clip' },
    { value: 'pattern', label: `Pattern: ${patternName}`, hint: 'Only the current pattern, once' },
    { value: 'loop', label: 'Loop region', hint: 'The range selected on the playlist ruler' },
  ];
  if (span) choices.unshift({ value: 'span', label: span.label, hint: `Only ${span.label}, with every track playing there` });
  return choices.map((choice) => ({ ...choice, info: describeRange(project, view, rangeOfChoice(choice.value, span)) }));
}
