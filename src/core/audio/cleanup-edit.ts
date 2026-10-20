/**
 * What a clip's vocal cleanup (`AudioClip.cleanup`) means: the defaults, whether it changes anything, the signature
 * that tells a stale render, and how the AI's `clean_vocal` arguments turn into settings. Pure functions of plain
 * data (no DOM, no globals), so the window, the AI, the Worker and the tests agree. The render itself is in
 * `cleanup/render.ts`.
 *
 * Processing order of a clip's sound: the channel's own sample, then **cleanup**, then the **pitch edit** (the Pitch
 * editor), then the clip's gain and fades. Cleanup comes first because the pitch shifter would otherwise carry the
 * noise, breaths and clicks along with the voice (a shifted hiss repeats grains and gets a rhythm of its own), and
 * because a pitch tracker follows a clean voice more reliably. The pitch editor still analyses the clip's original
 * recording (cleanup keeps the length and timeline, so its notes stay where they are) but renders from the cleaned
 * sound; see `clipEditChain` in `playback.ts`.
 */
import type { BreathSpan, SampleId, VocalCleanup } from '../model/types';
import { BREATH_REMOVE_DB } from './cleanup/breaths';
import { DENOISE_MAX_DB } from './cleanup/spectral-denoise';

/** The settings a section starts with when it is switched on. */
export const DEFAULT_NOISE = { amountDb: 12, sensitivity: 0.5 } as const;
export const DEFAULT_BREATHS = { reduceDb: 12, sensitivity: 0.5 } as const;
export const DEFAULT_CLICKS = { sensitivity: 0.5 } as const;

/** The largest reduction the breath control takes before it removes the breath (dB). */
export { BREATH_REMOVE_DB, DENOISE_MAX_DB };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

/** True when the settings change nothing (no section does anything), so the clip plays its own sound. */
export function isNeutralCleanup(c: VocalCleanup): boolean {
  return !(c.noise && c.noise.amountDb > 0) && !(c.breaths && c.breaths.reduceDb > 0) && !c.clicks;
}

/** The breaths that will be turned down (not switched off), in time order. */
export function activeBreaths(c: VocalCleanup): BreathSpan[] {
  return (c.breaths?.spans ?? []).filter((b) => !b.off);
}

/**
 * A short string that changes whenever something the render depends on changes, to tell a stale render. Numbers are
 * rounded to what they can mean. A section whose findings are not made yet (the quiet stretch, the breaths) reads
 * as "to find": the render finds them and the signature then changes with them, which is why a render's
 * `renderedFor` is the signature of the settings *with* the findings.
 */
export function cleanupSignature(c: VocalCleanup): string {
  const parts: string[] = [];
  if (c.noise && c.noise.amountDb > 0) {
    const where = c.noise.from !== undefined && c.noise.to !== undefined ? `${round(c.noise.from, 3)}-${round(c.noise.to, 3)}` : 'find';
    parts.push(`n${round(c.noise.amountDb, 1)},${round(c.noise.sensitivity, 2)},${where}`);
  }
  if (c.breaths && c.breaths.reduceDb > 0) {
    const spans = c.breaths.spans ? activeBreaths(c).map((b) => `${round(b.from, 3)}-${round(b.to, 3)}`).join('/') : 'find';
    parts.push(`b${round(c.breaths.reduceDb, 1)},${round(c.breaths.sensitivity, 2)},${spans}`);
  }
  if (c.clicks) parts.push(`c${round(c.clicks.sensitivity, 2)}`);
  return parts.join(';');
}

/** True when a render exists and was made from exactly these settings. */
export function isRenderCurrent(c: VocalCleanup): boolean {
  return !!c.renderedSampleId && c.renderedFor === cleanupSignature(c);
}

/** What the AI's and the window's one-line change asks for; a field left out keeps that section as it is. */
export interface CleanupRequest {
  /** Noise reduction in dB (0 turns the section off). */
  noiseDb?: number;
  /** How firmly noise is separated from voice, 0–100 %. */
  noiseSensitivity?: number;
  /** Breath reduction in dB (0 off, 60 or more removes them). */
  breathsDb?: number;
  /** How many breaths are found, 0–100 %. */
  breathSensitivity?: number;
  /** Mouth-click removal on or off. */
  clicks?: boolean;
  /** How small a click still counts, 0–100 %. */
  clickSensitivity?: number;
}

/**
 * The settings after a request: sections are switched on, changed or off; the render and its findings stay unless the
 * change makes them wrong (a new noise sensitivity keeps the learned stretch; a new breath sensitivity forgets the
 * breaths found so they are found again; a changed amount keeps them).
 */
export function applyCleanupRequest(before: VocalCleanup | undefined, req: CleanupRequest): VocalCleanup {
  const next: VocalCleanup = {};
  if (before?.renderedSampleId) next.renderedSampleId = before.renderedSampleId;
  if (before?.renderedFor !== undefined) next.renderedFor = before.renderedFor;
  next.noise = nextNoise(before?.noise, req);
  next.breaths = nextBreaths(before?.breaths, req);
  next.clicks = nextClicks(before?.clicks, req);
  if (!next.noise) delete next.noise;
  if (!next.breaths) delete next.breaths;
  if (!next.clicks) delete next.clicks;
  return next;
}

function nextNoise(before: VocalCleanup['noise'], req: CleanupRequest): VocalCleanup['noise'] {
  if (req.noiseDb === undefined && req.noiseSensitivity === undefined) return before;
  if (req.noiseDb !== undefined && req.noiseDb <= 0) return undefined;
  const base = before ?? { ...DEFAULT_NOISE };
  return {
    ...base,
    amountDb: req.noiseDb !== undefined ? clamp(req.noiseDb, 0, DENOISE_MAX_DB) : base.amountDb,
    sensitivity: req.noiseSensitivity !== undefined ? clamp(req.noiseSensitivity / 100, 0, 1) : base.sensitivity,
  };
}

function nextBreaths(before: VocalCleanup['breaths'], req: CleanupRequest): VocalCleanup['breaths'] {
  if (req.breathsDb === undefined && req.breathSensitivity === undefined) return before;
  if (req.breathsDb !== undefined && req.breathsDb <= 0) return undefined;
  const base = before ?? { ...DEFAULT_BREATHS };
  const sensitivity = req.breathSensitivity !== undefined ? clamp(req.breathSensitivity / 100, 0, 1) : base.sensitivity;
  const next: NonNullable<VocalCleanup['breaths']> = {
    reduceDb: req.breathsDb !== undefined ? clamp(req.breathsDb, 0, BREATH_REMOVE_DB) : base.reduceDb,
    sensitivity,
  };
  if (base.spans && sensitivity === base.sensitivity) next.spans = base.spans;
  return next;
}

function nextClicks(before: VocalCleanup['clicks'], req: CleanupRequest): VocalCleanup['clicks'] {
  if (req.clicks === undefined && req.clickSensitivity === undefined) return before;
  if (req.clicks === false) return undefined;
  const sensitivity = req.clickSensitivity !== undefined ? clamp(req.clickSensitivity / 100, 0, 1) : (before?.sensitivity ?? DEFAULT_CLICKS.sensitivity);
  return { sensitivity };
}

/** The clip's own settings kept clean: numbers inside their ranges, spans in order, nothing else. Null when it is not an object with anything in it. */
export function sanitizeCleanup(raw: unknown): VocalCleanup | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: VocalCleanup = {};
  const noise = sanitizeNoise(r.noise);
  if (noise) out.noise = noise;
  const breaths = sanitizeBreaths(r.breaths);
  if (breaths) out.breaths = breaths;
  const clicks = sanitizeClicks(r.clicks);
  if (clicks) out.clicks = clicks;
  if (!out.noise && !out.breaths && !out.clicks) return null;
  if (typeof r.renderedSampleId === 'string' && r.renderedSampleId) out.renderedSampleId = r.renderedSampleId as SampleId;
  if (typeof r.renderedFor === 'string') out.renderedFor = r.renderedFor;
  return out;
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function sanitizeNoise(raw: unknown): VocalCleanup['noise'] {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (!isNumber(r.amountDb) || r.amountDb <= 0) return undefined;
  const out: NonNullable<VocalCleanup['noise']> = {
    amountDb: clamp(r.amountDb, 0, DENOISE_MAX_DB),
    sensitivity: isNumber(r.sensitivity) ? clamp(r.sensitivity, 0, 1) : DEFAULT_NOISE.sensitivity,
  };
  if (isNumber(r.from) && isNumber(r.to) && r.to > r.from && r.from >= 0) {
    out.from = r.from;
    out.to = r.to;
  }
  return out;
}

function sanitizeBreaths(raw: unknown): VocalCleanup['breaths'] {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (!isNumber(r.reduceDb) || r.reduceDb <= 0) return undefined;
  const out: NonNullable<VocalCleanup['breaths']> = {
    reduceDb: clamp(r.reduceDb, 0, BREATH_REMOVE_DB),
    sensitivity: isNumber(r.sensitivity) ? clamp(r.sensitivity, 0, 1) : DEFAULT_BREATHS.sensitivity,
  };
  if (Array.isArray(r.spans)) {
    const spans: BreathSpan[] = [];
    for (const s of r.spans) {
      if (typeof s !== 'object' || s === null) continue;
      const span = s as Record<string, unknown>;
      if (!isNumber(span.from) || !isNumber(span.to) || span.from < 0 || span.to <= span.from) continue;
      spans.push(span.off === true ? { from: span.from, to: span.to, off: true } : { from: span.from, to: span.to });
    }
    spans.sort((a, b) => a.from - b.from);
    // Overlapping spans would turn the same sound down twice: keep the earlier.
    out.spans = spans.filter((s, i) => i === 0 || s.from >= (spans[i - 1] as BreathSpan).to);
  }
  return out;
}

function sanitizeClicks(raw: unknown): VocalCleanup['clicks'] {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  return { sensitivity: isNumber(r.sensitivity) ? clamp(r.sensitivity, 0, 1) : DEFAULT_CLICKS.sensitivity };
}

/** One plain sentence about what a clip's cleanup does, for the clip's tag, the window and the AI. */
export function describeCleanup(c: VocalCleanup): string {
  const parts: string[] = [];
  if (c.noise && c.noise.amountDb > 0) parts.push(`noise down ${round(c.noise.amountDb, 1)} dB`);
  if (c.breaths && c.breaths.reduceDb > 0) {
    const found = c.breaths.spans ? ` (${activeBreaths(c).length} found)` : '';
    parts.push(c.breaths.reduceDb >= BREATH_REMOVE_DB ? `breaths removed${found}` : `breaths down ${round(c.breaths.reduceDb, 1)} dB${found}`);
  }
  if (c.clicks) parts.push('mouth clicks removed');
  return parts.length ? parts.join(', ') : 'nothing is changed';
}
