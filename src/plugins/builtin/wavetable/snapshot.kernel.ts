import { at, type ParamBlock } from '@agstudio/sdk/worklet';
import { lfoParam, MOD_SLOTS, modParam, oscParam, type wavetableParams } from './params';
import { MAX_UNISON } from './voice.kernel';

type Params = typeof wavetableParams;

/** The param ids of the parts that come in numbered copies, built once. */
export const OSC_IDS = [oscParam(1), oscParam(2)] as const;
export const LFO_IDS = [lfoParam(1), lfoParam(2)] as const;
export const MOD_IDS = Array.from({ length: MOD_SLOTS }, (_, i) => modParam(i + 1));

/** Where unison copy `copy` sits across the spread: -1 (first copy) to +1 (last copy), 0 for a single copy. */
function unisonSpreadPosition(copy: number, unison: number): number {
  return unison > 1 ? (2 * copy) / (unison - 1) - 1 : 0;
}

/** An oscillator's params at one control step. */
export class OscillatorParams {
  level = 0;
  coarse = 0;
  fine = 0;
  table = 0;
  pan = 0;
  position = 0;
  /** Per-unison-copy levels (left, right), cached while level, pan, spread and unison stay put. */
  readonly gainLeft = new Float64Array(MAX_UNISON);
  readonly gainRight = new Float64Array(MAX_UNISON);
  cachedLevel = NaN;
  cachedPan = NaN;
  cachedSpread = NaN;
  cachedUnison = NaN;
}

/** An LFO's params at one control step. */
export class LfoParams {
  shape = 0;
  isSynced = false;
  length = 0;
  rate = 1;
}

/**
 * The params a control step reads, taken once and shared by every voice that controls at the same
 * frame: all of them when no param is automated (the common case), else the voices that step on the
 * same frame. Looking a param up by name is a hash lookup and a voice does dozens of them per step.
 */
export class ParamSnapshot {
  unison = 1;
  detune = 0;
  spread = 0;
  subLevel = 0;
  subShape = 0;
  subOctave = 0;
  noiseLevel = 0;
  noiseTone = 0;
  filterType = 0;
  envAmount = 0;
  keyTrack = 0;
  cutoff = 0;
  resonance = 0;
  drive = 0;
  velocity = 0;
  readonly osc = [new OscillatorParams(), new OscillatorParams()];
  readonly lfo = [new LfoParams(), new LfoParams()];
  readonly modSource = new Int32Array(MOD_SLOTS);
  readonly modTarget = new Int32Array(MOD_SLOTS);
  readonly modAmount = new Float64Array(MOD_SLOTS);
  /** 2^(detune · position / 1200) for each unison copy, cached while detune and unison stay put. */
  readonly detuneRatio = new Float64Array(MAX_UNISON);
  private cachedDetune = NaN;
  private cachedUnison = NaN;
  /** The block and frame being read: set by `read`, used by `value`. */
  private block: ParamBlock<Params> | null = null;
  private frame = 0;

  /** Reads every param at frame `frame` of `block`. */
  read(block: ParamBlock<Params>, frame: number): void {
    this.block = block;
    this.frame = frame;
    const unison = Math.max(1, Math.min(MAX_UNISON, Math.round(this.value('unison'))));
    this.detune = this.value('detune');
    this.spread = this.value('spread');
    this.updateDetuneRatios(unison);
    this.unison = unison;
    this.subLevel = this.value('subLevel');
    this.subShape = Math.round(this.value('subShape'));
    this.subOctave = this.value('subOctave');
    this.noiseLevel = this.value('noiseLevel');
    this.noiseTone = this.value('noiseTone');
    this.filterType = Math.round(this.value('filterType'));
    this.envAmount = this.value('envAmount');
    this.keyTrack = this.value('keyTrack');
    this.cutoff = this.value('cutoff');
    this.resonance = this.value('resonance');
    this.drive = this.value('drive');
    this.velocity = this.value('velocity');
    for (let which = 0; which < 2; which++) this.readOscillator(which, unison);
    for (let which = 0; which < 2; which++) this.readLfo(which);
    this.readModMatrix();
  }

  private value(id: string): number {
    return at((this.block as ParamBlock<Params>)[id] as Float32Array, this.frame);
  }

  /** The detune ratio of each unison copy: copies fan out from -detune to +detune cents. */
  private updateDetuneRatios(unison: number): void {
    if (this.cachedDetune === this.detune && this.cachedUnison === unison) return;
    this.cachedDetune = this.detune;
    this.cachedUnison = unison;
    for (let copy = 0; copy < unison; copy++) {
      const spreadPosition = unisonSpreadPosition(copy, unison);
      this.detuneRatio[copy] = Math.pow(2, (this.detune * spreadPosition) / 1200);
    }
  }

  private readOscillator(which: number, unison: number): void {
    const osc = this.osc[which] as OscillatorParams;
    const ids = OSC_IDS[which as 0 | 1];
    osc.level = this.value(ids.level);
    osc.coarse = this.value(ids.coarse);
    osc.fine = this.value(ids.fine);
    osc.table = this.value(ids.table);
    osc.pan = this.value(ids.pan);
    osc.position = this.value(ids.position);
    this.updateUnisonGains(osc, unison);
  }

  /**
   * Each unison copy's left and right gain: the level shared out so the sum keeps its loudness (1/sqrt of
   * the copy count), panned by the oscillator's pan plus the copy's place in the stereo spread.
   */
  private updateUnisonGains(osc: OscillatorParams, unison: number): void {
    const unchanged =
      osc.cachedLevel === osc.level &&
      osc.cachedPan === osc.pan &&
      osc.cachedSpread === this.spread &&
      osc.cachedUnison === unison;
    if (unchanged) return;
    osc.cachedLevel = osc.level;
    osc.cachedPan = osc.pan;
    osc.cachedSpread = this.spread;
    osc.cachedUnison = unison;
    const loudnessShare = 1 / Math.sqrt(unison);
    for (let copy = 0; copy < unison; copy++) {
      const spreadPosition = unisonSpreadPosition(copy, unison);
      const pan = Math.max(-1, Math.min(1, osc.pan + this.spread * spreadPosition));
      // Equal-power pan law.
      osc.gainLeft[copy] = osc.level * loudnessShare * Math.sqrt(0.5 * (1 - pan));
      osc.gainRight[copy] = osc.level * loudnessShare * Math.sqrt(0.5 * (1 + pan));
    }
  }

  private readLfo(which: number): void {
    const lfo = this.lfo[which] as LfoParams;
    const ids = LFO_IDS[which as 0 | 1];
    lfo.shape = Math.round(this.value(ids.shape));
    lfo.isSynced = this.value(ids.sync) >= 0.5;
    lfo.length = Math.round(this.value(ids.length));
    lfo.rate = this.value(ids.rate);
  }

  private readModMatrix(): void {
    for (let slot = 0; slot < MOD_SLOTS; slot++) {
      const ids = MOD_IDS[slot] as ReturnType<typeof modParam>;
      this.modSource[slot] = Math.round(this.value(ids.source));
      this.modTarget[slot] = Math.round(this.value(ids.target));
      this.modAmount[slot] = this.value(ids.amount);
    }
  }
}
