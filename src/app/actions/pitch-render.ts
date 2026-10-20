/**
 * The renderer that keeps pitch-corrected audio up to date (see `pitch.ts` for the edits). After an edit
 * (not undo, redo or load) that leaves a clip's render out of date, the corrected audio is made after a
 * short pause and written into the same undo step as the edit.
 *
 * The corrected audio is a new sample: TD-PSOLA in a Worker over the stretch of the clip's sample that the
 * edits touch, spliced into a copy of the whole sample (so trims, fades and tempo follow keep working),
 * stored as 24-bit FLAC through the sample store, and listed in `Project.samples`.
 */
import { clipSourceSampleId } from '@core/audio/playback';
import { editSignature, isNeutralEdit, renderRange } from '@core/audio/pitch-edit';
import type { ClipId, PitchEdit, Project, SampleId, SampleRef } from '@core/model/types';
import { setPitchRender } from '@core/ops/pitch';
import type { SampleData } from '@engine/api';
import { encodeOffThread } from '../export/encode';
import { importSampleBytes } from '../persistence/sample-import';
import { PitchJobCancelled, renderInWorker, type RunningPitchJob } from '../pitch/pitch-jobs';
import { pitchState } from '../pitch/state';
import type { Services } from '../services';
import { whileBusy } from '../storage/busy';
import { audioClipOf, PitchError } from './pitch-clip';

/** How long after the last edit the render starts, ms. */
export const RENDER_DELAY_MS = 450;

/** The progress shown once the Worker is done: storing the file is what is left. */
const PROGRESS_AFTER_RENDER = 0.97;

/** One render in flight (or waiting for its pause to end) for a clip. */
interface RenderRun {
  /** The edit it renders (`editSignature`): a newer edit makes this run stale. */
  signature: string;
  /** The sample it reads: the clip's cleanup render, else the channel's own (a new cleanup render makes this run stale too). */
  source: SampleId;
  job: RunningPitchJob<Float32Array[]> | null;
}

/** A clip's current edit and its signature. */
interface SignedEdit {
  edit: PitchEdit;
  signature: string;
  /** The sample the render reads (see `clipSourceSampleId`). */
  source: SampleId;
}

/** The part of a sample the edits touch, as frames [startFrame, endFrame) of every channel. */
interface Region {
  startFrame: number;
  endFrame: number;
  channels: Float32Array[];
}

/** Cuts the frames of `data` that the render range covers. */
function regionOf(data: SampleData, range: { from: number; to: number }): Region {
  const startFrame = Math.max(0, Math.floor(range.from * data.sampleRate));
  const endFrame = Math.min(data.channels[0]?.length ?? 0, Math.ceil(range.to * data.sampleRate));
  return { startFrame, endFrame, channels: data.channels.map((c) => c.slice(startFrame, endFrame)) };
}

/**
 * The whole sample with the rendered part spliced in at `startFrame`. When the rendered part peaks above full
 * scale, that part is scaled down to 1 so the correction does not clip.
 */
export function spliceRendered(
  channels: readonly Float32Array[],
  rendered: readonly Float32Array[],
  startFrame: number,
  endFrame: number,
): Float32Array[] {
  const full = channels.map((c) => Float32Array.from(c));
  let peak = 0;
  rendered.forEach((part, c) => {
    (full[c] as Float32Array).set(part, startFrame);
    for (let i = 0; i < part.length; i++) peak = Math.max(peak, Math.abs(part[i] as number));
  });
  if (peak > 1) for (const c of full) for (let i = startFrame; i < endFrame; i++) c[i] = (c[i] as number) / peak;
  return full;
}

/** Watches the document's edits and renders pitch-corrected audio for the clips they leave out of date. */
class PitchRenderer {
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
        if (clip?.kind !== 'audio' || !clip.pitchEdit) continue;
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

  /** The clip's pitch edit as it is now, with its signature (null when it has none). */
  private currentEdit(id: ClipId): SignedEdit | null {
    const found = audioClipOf(this.s.doc.getState().project, id);
    const edit = found?.clip.pitchEdit;
    if (!edit) return null;
    return { edit, signature: editSignature(edit), source: clipSourceSampleId(found.channel, found.clip, 'pitch') };
  }

  /**
   * Starts (or restarts) the pause before a render, unless the clip needs none: no edit, a neutral edit, or a
   * render that is already current or already waiting. `force` renders even then.
   */
  schedule(id: ClipId, force = false): void {
    const waiting = this.timers.get(id);
    if (waiting) clearTimeout(waiting);
    this.timers.delete(id);
    const current = this.currentEdit(id);
    const run = this.runs.get(id);
    // Nothing to correct any more (a neutral edit): the clip plays its own audio, setPitchEdit already dropped the render.
    if (!current || isNeutralEdit(current.edit)) {
      run?.job?.cancel();
      this.runs.delete(id);
      return;
    }
    if (!force && current.edit.renderedFor === current.signature && current.edit.renderedSampleId) return;
    if (!force && run && run.signature === current.signature && run.source === current.source) return;
    run?.job?.cancel();
    this.runs.set(id, { signature: current.signature, source: current.source, job: null });
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        void this.render(id, current.signature, current.source);
      }, RENDER_DELAY_MS),
    );
  }

  /** Renders the edit with this signature, if it is still the clip's edit, and shows progress and failures. */
  private async render(id: ClipId, signature: string, source: SampleId): Promise<void> {
    const run = this.runs.get(id);
    if (!run || run.signature !== signature || run.source !== source) return;
    const project = this.s.doc.getState().project;
    const found = audioClipOf(project, id);
    const edit = found?.clip.pitchEdit;
    if (!found || !edit || editSignature(edit) !== signature || clipSourceSampleId(found.channel, found.clip, 'pitch') !== source) return;
    const progress = (fraction: number) => pitchState.setState({ rendering: { clipId: id, fraction } });
    try {
      progress(0);
      await whileBusy(() => this.renderAndStore(run, id, signature, source, found.channel.name, edit, project, progress), { project });
    } catch (e) {
      if (!(e instanceof PitchJobCancelled)) {
        this.s.session.getState().toast(`Pitch correction could not be rendered: ${e instanceof Error ? e.message : String(e)}`, 'error');
      }
    } finally {
      if (this.runs.get(id) === run) this.runs.delete(id);
      if (pitchState.getState().rendering?.clipId === id) pitchState.setState({ rendering: null });
    }
  }

  /** Makes the corrected audio, stores it and writes it into the edit's undo step. */
  private async renderAndStore(
    run: RenderRun,
    id: ClipId,
    signature: string,
    sampleId: SampleId,
    clipName: string,
    edit: PitchEdit,
    project: Project,
    progress: (fraction: number) => void,
  ): Promise<void> {
    const ref = project.samples[sampleId];
    if (!ref) throw new PitchError('This clip’s audio is missing.');
    const data = await this.s.engine.sampleData(ref);
    if (!data) throw new PitchError('This clip’s audio could not be read.');
    const range = renderRange(edit, data.duration);
    if (!range) return;
    const region = regionOf(data, range);
    const rendered = await this.renderRegion(run, id, region, data.sampleRate, edit, progress);
    if (!rendered) return;
    const full = spliceRendered(data.channels, rendered, region.startFrame, region.endFrame);
    progress(PROGRESS_AFTER_RENDER);
    const bytes = await encodeOffThread(full, data.sampleRate, { codec: 'flac', bits: 24, kbps: 0 });
    const stored = await importSampleBytes(bytes, `${clipName} (pitch corrected).flac`);
    const sample: SampleRef = { ...stored, durationSec: data.duration, sampleRate: data.sampleRate, channels: full.length };
    this.commitRender(id, signature, sampleId, sample);
  }

  /** Runs the correction in a Worker over the region. Null when a newer run replaced this one meanwhile. */
  private async renderRegion(
    run: RenderRun,
    id: ClipId,
    region: Region,
    sampleRate: number,
    edit: PitchEdit,
    progress: (fraction: number) => void,
  ): Promise<Float32Array[] | null> {
    const transition = edit.transition !== undefined ? { transition: edit.transition } : {};
    const job = renderInWorker(region.channels, sampleRate, region.startFrame / sampleRate, { notes: edit.notes, ...transition }, progress);
    run.job = job;
    const rendered = await job.result;
    run.job = null;
    return this.runs.get(id) === run ? rendered : null;
  }

  /** Writes the render into the edit's own undo step, unless a newer edit has come in (it has its own render coming). */
  private commitRender(id: ClipId, signature: string, source: SampleId, sample: SampleRef): void {
    const now = this.currentEdit(id);
    if (!now || now.signature !== signature || now.source !== source) return;
    this.s.history.transact(
      'Pitch correction rendered',
      (d) => setPitchRender(d, id, sample, signature),
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

/** The running renderer (see `startPitchRenderer`). */
let active: PitchRenderer | null = null;

/**
 * Starts watching edits: after an edit (not undo, redo or load) that leaves a clip's render out of
 * date, the corrected audio is made after a short pause and written into the same undo step.
 * Returns the stop function. Created once, at start-up.
 */
export function startPitchRenderer(s: Services): () => void {
  const renderer = new PitchRenderer(s);
  active = renderer;
  return () => {
    active = null;
    renderer.stop();
  };
}

/** Makes the corrected audio now (the editor's "Render now" button, after a failed render). */
export function renderNow(clipId: ClipId): void {
  active?.schedule(clipId, true);
}
