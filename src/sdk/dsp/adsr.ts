// ADSR envelope generator. Allocation-free; usable on any thread.

/** 1/1000 of the way left: decays and releases count as done there (−60 dB). */
const LN_1000 = Math.log(1000);
const IDLE = 0;
const ATTACK = 1;
const DECAY = 2;
const SUSTAIN = 3;
const RELEASE = 4;

/**
 * Attack, decay, sustain, release, one value per `next()` call (0–1). The attack is a straight
 * ramp; decay and release fall exponentially (they reach −60 dB of the distance at their time).
 * Retriggering starts the attack from the current value, so it never clicks. Times in seconds.
 */
export class Adsr {
  value = 0;
  private stage = IDLE;
  private attackStep = 1;
  private decayCoef = 0;
  private releaseCoef = 0;
  private sustainLevel = 1;

  constructor(
    private readonly sampleRate: number,
    attack = 0.005,
    decay = 0.2,
    sustain = 0.7,
    release = 0.3,
  ) {
    this.set(attack, decay, sustain, release);
  }

  set(attack: number, decay: number, sustain: number, release: number): this {
    const sr = this.sampleRate;
    this.attackStep = attack > 0 ? 1 / (attack * sr) : 1;
    this.decayCoef = decay > 0 ? Math.exp(-LN_1000 / (decay * sr)) : 0;
    this.releaseCoef = release > 0 ? Math.exp(-LN_1000 / (release * sr)) : 0;
    this.sustainLevel = Math.min(1, Math.max(0, sustain));
    return this;
  }

  /** Note on: attack (from where it is now). */
  start(): void {
    this.stage = ATTACK;
  }

  /** Note off: release from where it is now. */
  release(): void {
    if (this.stage !== IDLE) this.stage = RELEASE;
  }

  /** True until the release has died away. */
  get active(): boolean {
    return this.stage !== IDLE;
  }

  /** True between start() and release(). */
  get held(): boolean {
    return this.stage === ATTACK || this.stage === DECAY || this.stage === SUSTAIN;
  }

  reset(): void {
    this.stage = IDLE;
    this.value = 0;
  }

  next(): number {
    switch (this.stage) {
      case ATTACK:
        this.value += this.attackStep;
        if (this.value >= 1) {
          this.value = 1;
          this.stage = DECAY;
        }
        break;
      case DECAY:
        this.value = this.sustainLevel + (this.value - this.sustainLevel) * this.decayCoef;
        if (Math.abs(this.value - this.sustainLevel) < 1e-5) {
          this.value = this.sustainLevel;
          this.stage = SUSTAIN;
        }
        break;
      case SUSTAIN:
        this.value = this.sustainLevel;
        break;
      case RELEASE:
        this.value *= this.releaseCoef;
        if (this.value < 1e-5) {
          this.value = 0;
          this.stage = IDLE;
        }
        break;
    }
    return this.value;
  }
}
