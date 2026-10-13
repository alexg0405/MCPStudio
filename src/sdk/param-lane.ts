/**
 * An AudioParam whose scheduled automation can be cut and rewound at any time (for plugins that
 * schedule their own per-voice curves, like the 808's glides: `new ParamLane(osc.frequency, f0)`).
 *
 * Plain Web Audio offers cancelAndHoldAtTime(), but this voice often schedules two changes at the
 * same instant (a release and a retrigger's choke when notes touch), and a cancel at a time that
 * already has events keeps those events. So the lane models its own curve (the segments it
 * scheduled) and cuts with cancelScheduledValues() plus an anchor at the value the curve has at the
 * cut: a ramp that was running is ended there (as cancelAndHoldAtTime would), anything else holds.
 * The curve never jumps, and the same segments always produce the same events, so a rewound and
 * rescheduled voice sounds like one that was scheduled in order.
 */

type Kind = 'hold' | 'lin' | 'exp' | 'target';

interface Segment {
  kind: Kind;
  /** Start time (context seconds). */
  t: number;
  /** Value at `t`. */
  v0: number;
  /** End value of a ramp, target of 'target', value of 'hold'. */
  v: number;
  /** End time of a ramp. */
  end: number;
  /** Time constant of 'target'. */
  tau: number;
}

function valueOf(s: Segment, t: number): number {
  switch (s.kind) {
    case 'hold':
      return s.v;
    case 'lin':
      return t >= s.end ? s.v : s.v0 + (s.v - s.v0) * ((t - s.t) / (s.end - s.t));
    case 'exp':
      return t >= s.end ? s.v : s.v0 * Math.pow(s.v / s.v0, (t - s.t) / (s.end - s.t));
    case 'target':
      return s.v + (s.v0 - s.v) * Math.exp(-(t - s.t) / s.tau);
  }
}

const isRamp = (s: Segment) => s.kind === 'lin' || s.kind === 'exp';

export class ParamLane {
  private segs: Segment[] = [];
  /** Time of the latest event scheduled on the param (-Infinity: none). */
  private until = -Infinity;

  constructor(
    private readonly param: AudioParam,
    /** The param's value before any automation (its intrinsic value at creation). */
    private readonly initial: number,
  ) {}

  /** Jumps to `from` at `t`, then ramps linearly to `v` at `end`. */
  jumpRamp(t: number, from: number, v: number, end: number): void {
    this.push({ kind: 'lin', t, v0: from, v, end, tau: 0 }, true);
  }

  /** Ramps from the current value at `t` to `v` at `end` (exponential: constant ratio per second). */
  rampTo(t: number, v: number, end: number, exponential = false): void {
    const kind = exponential ? 'exp' : 'lin';
    this.push({ kind, t, v0: this.valueBefore(t), v, end: Math.max(end, t + 1e-6), tau: 0 }, false);
  }

  /** Jumps to `from` at `t`, then approaches `v` with time constant `tau`. */
  jumpTarget(t: number, from: number, v: number, tau: number): void {
    this.push({ kind: 'target', t, v0: from, v, end: t, tau }, true);
  }

  /** Approaches `v` from the current value at `t` with time constant `tau`. */
  targetTo(t: number, v: number, tau: number): void {
    this.push({ kind: 'target', t, v0: this.valueBefore(t), v, end: t, tau }, false);
  }

  /** Forgets everything scheduled from `t` on and lets the curve that was running at `t` go on. */
  rewind(t: number): void {
    if (this.until < t) return;
    const last = this.cut(t);
    if (!last) return;
    if (isRamp(last) && last.end > t) this.ramp(last.kind, last.v, last.end);
    else if (last.kind === 'target') this.param.setTargetAtTime(last.v, t, last.tau);
  }

  /** The value the curve has at `t` if everything from `t` on is replaced. */
  private valueBefore(t: number): number {
    for (let i = this.segs.length - 1; i >= 0; i--) {
      const s = this.segs[i] as Segment;
      if (s.t < t) return valueOf(s, t);
    }
    return this.initial;
  }

  private push(seg: Segment, jump: boolean): void {
    this.cut(seg.t);
    if (jump) this.param.setValueAtTime(seg.v0, seg.t);
    if (isRamp(seg)) this.ramp(seg.kind, seg.v, seg.end);
    else if (seg.kind === 'target') this.param.setTargetAtTime(seg.v, seg.t, seg.tau);
    this.segs.push(seg);
  }

  /**
   * Removes every segment and event from `t` on and anchors the value the curve has there. Returns
   * the segment still running at `t`.
   */
  private cut(t: number): Segment | undefined {
    while (this.segs.length > 0 && (this.segs[this.segs.length - 1] as Segment).t >= t) this.segs.pop();
    const last = this.segs[this.segs.length - 1];
    const v = last ? valueOf(last, t) : this.initial;
    this.param.cancelScheduledValues(t);
    // cancelScheduledValues removed the end event of a ramp still running at t: end it at t instead.
    if (last && isRamp(last) && last.end >= t) this.ramp(last.kind, v, t);
    else this.param.setValueAtTime(v, t);
    this.until = t;
    return last;
  }

  private ramp(kind: Kind, v: number, end: number): void {
    if (kind === 'exp') this.param.exponentialRampToValueAtTime(v, end);
    else this.param.linearRampToValueAtTime(v, end);
    this.until = Math.max(this.until, end);
  }
}
