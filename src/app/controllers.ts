/**
 * "Link to controller" (MIDI learn): links in the project map a MIDI control change to a target.
 * A moving controller writes the target through History (one merged undo step per turn of the knob)
 * and touches it, so automation lets go while you play it.
 */
import { resolveTarget } from '@core/automation/targets';
import { newId } from '@core/model/ids';
import { sameTarget, targetKey } from '@core/model/targets';
import type { ControllerLink, LinkId, ParamTarget } from '@core/model/types';
import { setTargetValue } from '@core/ops/targets';
import { decode, type ParamSpecs } from '@agstudio/sdk';
import type { LiveEvent } from './live-input';
import type { Services } from './services';

/** Controllers that are never learned: sustain pedal, bank select, channel-mode messages. */
const IGNORED = new Set([0, 32, 64, 120, 121, 122, 123, 124, 125, 126, 127]);
const TOUCH_MS = 250;

export class ControllerRouter {
  private learning: { target: ParamTarget; done(link: ControllerLink | null): void } | null = null;
  private readonly touches = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly s: Services) {
    s.live.subscribe((e) => this.onLive(e));
  }

  /** The links that drive a target. */
  linksFor(target: ParamTarget): ControllerLink[] {
    return Object.values(this.s.doc.getState().project.controllers).filter((l) => sameTarget(l.target, target));
  }

  get learningTarget(): ParamTarget | null {
    return this.learning?.target ?? null;
  }

  /** Waits for the next controller move and links it to `target` (resolves null if cancelled). */
  learn(target: ParamTarget): Promise<ControllerLink | null> {
    this.cancelLearn();
    return new Promise((done) => {
      this.learning = { target, done };
    });
  }

  cancelLearn(): void {
    const l = this.learning;
    this.learning = null;
    l?.done(null);
  }

  unlink(target: ParamTarget): void {
    const ids = this.linksFor(target).map((l) => l.id);
    if (!ids.length) return;
    this.s.history.transact('Unlink controller', (d) => {
      for (const id of ids) delete d.controllers[id];
    });
  }

  private onLive(e: LiveEvent): void {
    if (e.type !== 'cc' || IGNORED.has(e.cc)) return;
    if (this.learning) {
      const { target, done } = this.learning;
      this.learning = null;
      const link: ControllerLink = {
        id: newId.link() as LinkId,
        cc: e.cc,
        channel: e.midiChannel ?? null,
        ...(e.device ? { device: e.device } : {}),
        target,
        min: 0,
        max: 1,
      };
      this.s.history.transact('Link controller', (d) => {
        // One controller drives one thing: drop older links of this target and of this controller.
        for (const [id, l] of Object.entries(d.controllers))
          if (
            sameTarget(l.target, target) ||
            (l.cc === link.cc && (l.channel ?? -1) === (link.channel ?? -1) && (l.device ?? '') === (link.device ?? ''))
          )
            delete d.controllers[id as LinkId];
        d.controllers[link.id] = link;
      });
      done(link);
      return;
    }
    const project = this.s.doc.getState().project;
    for (const link of Object.values(project.controllers)) {
      if (link.cc !== e.cc) continue;
      if (link.channel !== null && e.midiChannel !== undefined && link.channel !== e.midiChannel) continue;
      if (link.device && e.device && link.device !== e.device) continue;
      this.drive(link, e.value);
    }
  }

  private drive(link: ControllerLink, value: number): void {
    const project = this.s.doc.getState().project;
    const specsOf = (id: string) => this.s.plugins.get(id)?.params as ParamSpecs | undefined;
    const resolved = resolveTarget(project, link.target, specsOf);
    if (!resolved) return;
    const n = link.min + value * (link.max - link.min);
    const numeric = resolved.fromNormalized(n);
    const plain = link.target.kind === 'plugin' ? decode(resolved.spec, numeric) : numeric;
    const key = targetKey(link.target);
    this.touch(key);
    this.s.history.transact('Controller', (d) => setTargetValue(d, link.target, plain), { mergeKey: `cc:${link.id}` });
  }

  /** Automation lets go of the target while the controller moves, and takes over again after. */
  private touch(key: string): void {
    const t = this.touches.get(key);
    if (t) clearTimeout(t);
    else this.s.engine.touch(key, true);
    this.touches.set(
      key,
      setTimeout(() => {
        this.touches.delete(key);
        this.s.engine.touch(key, false);
      }, TOUCH_MS),
    );
  }
}
