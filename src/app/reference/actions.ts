/**
 * The Reference panel's and the Studio's actions on a reference song: set it (a file, a song of the music
 * library, a sample of the project), clear it, and one-click matches (tempo and key, the arrangement,
 * the loudness) and the tonal comparison. Every edit is one undo step. Setting a reference stores the
 * file like any other audio the musician imports; nothing of it is ever placed in the song.
 */
import type { Draft } from 'immer';
import { inferStyle } from '@core/beat/style';
import type { Project, ReferenceTrack, SampleRef, Tick } from '@core/model/types';
import { compareTone, mainTone, toneLines } from '@core/reference/bands';
import { loudnessTarget } from '@core/reference/track';
import { songFromBytes, type LibrarySong } from '../dj/library';
import { pickAudioFile } from '../actions/samples';
import { autoLevel, type AutoLevelResult } from '../mix/auto-level';
import type { Services } from '../services';
import { whileBusy } from '../storage/busy';
import { analyzeReference, type ReferenceAnalysisOptions } from './analyze';
import { clearReferenceInDraft, setReferenceInDraft } from './doc';
import { matchInDraft, type MatchOptions } from './match';
import { measureSongTone, type SongToneOptions } from './song-tone';
import { referenceState, type ToneReport } from './state';

const toast = (s: Services, text: string, kind: 'info' | 'error' = 'info') => s.session.getState().toast(text, kind);
const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/**
 * Puts the reference into the project as one undo step (see `setReferenceInDraft`); `amend` folds it into
 * the Studio answer's undo entry.
 */
export function commitReference(s: Services, track: ReferenceTrack, sample: SampleRef | null, opts: { amend?: number } = {}): boolean {
  return s.history.transact(
    `Set the reference “${track.title.slice(0, 40)}”`,
    (d: Draft<Project>) => void setReferenceInDraft(d, track, sample),
    opts.amend !== undefined ? { amend: opts.amend } : {},
  );
}

/** Removes the reference (one undo step). */
export function clearReference(s: Services): boolean {
  if (!s.doc.getState().project.reference) return false;
  referenceState.setState({ tone: null });
  return s.history.transact('Clear the reference', (d) => void clearReferenceInDraft(d));
}

/** Analyzes `ref` and sets it as the reference. Throws when the song can't be read (the callers say so). */
export async function analyzeAndSet(s: Services, ref: SampleRef, title: string, opts: ReferenceAnalysisOptions & { amend?: number } = {}): Promise<ReferenceTrack> {
  const track = await analyzeReference(s, ref, title, opts);
  commitReference(s, track, ref, opts.amend !== undefined ? { amend: opts.amend } : {});
  referenceState.setState({ tone: null });
  return s.doc.getState().project.reference ?? track;
}

/** Runs UI work with the panel's progress bar, a toast for failures, null when stopped. */
async function working<T>(s: Services, label: string, fn: (progress: (label: string, fraction: number) => void, signal: AbortSignal) => Promise<T>): Promise<T | null> {
  if (referenceState.getState().working) {
    toast(s, 'Wait for the reference to finish first.');
    return null;
  }
  const abort = new AbortController();
  stopper = () => abort.abort();
  referenceState.setState({ working: { label, fraction: 0 } });
  try {
    return await fn((l, f) => referenceState.setState({ working: { label: l, fraction: f } }), abort.signal);
  } catch (e) {
    if (isAbort(e)) toast(s, 'Stopped.');
    else toast(s, e instanceof Error ? e.message : String(e), 'error');
    return null;
  } finally {
    stopper = null;
    referenceState.setState({ working: null });
  }
}

let stopper: (() => void) | null = null;
/** Stops the analysis or measurement the panel is running. */
export const stopReferenceWork = (): void => stopper?.();

/** Sets a file the musician gave (dropped or chosen) as the reference. */
export function setReferenceFromFile(s: Services, file: Pick<File, 'name' | 'arrayBuffer'>): Promise<ReferenceTrack | null> {
  return whileBusy(async () => {
    const song = await working(s, `Reading “${file.name}”`, async (progress, signal) => {
      const found = await songFromBytes(new Uint8Array(await file.arrayBuffer()), file.name);
      if (!found) throw new Error(`Couldn’t read “${file.name}”: it isn’t audio the browser can play (MP3, AAC/M4A, WAV, FLAC and OGG work).`);
      const track = await analyzeAndSet(s, found.ref, found.label, { signal, onProgress: progress });
      return track;
    });
    if (song) toast(s, `Reference set: “${song.title}”${song.bpm !== null ? `, ${song.bpm} BPM` : ''}.`);
    return song;
  });
}

/** The file chooser, then `setReferenceFromFile` (call it from a click: the browser needs the gesture). */
export async function chooseReferenceFile(s: Services): Promise<ReferenceTrack | null> {
  const file = await pickAudioFile();
  return file ? setReferenceFromFile(s, file) : null;
}

/** A song of the music library (or any sample) as the reference. */
export async function setReferenceFromSample(s: Services, ref: SampleRef, title: string): Promise<ReferenceTrack | null> {
  const track = await working(s, `Analyzing “${title}”`, (progress, signal) => analyzeAndSet(s, ref, title, { signal, onProgress: progress }));
  if (track) toast(s, `Reference set: “${track.title}”${track.bpm !== null ? `, ${track.bpm} BPM` : ''}.`);
  return track;
}

export const setReferenceFromSong = (s: Services, song: LibrarySong): Promise<ReferenceTrack | null> => setReferenceFromSample(s, song.ref, song.label);

// ---------------------------------------------------------------- the matches

export interface ActionResult {
  /** Plain sentences for a toast or the panel. */
  message: string;
  changes: string[];
  warnings: string[];
  changed: boolean;
  error?: boolean;
  touched: { from: Tick; to: Tick } | null;
}

const noReference: ActionResult = {
  message: 'Set a reference song first (drop a file on the Reference window).',
  changes: [],
  warnings: [],
  changed: false,
  error: true,
  touched: null,
};

/** One undo step: the tempo, the key and/or the arrangement of the reference. */
export function runMatch(s: Services, label: string, opts: MatchOptions): ActionResult {
  const ref = s.doc.getState().project.reference;
  if (!ref) return noReference;
  const base = s.doc.getState().project;
  let res: ReturnType<typeof matchInDraft> | null = null;
  const changed = s.history.transact(label, (d) => {
    res = matchInDraft(d, s, base, ref, opts);
  });
  const r = res as ReturnType<typeof matchInDraft> | null;
  if (!r) return noReference;
  if (r.touched) s.view.getState().setMode('song');
  const parts = r.changes.length ? r.changes : r.warnings.slice(0, 1);
  const message = `${parts.join('. ')}.${r.changes.length && r.warnings.length ? ` Still to look at: ${r.warnings.slice(0, 2).join(' ')}` : ''}`;
  return { message, changes: r.changes, warnings: r.warnings, changed, ...(r.changes.length ? {} : { error: true }), touched: r.touched };
}

export const matchTempoAndKey = (s: Services): ActionResult => runMatch(s, 'Match tempo and key to the reference', { tempo: true, key: true });
export const arrangeLikeReference = (s: Services): ActionResult => runMatch(s, 'Arrange like the reference', { arrangement: true });

/** Levels the mix to the reference's loudness: one undo step (renders; it stops playback first). */
export async function matchLoudness(s: Services, opts: Pick<SongToneOptions, 'signal' | 'whenQuiet'> & { onProgress?(label: string, f: number): void; entry?: number | null } = {}): Promise<AutoLevelResult | null> {
  const ref = s.doc.getState().project.reference;
  if (!ref) throw new Error(noReference.message);
  return autoLevel(s, {
    style: inferStyle(s.doc.getState().project),
    targetLufs: loudnessTarget(ref),
    ...(opts.entry !== undefined ? { entry: opts.entry } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.whenQuiet ? { whenQuiet: opts.whenQuiet } : {}),
    ...(opts.onProgress ? { progress: opts.onProgress } : {}),
  });
}

/** The panel's "Match loudness" (progress, a toast; one undo step). */
export async function matchLoudnessFromUi(s: Services): Promise<void> {
  await working(s, 'Listening to your mix', async (progress, signal) => {
    const res = await matchLoudness(s, { signal, onProgress: progress });
    if (!res) return toast(s, 'Nothing to level: nothing plays in the busiest part of the song.', 'error');
    toast(s, res.message);
    for (const w of res.warnings.slice(0, 2)) toast(s, w, 'error');
  });
}

/** Measures the song and compares its balance with the reference's loud parts (no edit). */
export async function toneDifference(s: Services, opts: SongToneOptions = {}): Promise<ToneReport | null> {
  const ref = s.doc.getState().project.reference;
  if (!ref) throw new Error(noReference.message);
  const song = await measureSongTone(s, opts);
  if (!song) return null;
  const comparison = compareTone(song.bands, mainTone(ref));
  const report: ToneReport = { projectId: song.projectId, referenceHash: ref.hash, song, comparison, lines: toneLines(comparison) };
  referenceState.setState({ tone: report });
  return report;
}

/** The panel's "Show the tonal difference": the findings appear in the panel. */
export async function toneDifferenceFromUi(s: Services): Promise<void> {
  await working(s, 'Listening to your mix', async (progress, signal) => {
    const report = await toneDifference(s, { signal, onProgress: progress });
    if (!report) toast(s, 'Nothing to measure: nothing plays in the busiest part of the song.', 'error');
  });
}
