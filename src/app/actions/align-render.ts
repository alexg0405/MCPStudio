/**
 * The renderer that keeps aligned audio up to date (see `align.ts` for the edits). After an edit (not undo, redo or load)
 * that leaves an aligned clip's render out of date, the aligned audio is made after a short pause and written into the
 * same undo step as the edit.
 *
 * The aligned audio is a new sample: the clip's stretch of the sound goes through the alignment in a Worker
 * (`app/align`), comes back spliced into a copy of the whole sample (so trims, fades and tempo follow keep working),
 * stored as 24-bit FLAC through the sample store, and listed in `Project.samples`. What an alignment depends on is
 * `planAlignment`'s signature: it changes when the settings, the clip, the guide, the tempo or the grid do.
 */
import { planAlignment, type AlignPlan } from '@core/audio/align/plan';
import { clampSpan, cutRegion, guideMono } from '../align/guide-audio';
import { AlignJobCancelled, runAlignInWorker, type RunningAlignJob } from '../align/align-jobs';
import type { AlignJob, AlignJobResult } from '../align/run';
import { alignState, setAlignProblem, setAlignProgress, setAlignStats } from '../align/state';
import type { ClipId, Project, SampleRef } from '@core/model/types';
import { setAlignRender } from '@core/ops/align';
import { alignPitch, alignStrength } from '@core/audio/align/edit';
import { encodeOffThread } from '../export/encode';
import { importSampleBytes } from '../persistence/sample-import';
import type { Services } from '../services';
import { whileBusy } from '../storage/busy';
import { audioClipOf } from './pitch-clip';
import { spliceRendered } from './pitch-render';

/** How long after the last edit the render starts, ms. */
export const ALIGN_RENDER_DELAY_MS = 450;
/** The progress shown once the Worker is done: storing the file is what is left. */
const PROGRESS_AFTER_RENDER = 0.97;

/** Why an alignment could not be made, in plain words. */
export class AlignError extends Error {}

/** One render in flight (or waiting for its pause to end) for a clip. */
interface RenderRun {
  signature: string;
  job: RunningAlignJob | null;
}

/** The part of the project edits can change that decides whether an aligned clip's render is still good. */
const RELEVANT_PATHS = new Set(['playlist', 'transport', 'channels', 'automation', 'samples']);

/** Watches the document's edits and renders aligned audio for the clips they leave out of date. */
class AlignRenderer {
  private readonly s: Services;
  private readonly timers = new Map<ClipId, ReturnType<typeof setTimeout>>();
  private readonly runs = new Map<ClipId, RenderRun>();
  /** The history position of the edit that made each clip's render stale: its render is folded into that undo step. */
  private readonly cursors = new Map<ClipId, number>();
  private readonly unsubscribe: () => void;

  constructor(s: Services) {
    this.s = s;
    this.unsubscribe = s.history.onChange((change) => {
      if (change.origin !== 'edit' || !change.patches) return;
      if (!change.patches.some((patch) => RELEVANT_PATHS.has(String(patch.path[0])))) return;
      const cursor = s.history.status().cursor;
      for (const clip of Object.values(change.next.playlist.clips)) {
        if (clip.kind !== 'audio' || !clip.align) continue;
        if (this.schedule(clip.id)) this.cursors.set(clip.id, cursor);
      }
    });
  }

  /**
   * Starts (or restarts) the pause before a render, unless the clip needs none: no alignment, a render that is already
   * current or already waiting, or something that makes it impossible (said in the clip's problem). `force` renders
   * even when current. Returns true when a render was scheduled.
   */
  schedule(id: ClipId, force = false): boolean {
    const project = this.s.doc.getState().project;
    const clip = audioClipOf(project, id)?.clip;
    const run = this.runs.get(id);
    if (!clip?.align) {
      this.forget(id);
      return false;
    }
    const planned = planAlignment(project, id);
    if ('problem' in planned) {
      this.forget(id);
      setAlignProblem(id, planned.problem);
      return false;
    }
    setAlignProblem(id, null);
    const { signature } = planned.plan;
    if (!force && clip.align.renderedFor === signature && clip.align.renderedSampleId) {
      this.forget(id);
      return false;
    }
    if (!force && run && run.signature === signature) return false;
    const waiting = this.timers.get(id);
    if (waiting) clearTimeout(waiting);
    run?.job?.cancel();
    this.runs.set(id, { signature, job: null });
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        void this.render(id, signature);
      }, ALIGN_RENDER_DELAY_MS),
    );
    return true;
  }

  /** Drops what is waiting or running for the clip. */
  private forget(id: ClipId): void {
    const waiting = this.timers.get(id);
    if (waiting) clearTimeout(waiting);
    this.timers.delete(id);
    this.runs.get(id)?.job?.cancel();
    this.runs.delete(id);
    setAlignProgress(id, null);
  }

  /** Renders the alignment with this signature, if it is still the clip's, and shows progress and failures. */
  private async render(id: ClipId, signature: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run || run.signature !== signature) return;
    const project = this.s.doc.getState().project;
    const planned = planAlignment(project, id);
    if ('problem' in planned || planned.plan.signature !== signature) return;
    const plan = planned.plan;
    const found = audioClipOf(project, id);
    const name = found?.channel.name ?? 'clip';
    const progress = (fraction: number) => setAlignProgress(id, fraction);
    try {
      progress(0);
      await whileBusy(() => this.renderAndStore(run, plan, name, project, progress), { project });
    } catch (e) {
      if (!(e instanceof AlignJobCancelled)) {
        const text = e instanceof Error ? e.message : String(e);
        setAlignProblem(id, text);
        this.s.session.getState().toast(`Alignment could not be rendered: ${text}`, 'error');
      }
    } finally {
      if (this.runs.get(id) === run) this.runs.delete(id);
      setAlignProgress(id, null);
    }
  }

  /** Makes the aligned audio, stores it and writes it into the edit's undo step. */
  private async renderAndStore(run: RenderRun, plan: AlignPlan, clipName: string, project: Project, progress: (fraction: number) => void): Promise<void> {
    const ref = project.samples[plan.sourceSampleId];
    if (!ref) throw new AlignError('This clip’s audio is missing.');
    const data = await this.s.engine.sampleData(ref);
    if (!data) throw new AlignError('This clip’s audio could not be read.');
    const cut = cutRegion(data.channels, data.sampleRate, plan.region.fromSec, plan.region.toSec);
    if (cut.endFrame <= cut.startFrame) throw new AlignError('There is no sound in this clip to align.');
    const lengthSec = (cut.endFrame - cut.startFrame) / data.sampleRate;
    const job = await this.jobFor(plan, cut.channels, data.sampleRate, cut.startFrame / data.sampleRate, lengthSec, project);
    const running = runAlignInWorker(job, (fraction) => progress(fraction * PROGRESS_AFTER_RENDER));
    run.job = running;
    const result = await running.result;
    run.job = null;
    if (this.runs.get(plan.clipId) !== run) return;
    const full = spliceRendered(data.channels, result.channels, cut.startFrame, cut.endFrame);
    progress(PROGRESS_AFTER_RENDER);
    const bytes = await encodeOffThread(full, data.sampleRate, { codec: 'flac', bits: 24, kbps: 0 });
    const stored = await importSampleBytes(bytes, `${clipName} (aligned).flac`);
    const sample: SampleRef = { ...stored, durationSec: data.duration, sampleRate: data.sampleRate, channels: full.length };
    this.commit(plan, sample, result);
  }

  /** The job for a plan: the stretch of the clip, and for a guide the guide's sound on the same axis. */
  private async jobFor(
    plan: AlignPlan,
    channels: Float32Array[],
    sampleRate: number,
    startSec: number,
    lengthSec: number,
    project: Project,
  ): Promise<AlignJob> {
    const audible = clampSpan(plan.audible, lengthSec);
    if (plan.grid) {
      const strength = alignStrength(plan.edit);
      return { kind: 'grid', channels, sampleRate, startSec, audible, linesSec: plan.grid.linesSec, strength, maxMoveSec: plan.grid.maxMoveSec };
    }
    const guide = plan.guide;
    const guideRef = guide ? project.samples[guide.sampleId] : undefined;
    if (!guide || !guideRef) throw new AlignError('The guide’s audio is missing.');
    const guideData = await this.s.engine.sampleData(guideRef);
    if (!guideData) throw new AlignError('The guide’s audio could not be read.');
    const mono = guideMono(guideData.channels, guideData.sampleRate, guide.startSec, lengthSec);
    return {
      kind: 'guide',
      channels,
      sampleRate,
      startSec,
      audible,
      guide: { mono, sampleRate: guideData.sampleRate, audible: clampSpan(guide.audible, lengthSec) },
      tightness: plan.edit.tightness,
      pitch: alignPitch(plan.edit),
    };
  }

  /** Writes the render into the edit's own undo step, unless a newer edit has come in (it has its own render coming). */
  private commit(plan: AlignPlan, sample: SampleRef, result: AlignJobResult): void {
    const now = planAlignment(this.s.doc.getState().project, plan.clipId);
    if ('problem' in now || now.plan.signature !== plan.signature) return;
    setAlignStats(plan.clipId, result.stats);
    this.s.history.transact(
      'Alignment rendered',
      (d) => setAlignRender(d, plan.clipId, sample, plan.signature, result.warp),
      this.cursors.has(plan.clipId) ? { amend: this.cursors.get(plan.clipId) as number } : {},
    );
  }

  /** Stops watching and cancels everything pending. */
  stop(): void {
    this.unsubscribe();
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const run of this.runs.values()) run.job?.cancel();
    this.timers.clear();
    this.runs.clear();
    alignState.setState({ rendering: {} });
  }
}

/** The running renderer (see `startAlignRenderer`). */
let active: AlignRenderer | null = null;

/** Starts watching edits; returns the stop function. Created once, at start-up. */
export function startAlignRenderer(s: Services): () => void {
  const renderer = new AlignRenderer(s);
  active = renderer;
  return () => {
    active = null;
    renderer.stop();
  };
}

/** Makes the aligned audio now (the dialog's "Render now" button, after a failed render or a project opened with an old render). */
export function renderAlignmentNow(clipId: ClipId): boolean {
  return active?.schedule(clipId, true) ?? false;
}
