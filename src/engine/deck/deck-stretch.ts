/**
 * The key-lock stretch of a deck: the song at a tempo without changing its pitch, by a streaming WSOLA
 * (waveform-similarity overlap-add). Frames of 2048 samples, Hann-windowed and overlapped by half, are each taken near
 * where the tempo says they should come from, and moved (±448 samples) to where they best continue the frame before,
 * so the pitch holds. Around drum hits the frames are kept exact (see `computeFrame`).
 *
 * Audio-thread code: no allocation after construction. The deck kernel (`deck.kernel.ts`) owns the song and the
 * position; it asks for one frame at a time and plays out the finished hop (`fifoLeft` / `fifoRight`).
 */
import { OnsetScanner, type ReadRange } from './onset-scanner';

// ---- Geometry ----

/** Length of a stretch frame (samples), and the hop between frames (half a frame: they overlap by half). */
export const STRETCH_FRAME_LEN = 2048;
export const STRETCH_HOP_LEN = STRETCH_FRAME_LEN / 2;
/** How far (samples) a frame may move from where the tempo says it comes from, to better continue the frame before. */
const SEARCH_RADIUS = 448;
/** The coarse similarity search looks at every this-many-th sample of a mono mix. */
const SEARCH_DECIMATION = 4;
/** The region of the song a frame's search reads (the frame plus the search radius either side). */
export const STRETCH_REGION_LEN = 2 * SEARCH_RADIUS + STRETCH_FRAME_LEN;
/** The same region, and the half-frame template it is matched against, after decimation. */
const REGION_LEN_DECIMATED = STRETCH_REGION_LEN / SEARCH_DECIMATION;
const TEMPLATE_LEN_DECIMATED = STRETCH_HOP_LEN / SEARCH_DECIMATION;
/** How far from the nominal place a frame's best match may sit before it costs (correlation points per full range). */
const CENTER_BIAS = 0.03;

// Constants of this file: an imported binding is read through the module object (in tests, in some bundles), which made
// the per-sample reads in the kernel 5× slower; the loops below use these local ones.
const FRAME_LEN = STRETCH_FRAME_LEN;
const HOP_LEN = STRETCH_HOP_LEN;
const REGION_LEN = STRETCH_REGION_LEN;

const HANN_WINDOW = new Float32Array(FRAME_LEN);
/** The window of the very first frame: full for its first half (nothing to overlap with), Hann after. */
const FIRST_FRAME_WINDOW = new Float32Array(FRAME_LEN);
for (let j = 0; j < FRAME_LEN; j++) {
  HANN_WINDOW[j] = 0.5 * (1 - Math.cos((2 * Math.PI * j) / FRAME_LEN));
  FIRST_FRAME_WINDOW[j] = j < HOP_LEN ? 1 : (HANN_WINDOW[j] as number);
}

// ---- Transient preservation: what `computeFrame` does with a frame (see `planTransient`) ----

const FRAME_NORMAL = 0;
const FRAME_CONTINUE = 1;
const FRAME_ENTER = 2;
/** The fraction of the lead (how far the heard input is from where the tempo puts it) that still stands after one more frame. */
const LEAD_CARRY = 0.5;
/** The frame that starts a run around an attack may move this far (frames) to continue the one before: 1.3 ms at 48 kHz. */
const ENTRY_SEARCH = 64;
/** A run starts this many output frames before its attack: past the splice that starts it (a hop) and the attack's own lead-in. */
const RUN_LEAD = HOP_LEN + 320;
/** A run goes on until the next splice would begin this far (frames) after the attack: past its body and the search's reach. */
const RUN_TAIL = 930;
/** How far (output frames) a continued run may put an attack from where the tempo wants it: 2 ms at 48 kHz. */
const LANDING_TOLERANCE = 96;
/** An attack this close (output frames) before a stronger one gives way to it (their runs could not both fit). */
const RUN_SPAN = RUN_LEAD + HOP_LEN + RUN_TAIL + HOP_LEN;
/** The most a run's first frame may jump from where the frame before leads on (frames). */
const MAX_ENTRY_JUMP = 1500;
/** Loops shorter than this many frames are too short for a run around an attack to fit, so they use plain WSOLA. */
const MIN_LOOP_FOR_TRANSIENTS = 4 * FRAME_LEN;
/** The stretch only follows tempos between half and double speed (outside it the search region would not cover the frame). */
const MIN_STRETCH_RATE = 0.5;
const MAX_STRETCH_RATE = 2;

/** The WSOLA stretch of one deck. */
export class Stretcher {
  /** Off turns the attack handling off (a test compares with plain WSOLA). */
  transientsOn = true;
  /** The finished hop being played out, and where in it the output is (a hop or more: time for the next frame). */
  readonly fifoLeft = new Float32Array(HOP_LEN);
  readonly fifoRight = new Float32Array(HOP_LEN);
  fifoReadIndex = HOP_LEN;

  /** The overlap-add accumulator: the frame being built (two hops long); its first hop is finished at each frame. */
  private readonly overlapLeft = new Float32Array(FRAME_LEN);
  private readonly overlapRight = new Float32Array(FRAME_LEN);
  private hasPreviousFrame = false;
  /** The song frame the previous stretch frame was taken from. */
  private previousFrameStart = 0;
  /** The region of the song a frame's search reads, and its mono and decimated mono mixes. */
  private readonly regionLeft = new Float32Array(REGION_LEN);
  private readonly regionRight = new Float32Array(REGION_LEN);
  private readonly regionMono = new Float32Array(REGION_LEN);
  private readonly regionMonoDecimated = new Float32Array(REGION_LEN_DECIMATED);
  /** The part of the previous frame still to be heard (what the next frame must continue), as mono and decimated mono. */
  private readonly templateLeft = new Float32Array(HOP_LEN);
  private readonly templateRight = new Float32Array(HOP_LEN);
  private readonly templateMono = new Float32Array(HOP_LEN);
  private readonly templateMonoDecimated = new Float32Array(TEMPLATE_LEN_DECIMATED);

  private readonly onsets: OnsetScanner;
  /** The frame before was exact (the first, or inside a run around an attack): the next may continue it. */
  private previousFrameWasExact = false;
  /** Where the heard input is relative to where the tempo puts it after a run; closes by `LEAD_CARRY` a frame. */
  private leadCarry = 0;
  /** Set by `planTransient`: the song frame a continued or entering frame starts from. */
  private plannedStart = 0;
  /** Set by `planFrame`: where the frame's search may look, as offsets in the region (0…2·SEARCH_RADIUS). */
  private searchLow = 0;
  private searchHigh = 0;

  // What the deck says about itself for the frame being computed.
  private pos = 0;
  /** The loop length in whole frames (0: no loop). */
  private loopFrames = 0;

  /** `readRange` copies frames of the deck's song (zeros outside it) into two arrays. */
  constructor(
    sampleRate: number,
    private readonly readRange: ReadRange,
  ) {
    this.onsets = new OnsetScanner(sampleRate, readRange);
  }

  /** Starts over (a jump, a start, a mode change): the next frame is a first frame, nothing is left to overlap. */
  reset(): void {
    this.fifoReadIndex = HOP_LEN;
    this.hasPreviousFrame = false;
    this.overlapLeft.fill(0);
    this.overlapRight.fill(0);
  }

  /** Forgets the attacks measured so far (the song, or the loop that changes what is read past its end, changed). */
  clearOnsetCache(): void {
    this.onsets.clearCache();
  }

  /** The next `length` samples that will be heard: the finished samples first, then the half-frame still waiting to be overlapped. */
  copyTail(tailLeft: Float32Array, tailRight: Float32Array, length: number): void {
    let k = 0;
    for (let f = this.fifoReadIndex; f < HOP_LEN && k < length; f++, k++) {
      tailLeft[k] = this.fifoLeft[f] as number;
      tailRight[k] = this.fifoRight[f] as number;
    }
    for (let j = 0; k < length; j++, k++) {
      tailLeft[k] = this.overlapLeft[j] as number;
      tailRight[k] = this.overlapRight[j] as number;
    }
  }

  // ---- Planning around attacks ----

  /**
   * Whether the next frame should continue the one before exactly (`FRAME_CONTINUE`: inside a run around an attack),
   * start such a run (`FRAME_ENTER`, placed so the attack lands on time, in `plannedStart`) or be an ordinary WSOLA frame.
   *
   * Everything is in input frames of the nominal lap (a loop's seam is unwrapped around the playhead) and output frames.
   * `leadsOn` is where the previous frame leads on (what a frame that continues it starts at); a run keeps that, and the
   * attack at `c` is then heard `c − leadsOn` frames from now, against the `(c − pos)/rate` the tempo asks for.
   */
  private planTransient(rate: number): number {
    const pos = this.pos;
    let leadsOn = this.previousFrameStart + HOP_LEN;
    if (this.loopFrames > 0) {
      const loopLen = this.loopFrames;
      if (leadsOn - pos > loopLen / 2) leadsOn -= loopLen;
      else if (leadsOn - pos < -loopLen / 2) leadsOn += loopLen;
    }
    const hop = this.onsets.hop;
    this.onsets.scan(
      Math.min(leadsOn, pos) - RUN_TAIL - 2 * hop,
      Math.max(leadsOn, pos) + (RUN_LEAD + HOP_LEN + RUN_SPAN) * rate + 2 * hop,
    );
    if (this.previousFrameWasExact && this.canContinueRun(leadsOn, pos, rate)) {
      this.plannedStart = leadsOn;
      return FRAME_CONTINUE;
    }
    return this.findEntry(leadsOn, pos, rate) ? FRAME_ENTER : FRAME_NORMAL;
  }

  /** Whether the next attack within reach of the run is one the run, kept going, puts on time. */
  private canContinueRun(leadsOn: number, pos: number, rate: number): boolean {
    const count = this.onsets.count;
    const attackFrames = this.onsets.frames;
    for (let i = 0; i < count; i++) {
      const attack = attackFrames[i] as number;
      const heardIn = attack - leadsOn;
      if (heardIn <= -RUN_TAIL) continue;
      if (heardIn >= RUN_LEAD + HOP_LEN) return false;
      return Math.abs(heardIn - (attack - pos) / rate) <= LANDING_TOLERANCE;
    }
    return false;
  }

  /** Looks for an attack that is about to come due, and if one is, plans the frame that starts a run around it (`plannedStart`). */
  private findEntry(leadsOn: number, pos: number, rate: number): boolean {
    const count = this.onsets.count;
    const attackFrames = this.onsets.frames;
    const strengths = this.onsets.strengths;
    for (let i = 0; i < count; i++) {
      const attack = attackFrames[i] as number;
      const dueIn = (attack - pos) / rate;
      if (dueIn < RUN_LEAD) continue;
      if (dueIn >= RUN_LEAD + HOP_LEN) break;
      if (this.isOutdoneByNextAttack(i, rate, attackFrames, strengths)) continue;
      const start = Math.round(attack - dueIn);
      if (Math.abs(start - leadsOn) > MAX_ENTRY_JUMP) continue;
      this.plannedStart = start;
      return true;
    }
    return false;
  }

  /** Whether a stronger attack follows attack `i` closely enough that their runs could not both fit. */
  private isOutdoneByNextAttack(i: number, rate: number, attackFrames: Float64Array, strengths: Float64Array): boolean {
    const count = this.onsets.count;
    const attack = attackFrames[i] as number;
    for (let j = i + 1; j < count; j++) {
      if (((attackFrames[j] as number) - attack) / rate >= RUN_SPAN) return false;
      if ((strengths[j] as number) > (strengths[i] as number)) return true;
    }
    return false;
  }

  // ---- One WSOLA frame ----

  /**
   * One WSOLA frame: picks where in the song it comes from, overlap-adds it and refills the output hop.
   *
   * A frame normally comes from where the tempo says its centre is and moves (±SEARCH_RADIUS) to where it best continues
   * the frame before. That splices the input, and a hit that sits in a splice is smeared or heard twice (two frames
   * carry it at slightly different times), and a hit a splice moved lands early or late. So around each attack
   * (`planTransient`) the frames just continue each other exactly (the input at its own speed, which overlap-adds back
   * to the original samples); the one frame that starts such a run is placed so the attack lands where the tempo puts
   * it, within a millisecond or two, and the stretch it skipped is made up by the frames after the run.
   *
   * `pos` is where the deck is (frames) and `speed` the speed it plays at; `loopFrames` and `loopEndFrame` describe the
   * loop in whole frames (`loopFrames` 0: none).
   */
  computeFrame(pos: number, speed: number, loopFrames: number, loopEndFrame: number): void {
    this.pos = pos;
    this.loopFrames = loopFrames;
    const rate = Math.max(MIN_STRETCH_RATE, Math.min(MAX_STRETCH_RATE, speed));
    const isFirst = !this.hasPreviousFrame;
    const nominalStart = pos + rate * HOP_LEN - HOP_LEN;
    const kind = this.planFrame(isFirst, rate, nominalStart);
    const regionStart = this.plannedStart - SEARCH_RADIUS;
    this.readRange(this.regionLeft, this.regionRight, regionStart, REGION_LEN);
    let offset = SEARCH_RADIUS;
    if (!isFirst && kind !== FRAME_CONTINUE) offset = this.search(this.searchLow, this.searchHigh);
    this.overlapAdd(offset, isFirst ? FIRST_FRAME_WINDOW : HANN_WINDOW);
    this.previousFrameStart = regionStart + offset;
    if (loopFrames > 0 && this.previousFrameStart >= loopEndFrame) this.previousFrameStart -= loopFrames;
    this.hasPreviousFrame = true;
    // A frame that is exact (the first, or part of a run around an attack) lets the next one continue it.
    this.previousFrameWasExact = isFirst || kind !== FRAME_NORMAL;
    if (kind !== FRAME_NORMAL) this.leadCarry = regionStart + offset - nominalStart;
    this.emitFinishedHop();
  }

  /**
   * Decides where the next frame is taken from (`plannedStart`, the song frame at the middle of the search region) and
   * how far its search may look (`searchLow`…`searchHigh`). Returns the kind of frame (see `planTransient`).
   */
  private planFrame(isFirst: boolean, rate: number, nominalStart: number): number {
    this.searchLow = 0;
    this.searchHigh = 2 * SEARCH_RADIUS;
    if (isFirst) {
      this.plannedStart = Math.round(this.pos);
      this.leadCarry = 0;
      return FRAME_NORMAL;
    }
    this.leadCarry *= LEAD_CARRY;
    this.plannedStart = Math.round(nominalStart + this.leadCarry);
    const canPreserveAttacks = this.transientsOn && (this.loopFrames === 0 || this.loopFrames >= MIN_LOOP_FOR_TRANSIENTS);
    if (!canPreserveAttacks) return FRAME_NORMAL;
    const kind = this.planTransient(rate);
    if (kind === FRAME_ENTER) {
      this.searchLow = SEARCH_RADIUS - ENTRY_SEARCH;
      this.searchHigh = SEARCH_RADIUS + ENTRY_SEARCH;
    }
    // `planTransient` set `plannedStart` for a continued or entering frame; a normal one keeps the tempo's place.
    return kind;
  }

  /** Adds the chosen part of the region, windowed, into the overlap accumulator. */
  private overlapAdd(offset: number, window: Float32Array): void {
    const overlapLeft = this.overlapLeft;
    const overlapRight = this.overlapRight;
    const regionLeft = this.regionLeft;
    const regionRight = this.regionRight;
    for (let j = 0; j < FRAME_LEN; j++) {
      const w = window[j] as number;
      overlapLeft[j] = (overlapLeft[j] as number) + w * (regionLeft[offset + j] as number);
      overlapRight[j] = (overlapRight[j] as number) + w * (regionRight[offset + j] as number);
    }
  }

  /** The first hop of the accumulator is finished: it becomes the output, and the second hop moves up to be overlapped next. */
  private emitFinishedHop(): void {
    const overlapLeft = this.overlapLeft;
    const overlapRight = this.overlapRight;
    for (let j = 0; j < HOP_LEN; j++) {
      this.fifoLeft[j] = overlapLeft[j] as number;
      this.fifoRight[j] = overlapRight[j] as number;
    }
    overlapLeft.copyWithin(0, HOP_LEN, FRAME_LEN);
    overlapRight.copyWithin(0, HOP_LEN, FRAME_LEN);
    overlapLeft.fill(0, HOP_LEN, FRAME_LEN);
    overlapRight.fill(0, HOP_LEN, FRAME_LEN);
    this.fifoReadIndex = 0;
  }

  // ---- The similarity search ----

  /**
   * The offset in the region (0…2·SEARCH_RADIUS, SEARCH_RADIUS = the nominal place) whose first half-frame best continues
   * the frame before: normalized cross-correlation with the part of the previous frame that is still to be heard, a
   * coarse pass on a 4× decimated mono mix, then ±4 frames at full rate, with a small cost for moving away from the middle.
   */
  private search(low: number, high: number): number {
    this.readRange(this.templateLeft, this.templateRight, this.previousFrameStart + HOP_LEN, HOP_LEN);
    this.downmixRegionAndTemplate();
    const coarseIndex = this.searchCoarse(low, high);
    return this.searchFine(coarseIndex, low, high);
  }

  /** Mono mixes of the region and of the template, each also decimated by averaging groups of `SEARCH_DECIMATION`. */
  private downmixRegionAndTemplate(): void {
    const regionMono = this.regionMono;
    const regionMonoDecimated = this.regionMonoDecimated;
    const templateMono = this.templateMono;
    const templateMonoDecimated = this.templateMonoDecimated;
    const regionLeft = this.regionLeft;
    const regionRight = this.regionRight;
    for (let i = 0; i < REGION_LEN; i++) regionMono[i] = 0.5 * ((regionLeft[i] as number) + (regionRight[i] as number));
    for (let m = 0; m < REGION_LEN_DECIMATED; m++) {
      const b = m * SEARCH_DECIMATION;
      regionMonoDecimated[m] = 0.25 * ((regionMono[b] as number) + (regionMono[b + 1] as number) + (regionMono[b + 2] as number) + (regionMono[b + 3] as number));
    }
    for (let i = 0; i < HOP_LEN; i++) templateMono[i] = 0.5 * ((this.templateLeft[i] as number) + (this.templateRight[i] as number));
    for (let m = 0; m < TEMPLATE_LEN_DECIMATED; m++) {
      const b = m * SEARCH_DECIMATION;
      templateMonoDecimated[m] = 0.25 * ((templateMono[b] as number) + (templateMono[b + 1] as number) + (templateMono[b + 2] as number) + (templateMono[b + 3] as number));
    }
  }

  /** Coarse pass: candidates every 4 frames across the range (the whole ±radius, or less for a frame that must land on time). Returns the best candidate's index (in decimated frames). */
  private searchCoarse(low: number, high: number): number {
    const region = this.regionMonoDecimated;
    const template = this.templateMonoDecimated;
    let templateEnergy = 1e-9;
    for (let i = 0; i < TEMPLATE_LEN_DECIMATED; i++) templateEnergy += (template[i] as number) * (template[i] as number);
    const firstIndex = Math.ceil(low / SEARCH_DECIMATION);
    const lastIndex = Math.floor(high / SEARCH_DECIMATION);
    // The energy of the region under the template, slid along by adding the sample that enters and dropping the one that leaves.
    let regionEnergy = 1e-9;
    for (let i = 0; i < TEMPLATE_LEN_DECIMATED; i++) regionEnergy += (region[firstIndex + i] as number) * (region[firstIndex + i] as number);
    let bestIndex = Math.round(SEARCH_RADIUS / SEARCH_DECIMATION);
    let bestScore = -Infinity;
    const middle = SEARCH_RADIUS / SEARCH_DECIMATION;
    for (let index = firstIndex; index <= lastIndex; index++) {
      let correlation = 0;
      for (let i = 0; i < TEMPLATE_LEN_DECIMATED; i++) correlation += (template[i] as number) * (region[index + i] as number);
      const score = correlation / Math.sqrt(regionEnergy * templateEnergy) - (CENTER_BIAS * Math.abs(index - middle)) / middle;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
      const leaving = region[index] as number;
      const entering = region[index + TEMPLATE_LEN_DECIMATED] as number;
      regionEnergy += entering * entering - leaving * leaving;
      if (regionEnergy < 1e-9) regionEnergy = 1e-9;
    }
    return bestIndex;
  }

  /** Fine pass: ±`SEARCH_DECIMATION` frames around the coarse winner at full rate. Returns the best offset in the region. */
  private searchFine(coarseIndex: number, low: number, high: number): number {
    const region = this.regionMono;
    const template = this.templateMono;
    let templateEnergy = 1e-9;
    for (let i = 0; i < HOP_LEN; i++) templateEnergy += (template[i] as number) * (template[i] as number);
    let best = coarseIndex * SEARCH_DECIMATION;
    let bestScore = -Infinity;
    const first = Math.max(low, coarseIndex * SEARCH_DECIMATION - SEARCH_DECIMATION);
    const last = Math.min(high, coarseIndex * SEARCH_DECIMATION + SEARCH_DECIMATION);
    for (let offset = first; offset <= last; offset++) {
      let correlation = 0;
      let regionEnergy = 1e-9;
      for (let i = 0; i < HOP_LEN; i++) {
        const v = region[offset + i] as number;
        correlation += (template[i] as number) * v;
        regionEnergy += v * v;
      }
      const score = correlation / Math.sqrt(regionEnergy * templateEnergy) - (CENTER_BIAS * Math.abs(offset - SEARCH_RADIUS)) / SEARCH_RADIUS;
      if (score > bestScore) {
        bestScore = score;
        best = offset;
      }
    }
    return best;
  }
}
