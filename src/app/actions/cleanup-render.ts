/**
 * The renderer that keeps a clip's cleaned audio up to date (see `cleanup.ts` for the edits). After an edit (not
 * undo, redo or load) that leaves a clip's render out of date, the cleaned audio is made after a short pause and
 * written into the same undo step as the edit, like the pitch renderer does for pitch correction.
 *
 * The cleaned audio is a new sample: the whole sample goes through the cleanup chain in a Worker (clicks, noise,
 * breaths), is encoded as 24-bit FLAC off-thread, written through the sample store, and listed in `Project.samples`.
 * What the render found (the quiet stretch it learned the noise from, the breaths) is written into the settings in
 * the same step, so the same settings always give the same sound.
 */
import { cleanupSignature, isNeutralCleanup, isRenderCurrent } from '@core/audio/cleanup-edit';
import type { CleanupFindings } from '@core/audio/cleanup/render';
import type { ClipId, Project, SampleId, SampleRef, VocalCleanup } from '@core/model/types';
import { setCleanupRender } from '@core/ops/cleanup';
import { encodeOffThread } from '../export/encode';
import { importSampleBytes } from '../persistence/sample-import';
import { CleanupJobCancelled, renderCleanupInWorker, type RunningCleanupJob } from '../cleanup/cleanup-jobs';
import { cleanupState } from '../cleanup/state';
import type { Services } from '../services';
import { whileBusy } from '../storage/busy';
import { audioClipOf } from './pitch-clip';

/** How long after the last edit the render starts, ms. */
export const CLEANUP_RENDER_DELAY_MS = 450;

/** The progress shown once the Worker is done: storing the file is what is left. */
const PROGRESS_AFTER_RENDER = 0.97;

/** Longest sample the cleanup takes: the same 15 minutes as the Pitch editor. */
export const CLEANUP_MAX_SECONDS = 15 * 60;

/** One render in flight (or waiting for its pause to end) for a clip. */
interface RenderRun {
  /** The settings it renders (`cleanupSignature`): a newer edit makes this run stale. */
  signature: string;
  job: RunningCleanupJob | null;
}

/** A clip's settings with the findings a render made written into them (what the clip's settings are after the render is stored). */
export function withFindings(settings: VocalCleanup, findings: CleanupFindings): VocalCleanup {
  const next: VocalCleanup = { ...settings };
  if (settings.noise && findings.noise && (settings.noise.from === undefined || settings.noise.to === undefined)) {
    next.noise = { ...settings.noise, from: findings.noise.from, to: findings.noise.to };
  }
  if (settings.breaths && findings.breaths && !settings.breaths.spans) next.breaths = { ...settings.breaths, spans: findings.breaths };
  return next;
}

/** Watches the document's edits and renders cleaned audio for the clips they leave out of date. */
class CleanupRenderer {
  private readonly s: Services;
  private readonly timers = new Map<ClipId, ReturnType<typeof setTimeout>>();
  private readonly runs = new Map<ClipId, RenderRun>();
  /** The history position of each clip's latest edit: its render is folded into that undo step. */
  private readonly cursors = new Map<ClipId, number>();
  private readonly unsubscribe: () => void;

  constructor(s: Services) {
    this.s = s;
    this.unsubscribe = s.history.onChange((change) => {
      if (change.origin !== 'edit' || !change.patches) return;
      for (const id of this.editedClips(change.patches)) {
        const clip = change.next.playlist.clips[id];
        if (clip?.kind !== 'audio' || !clip.cleanup) continue;
        this.cursors.set(id, s.history.status().cursor);
        this.schedule(id);
      }
    });
  }

  /** The clips a change touched. */
  private editedClips(patches: readonly { path: readonly (string | number)[] }[]): Set<ClipId> {
    const touched = new Set<ClipId>();
    for (const patch of patches) {
      if (patch.path[0] === 'playlist' && patch.path[1] === 'clips' && typeof patch.path[2] === 'string') touched.add(patch.path[2] as ClipId);
    }
    return touched;
  }

  /** The clip's cleanup as it is now (null when it has none or changes nothing). */
  private currentSettings(id: ClipId): VocalCleanup | null {
    const settings = audioClipOf(this.s.doc.getState().project, id)?.clip.cleanup;
    return settings && !isNeutralCleanup(settings) ? settings : null;
  }

  /**
   * Starts (or restarts) the pause before a render, unless the clip needs none: no cleanup, one that changes nothing,
   * or a render that is already current or already waiting. `force` renders even then.
   */
  schedule(id: ClipId, force = false): void {
    const waiting = this.timers.get(id);
    if (waiting) clearTimeout(waiting);
    this.timers.delete(id);
    const settings = this.currentSettings(id);
    const run = this.runs.get(id);
    // Nothing to clean (or all of it switched off): the clip plays its own audio, setCleanup already dropped the render.
    if (!settings) {
      run?.job?.cancel();
      this.runs.delete(id);
      return;
    }
    const signature = cleanupSignature(settings);
    if (!force && isRenderCurrent(settings)) return;
    if (!force && run && run.signature === signature) return;
    run?.job?.cancel();
    this.runs.set(id, { signature, job: null });
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        void this.render(id, signature);
      }, CLEANUP_RENDER_DELAY_MS),
    );
  }

  /** Renders the settings with this signature, if they are still the clip's, and shows progress and failures. */
  private async render(id: ClipId, signature: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run || run.signature !== signature) return;
    const project = this.s.doc.getState().project;
    const found = audioClipOf(project, id);
    const settings = found?.clip.cleanup;
    if (!found || !settings || cleanupSignature(settings) !== signature) return;
    const progress = (fraction: number) => cleanupState.setState({ rendering: { clipId: id, fraction } });
    try {
      progress(0);
      await whileBusy(() => this.renderAndStore(run, id, signature, found.channel.sampleId, found.channel.name, settings, project, progress), { project });
    } catch (e) {
      if (!(e instanceof CleanupJobCancelled)) {
        this.s.session.getState().toast(`The vocal cleanup could not be rendered: ${e instanceof Error ? e.message : String(e)}`, 'error');
      }
    } finally {
      if (this.runs.get(id) === run) this.runs.delete(id);
      if (cleanupState.getState().rendering?.clipId === id) cleanupState.setState({ rendering: null });
    }
  }

  /** Makes the cleaned audio, stores it and writes it into the edit's undo step. */
  private async renderAndStore(
    run: RenderRun,
    id: ClipId,
    signature: string,
    sampleId: SampleId,
    clipName: string,
    settings: VocalCleanup,
    project: Project,
    progress: (fraction: number) => void,
  ): Promise<void> {
    const ref = project.samples[sampleId];
    if (!ref) throw new Error('This clip’s audio is missing.');
    const data = await this.s.engine.sampleData(ref);
    if (!data) throw new Error('This clip’s audio could not be read.');
    if (data.duration > CLEANUP_MAX_SECONDS) throw new Error('This sound is over 15 minutes long: cut the clip out of it first, then clean it up.');
    // The Worker takes the audio; the engine keeps its own copy.
    const job = renderCleanupInWorker(data.channels.map((c) => Float32Array.from(c)), data.sampleRate, settings, progress);
    run.job = job;
    const result = await job.result;
    run.job = null;
    if (this.runs.get(id) !== run) return;
    progress(PROGRESS_AFTER_RENDER);
    const bytes = await encodeOffThread(result.channels, data.sampleRate, { codec: 'flac', bits: 24, kbps: 0 });
    const stored = await importSampleBytes(bytes, `${clipName} (cleaned up).flac`);
    const sample: SampleRef = { ...stored, durationSec: data.duration, sampleRate: data.sampleRate, channels: result.channels.length };
    this.commitRender(id, signature, withFindings(settings, result.findings), sample, result.findings);
  }

  /** Writes the render into the edit's own undo step, unless a newer edit has come in (it has its own render coming). */
  private commitRender(id: ClipId, signature: string, resolved: VocalCleanup, sample: SampleRef, findings: CleanupFindings): void {
    const now = this.currentSettings(id);
    if (!now || cleanupSignature(now) !== signature) return;
    cleanupState.setState((st) => {
      const problems = { ...st.problems };
      if (findings.noiseProblem) problems[id] = findings.noiseProblem;
      else delete problems[id];
      return { problems, clicks: { ...st.clicks, [id]: findings.clickCount } };
    });
    this.s.history.transact(
      'Vocal cleanup rendered',
      (d) =>
        setCleanupRender(d, id, sample, cleanupSignature(resolved), {
          ...(findings.noise ? { noise: findings.noise } : {}),
          ...(findings.breaths ? { breaths: findings.breaths } : {}),
        }),
      this.cursors.has(id) ? { amend: this.cursors.get(id) as number } : {},
    );
  }

  /** Stops watching and cancels everything pending. */
  stop(): void {
    this.unsubscribe();
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const run of this.runs.values()) run.job?.cancel();
    this.timers.clear();
    this.runs.clear();
  }
}

/** The running renderer (see `startCleanupRenderer`). */
let active: CleanupRenderer | null = null;

/**
 * Starts watching edits: after an edit (not undo, redo or load) that leaves a clip's render out of date, the cleaned
 * audio is made after a short pause and written into the same undo step. Returns the stop function. Created once, at start-up.
 */
export function startCleanupRenderer(s: Services): () => void {
  const renderer = new CleanupRenderer(s);
  active = renderer;
  return () => {
    active = null;
    renderer.stop();
  };
}

/** Makes the cleaned audio now (the window's "Render now" button, after a failed render). */
export function renderCleanupNow(clipId: ClipId): void {
  active?.schedule(clipId, true);
}

/** True when the clip's cleanup is being made or waiting to be made. */
export function isCleanupBusy(clipId: ClipId): boolean {
  return cleanupState.getState().rendering?.clipId === clipId;
}
