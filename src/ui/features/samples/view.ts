/** Text and small calculations for the sample browser window (pure). */
import { CATEGORY_LABELS, type SampleAnalysis } from '@core/samples/types';
import { keyText, type SampleRow } from '@core/samples/query';

/** A row's height in px: the CSS of `.row` (28) fixes it; the windowed list relies on it. */
export const ROW_H = 28;

export const EMPTY_NO_FOLDERS_TITLE = 'No sample folders yet';
export const EMPTY_NO_FOLDERS_TEXT =
  'Click Add folder and pick a folder of your sounds (kicks, snares, loops…). The browser sorts them for you: what each sound is, a loop’s tempo and bars, the key of notes and chords. Then click a sound to hear it and drag it onto the channel rack, the playlist or a drum pad.';
export const EMPTY_NO_AUDIO_TEXT = 'This folder has no audio files (WAV, AIFF, FLAC, MP3, OGG or M4A) that the browser can find. Click Add folder to pick another one.';
export const EMPTY_NO_MATCH_TEXT = 'No sound matches these filters. Click Clear filters, or change the search words.';
export const EMPTY_RECONNECT_TEXT = 'The browser needs your permission again to read your sample folders. Click Reconnect.';

const LOOP_LABELS = { drums: 'Drum loop', bass: 'Bass loop', melodic: 'Melodic loop' } as const;

/** "0.42 s", "3.8 s", "1:23". */
export function lengthText(sec: number): string {
  if (!(sec > 0)) return '';
  if (sec < 10) return `${sec < 1 ? sec.toFixed(2) : sec.toFixed(1)} s`;
  if (sec < 60) return `${Math.round(sec)} s`;
  return `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
}

/** What the Type column shows: "Kick", "Loop", "Long file", "…" while it is being analyzed, "?" when it is not audio. */
export function typeText(row: Pick<SampleRow, 'analysis'> & { state?: 'pending' | 'ready' | 'failed' }): { text: string; loop: boolean; unsure: boolean } {
  const a = row.analysis;
  if (!a) return { text: row.state === 'failed' ? 'Not audio' : '…', loop: false, unsure: true };
  if (a.kind === 'loop') return { text: a.loopKind ? LOOP_LABELS[a.loopKind] : 'Loop', loop: true, unsure: a.confidence < 0.5 };
  if (a.kind === 'long') return { text: 'Long file', loop: false, unsure: false };
  if (!a.category) return { text: 'One-shot', loop: false, unsure: true };
  return { text: CATEGORY_LABELS[a.category], loop: false, unsure: a.confidence < 0.5 };
}

/** The tempo column: loops only. */
export const bpmText = (a: SampleAnalysis | null): string => (a?.kind === 'loop' && a.bpm ? String(Math.round(a.bpm)) : '');

/** What a row says about itself for the hint bar and tooltip. */
export function rowHint(row: SampleRow & { state?: 'pending' | 'ready' | 'failed' }): string {
  const a = row.analysis;
  const parts: string[] = [];
  if (a?.kind === 'loop') {
    parts.push(a.bpm ? `loop at ${Math.round(a.bpm * 10) / 10} BPM${a.bars ? `, ${a.bars} bar${a.bars === 1 ? '' : 's'}` : ''}` : 'loop (tempo not found)');
  } else if (a?.category) {
    parts.push(`${CATEGORY_LABELS[a.category].toLowerCase()}${a.confidence < 0.5 ? ' (not sure)' : ''}`);
  } else if (a?.kind === 'long') parts.push('a long file (not analyzed)');
  else if (row.state === 'failed') parts.push('not readable as audio');
  else if (!a) parts.push('being analyzed');
  const k = keyText(a);
  if (k) parts.push(`key ${k}`);
  return `${row.path}${parts.length ? `: ${parts.join(', ')}` : ''}. Click to hear it, double-click to add it to the project, drag it onto the channel rack, the playlist or a drum pad, right-click for more`;
}

/** Folder choices for the folder list: each folder and its first-level subfolders, with how many files are in them. */
export interface FolderChoice {
  value: string;
  label: string;
  count: number;
}

export function folderChoices(rows: readonly Pick<SampleRow, 'folder' | 'path'>[]): FolderChoice[] {
  const counts = new Map<string, number>();
  const order: string[] = [];
  const bump = (key: string) => {
    if (!counts.has(key)) order.push(key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (const r of rows) {
    bump(r.folder);
    const slash = r.path.indexOf('/');
    if (slash > 0) bump(`${r.folder}/${r.path.slice(0, slash)}`);
  }
  return order.map((value) => ({ value, label: value.includes('/') ? `   ${value.slice(value.indexOf('/') + 1)}` : value, count: counts.get(value) ?? 0 }));
}

/** "Analyzing 340 of 5,000 files (210 files/s)", or "" when idle. */
export function progressText(p: { total: number; done: number; running: boolean; filesPerSec: number; failed: number }): string {
  if (!p.running) return p.failed > 0 ? `${p.failed} file${p.failed === 1 ? '' : 's'} could not be read` : '';
  return `Analyzing ${p.done.toLocaleString('en')} of ${p.total.toLocaleString('en')} files${p.filesPerSec > 0 ? ` (${p.filesPerSec} files/s)` : ''}`;
}
