import type { OrderedMix } from '@agstudio/sdk';
import { disconnectFrom, frameDelay } from './audio-graph';

/** Crossfade when a padded link changes its delay or target while audio runs (seconds). */
const LINK_FADE_SEC = 0.01;
/** The faded-out path is dropped after this long (ms): a little after the fade is over. */
const LINK_DROP_DELAY_MS = 60;

/** One way through a link: an optional delay line, then a gain, then the target. */
interface Path {
  to: OrderedMix;
  frames: number;
  delay: DelayNode | null;
  gain: GainNode;
  /** Takes the path's gain out of the target's mix. */
  detach: () => void;
}

/**
 * from ─► [DelayNode of `frames` frames] ─► gain ─► to. Changing the delay or the target while a
 * realtime context runs crossfades the old path out over 10 ms (a hard switch would click); before
 * the context starts, and always offline (exports apply everything at time 0; wall-clock timers
 * don't follow offline time), it switches exactly.
 */
export class PadLink {
  private path: Path | null = null;
  /** Paths fading out, dropped by their timer (or on dispose). */
  private readonly fading = new Map<Path, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly from: AudioNode,
    private readonly offline: boolean,
  ) {}

  /** The delay of the current path, in frames (0 without one). */
  get frames(): number {
    return this.path?.frames ?? 0;
  }

  /** The mix the current path ends in, or null when the link goes nowhere. */
  get target(): OrderedMix | null {
    return this.path?.to ?? null;
  }

  /** Points the link at `to` with a delay of `frames` (null: nowhere). Nothing happens if it already does. */
  set(to: OrderedMix | null, frames: number): void {
    const old = this.path;
    if (old?.to === to && (to === null || old?.frames === frames)) return;
    // Crossfade only while audio runs and there is something to fade from.
    const crossfade = !!old && !this.offline && this.ctx.currentTime > 0;
    // A path switched in one step leaves before its replacement arrives: the replacement then takes the very slot the old
    // one had in the target's ordered mix (see OrderedMix). Built first, it would sit one slot further out, and where
    // every link ends up would depend on the order the links were changed in, which follows when each effect finished
    // loading: the mix would add its sources in a different order from one render to the next.
    if (old && !crossfade) {
      this.path = null;
      this.drop(old);
    }
    const next = to ? this.build(to, frames, crossfade ? 0 : 1) : null;
    this.path = next;
    if (old && crossfade) this.fadeOut(old, next);
  }

  dispose(): void {
    for (const [path, timer] of this.fading) {
      clearTimeout(timer);
      this.drop(path);
    }
    this.fading.clear();
    if (this.path) this.drop(this.path);
    this.path = null;
  }

  /** Fades `old` out and `next` in over LINK_FADE_SEC, then drops `old`. */
  private fadeOut(old: Path, next: Path | null): void {
    const now = this.ctx.currentTime;
    old.gain.gain.cancelScheduledValues(now);
    old.gain.gain.setValueAtTime(1, now);
    old.gain.gain.linearRampToValueAtTime(0, now + LINK_FADE_SEC);
    next?.gain.gain.setValueAtTime(0, now);
    next?.gain.gain.linearRampToValueAtTime(1, now + LINK_FADE_SEC);
    const timer = setTimeout(() => {
      this.fading.delete(old);
      this.drop(old);
    }, LINK_DROP_DELAY_MS);
    this.fading.set(old, timer);
  }

  private build(to: OrderedMix, frames: number, gainValue: number): Path {
    const gain = new GainNode(this.ctx, { gain: gainValue });
    let delay: DelayNode | null = null;
    if (frames > 0) {
      delay = frameDelay(this.ctx, frames);
      this.from.connect(delay).connect(gain);
    } else {
      this.from.connect(gain);
    }
    return { to, frames, delay, gain, detach: to.attach(gain) };
  }

  private drop(path: Path): void {
    if (path.delay) {
      disconnectFrom(this.from, path.delay);
      path.delay.disconnect();
    } else {
      disconnectFrom(this.from, path.gain);
    }
    path.detach();
    path.gain.disconnect();
  }
}
