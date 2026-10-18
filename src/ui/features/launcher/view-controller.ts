/**
 * Paints the launcher's live state on the grid without React: each frame the slots get `data-state`
 * (empty / idle / queued / playing / stopping) and, while playing, `--p` (the position in the content, 0–1).
 * When nothing runs and nothing changed it does no work, so idle playback causes no React commits and no DOM writes.
 */
import type { Services } from '@app/services';
import { runProgress } from '@core/launcher/run';
import type { LaunchTrackId, SceneId } from '@core/model/types';
import { onFrame } from '../../frame-loop';

interface Cell {
  el: HTMLElement;
  trackId: LaunchTrackId | null;
  sceneId: SceneId | null;
  /** What was written last: the state, and for a playing slot its position. */
  last: string;
  state: string;
}

export class LauncherView {
  private cells: Cell[] = [];
  private scenes: { el: HTMLElement; sceneId: SceneId; last: string }[] = [];
  private stops: { el: HTMLElement; trackId: LaunchTrackId; last: string }[] = [];
  private seen: unknown = null;
  private dirty = true;
  private stop: (() => void) | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly services: Services,
  ) {}

  start(): void {
    this.stop = onFrame(() => this.frame());
  }

  dispose(): void {
    this.stop?.();
    this.stop = null;
  }

  /** The grid was rendered again (slots added, removed or changed): look at the cells anew. */
  refresh(): void {
    const q = <T extends HTMLElement>(sel: string) => [...this.root.querySelectorAll<T>(sel)];
    this.cells = q('[data-slot]').map((el) => ({
      el,
      trackId: (el.dataset.trackId as LaunchTrackId | undefined) ?? null,
      sceneId: (el.dataset.sceneId as SceneId | undefined) ?? null,
      last: '',
      state: '',
    }));
    this.scenes = q('[data-scene-btn]').map((el) => ({ el, sceneId: el.dataset.sceneBtn as SceneId, last: '' }));
    this.stops = q('[data-stop-btn]').map((el) => ({ el, trackId: el.dataset.stopBtn as LaunchTrackId, last: '' }));
    this.dirty = true;
  }

  private frame(): void {
    const session = this.services.launcher;
    const runs = session.seq.runs;
    if (runs === this.seen && runs.length === 0 && !this.dirty) return;
    this.dirty = false;
    this.seen = runs;
    const heardU = runs.length ? session.clock().heardU : 0;
    const trackPlaying = new Set<string>();
    const scenePlaying = new Map<string, { playing: number; queued: number; total: number }>();
    for (const c of this.cells) {
      let state = 'empty';
      let p = 0;
      if (c.trackId && c.sceneId) {
        const r = session.stateOf(c.trackId, c.sceneId, heardU);
        state = r.state;
        if (r.state === 'playing' && r.run) p = runProgress(r.run, heardU);
        if (r.state === 'playing' || r.state === 'stopping') trackPlaying.add(c.trackId);
        if (r.state !== 'empty') {
          const e = scenePlaying.get(c.sceneId) ?? { playing: 0, queued: 0, total: 0 };
          e.total++;
          if (r.state === 'playing') e.playing++;
          if (r.state === 'queued') e.queued++;
          scenePlaying.set(c.sceneId, e);
        }
      }
      const key = state === 'playing' ? `${state}|${p.toFixed(3)}` : state;
      if (key === c.last) continue;
      c.last = key;
      // Only a change of state is a write to the DOM's attributes; a playing slot's position is a style property.
      if (state !== c.state) {
        c.state = state;
        c.el.dataset.state = state;
      }
      if (state === 'playing') c.el.style.setProperty('--p', p.toFixed(3));
      else c.el.style.removeProperty('--p');
    }
    for (const s of this.scenes) {
      const e = scenePlaying.get(s.sceneId);
      const state = !e ? 'idle' : e.queued > 0 ? 'queued' : e.playing === e.total ? 'playing' : 'idle';
      if (state === s.last) continue;
      s.last = state;
      s.el.dataset.state = state;
    }
    for (const s of this.stops) {
      const state = trackPlaying.has(s.trackId) ? 'playing' : 'idle';
      if (state === s.last) continue;
      s.last = state;
      s.el.dataset.state = state;
    }
  }
}
