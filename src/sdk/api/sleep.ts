/**
 * Sleeping plugins. An instrument with no voices left, or an effect with silence at its input and no tail left, makes
 * no sound until something reaches it. A plugin that says so lets the host stop processing it (and the mixer chain it
 * sits in) until its next note or sound, so a project with hundreds of idle plugins costs the audio thread only what
 * is actually playing.
 */

/**
 * What a plugin instance reports about being idle (`InstrumentInstance.sleep`, `EffectInstance.sleep`,
 * `WorkletPort.sleep`).
 *
 * The promise a plugin makes while `asleep` is true:
 * - its output is silent now, and stays silent until the host sends it something: a note on or a controller (an
 *   instrument), or a state change, sample or message (either kind); for an effect also sound at its input;
 * - it has no tail left (a reverb that is still ringing, a delay with echoes to come, a synth voice in its release
 *   are not asleep).
 *
 * What the host may do meanwhile: stop calling the plugin's audio code altogether, and drop what would have no effect
 * on a plugin with nothing sounding (a note off, an all-notes-off), or hold it back and replay it on waking (tempo
 * and param changes). A plugin with a `process()` of its own must therefore not need to run to stay correct: no
 * clock that has to keep ticking, and it must accept events whose time has passed. The host wakes a plugin before
 * anything it sends is due (a scheduled note: the moment it is handed over, which is at least a lookahead early).
 *
 * `asleep` may flip back to false at any moment (the plugin got an event); report it when it happens.
 */
export interface Sleeper {
  /** True while the plugin is idle in the sense above. A plugin starts awake. */
  readonly asleep: boolean;
  /** Called every time `asleep` changes. Returns the function that stops listening. */
  onChange(listener: (asleep: boolean) => void): () => void;
}

/**
 * A ready-made `Sleeper` for plugins that decide for themselves when they are idle (graph plugins: no voices alive,
 * no tail left). Call `set(true)` when idle and `set(false)` as soon as anything can sound again (at the start of
 * `noteOn`, before anything is scheduled).
 */
export class SleepSignal implements Sleeper {
  private isAsleep = false;
  private readonly listeners = new Set<(asleep: boolean) => void>();

  get asleep(): boolean {
    return this.isAsleep;
  }

  /** Sets the state; listeners hear of a change only. */
  set(asleep: boolean): void {
    if (asleep === this.isAsleep) return;
    this.isAsleep = asleep;
    for (const listener of [...this.listeners]) listener(asleep);
  }

  onChange(listener: (asleep: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
