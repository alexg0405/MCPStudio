import { MASTER, type InsertId, type PatternId, type Project, type Tick } from '@core/model/types';
import { planStems, stemProject, withoutMasterChain } from '@core/query/stems';
import { ticksPerBar } from '@core/time/ppq';
import { renderOffline } from '@engine/render-offline';
import { planExport, planSeconds, type ExportPlan } from '../export/plan';
import type { Services } from '../services';
import { BANDS, Measurer, type Measurement } from './measure';

/**
 * "Listening" to the mix for the AI studio: renders the mix (through the master's effects) and one
 * stem per mixer track (as each reaches the master, before the master's effects), measures them,
 * and writes the findings in plain words. At most `maxSeconds` of the song: the loop region if
 * there is one, else from the start; in pattern mode, the current pattern (looped to a few seconds).
 */
export interface TrackReport {
  insertId: InsertId;
  /** "03 Drums". */
  name: string;
  /** The channels heard on it. */
  channels: string[];
  m: Measurement;
}

export interface MixReport {
  /** What was analyzed, in words. */
  what: string;
  seconds: number;
  master: Measurement;
  tracks: TrackReport[];
  /** Things worth fixing, in plain words. */
  notes: string[];
}

/** Just one part: a span of the song (exclusive end), or one pattern on a loop. */
export type AnalyzeRange = { from: Tick; to: Tick } | { patternId: PatternId };

export interface AnalyzeOptions {
  maxSeconds?: number;
  sampleRate?: number;
  signal?: AbortSignal;
  onProgress?(fraction: number, label: string): void;
  /** Listen to just this part ("Ask AI about this part"); default: the loop region, the song or the pattern. */
  range?: AnalyzeRange;
}

const RATE = 48000;
/**
 * Lets the UI breathe between pieces of measuring. Not setTimeout: a hidden tab throttles it to a
 * second per call, which would make the analysis crawl while the musician looks elsewhere.
 */
const yieldToUi = (): Promise<void> => {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(0);
  });
};

/** Which part of the project to listen to: `range` when given, else the loop region, the song or the pattern. */
export function analysisPlan(s: Services, maxSeconds: number, range?: AnalyzeRange): ExportPlan {
  const project = s.doc.getState().project;
  const view = s.view.getState();
  const bar = ticksPerBar(project.transport.timeSig);
  let plan: ExportPlan | { error: string };
  if (range && 'patternId' in range) plan = planExport(project, { ...view, currentPatternId: range.patternId }, 'pattern');
  else if (range && range.to > range.from)
    plan = { mode: 'song', patternId: view.currentPatternId, fromTick: Math.max(0, range.from), bars: (range.to - Math.max(0, range.from)) / bar };
  else {
    plan = view.mode === 'song' && view.loop ? planExport(project, view, 'loop') : planExport(project, view, view.mode);
    if ('error' in plan) plan = planExport(project, view, 'pattern');
  }
  if ('error' in plan) throw new Error(plan.error);
  const seconds = planSeconds(project, plan);
  const barSeconds = seconds / Math.max(plan.bars, 1e-9);
  if (seconds > maxSeconds) plan = { ...plan, bars: Math.max(1, Math.floor(maxSeconds / barSeconds)) };
  // A short pattern loops for a few seconds, enough to measure its loudness.
  else if (plan.mode === 'pattern' && seconds < 8) plan = { ...plan, bars: plan.bars * Math.ceil(8 / seconds) };
  return plan;
}

function describePlan(project: Project, plan: ExportPlan, seconds: number): string {
  const bar = ticksPerBar(project.transport.timeSig);
  const first = Math.floor(plan.fromTick / bar) + 1;
  const last = Math.max(first, Math.ceil((plan.fromTick + plan.bars * bar) / bar));
  const where =
    plan.mode === 'pattern'
      ? `the pattern “${(plan.patternId && project.patterns[plan.patternId]?.name) ?? 'current'}” on a loop`
      : `bars ${first}–${last} of the song`;
  return `${Math.round(seconds)} s: ${where}`;
}

async function measureAsync(
  left: Float32Array,
  right: Float32Array,
  rate: number,
  truePeak: boolean,
  signal?: AbortSignal,
): Promise<Measurement> {
  const m = new Measurer(rate, truePeak);
  for (let i = 0; i < left.length; i += rate) {
    m.push(left, right, i, Math.min(left.length, i + rate));
    await yieldToUi();
    signal?.throwIfAborted();
  }
  return m.result();
}

export async function analyzeMix(s: Services, opts: AnalyzeOptions = {}): Promise<MixReport> {
  const project = s.doc.getState().project;
  const rate = opts.sampleRate ?? RATE;
  const plan = analysisPlan(s, opts.maxSeconds ?? 30, opts.range);
  const seconds = planSeconds(project, plan);
  const frames = Math.round(seconds * rate);
  const raw = withoutMasterChain(project);
  const toTick = plan.fromTick + plan.bars * ticksPerBar(project.transport.timeSig);
  const stems = planStems(raw, { mode: plan.mode, patternId: plan.patternId, fromTick: plan.fromTick, toTick });
  const steps = stems.length + 1;
  const engineOpts = { plugins: s.plugins, sampleCache: s.sampleCache };

  const render = async (p: Project, limiter: boolean, step: number, label: string) => {
    const r = await renderOffline(p, {
      ...engineOpts,
      view: { mode: plan.mode, patternId: plan.patternId, loop: null },
      bars: plan.bars,
      fromTick: plan.fromTick,
      sampleRate: rate,
      tail: 0,
      limiter,
      onProgress: (f) => opts.onProgress?.((step + f * 0.8) / steps, label),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const start = Math.round((r.preRoll + r.latency) * rate);
    const left = r.buffer.getChannelData(0).subarray(start, start + frames);
    const right = r.buffer.numberOfChannels > 1 ? r.buffer.getChannelData(1).subarray(start, start + frames) : left;
    opts.onProgress?.((step + 0.85) / steps, label);
    return measureAsync(left, right, rate, step === 0, opts.signal);
  };

  s.engine.stop();
  const master = await render(project, true, 0, 'The mix');
  const tracks: TrackReport[] = [];
  for (const [i, stem] of stems.entries()) {
    const m = await render(stemProject(raw, stems, stem), false, i + 1, stem.name.replace(/^\d+\s*/, ''));
    tracks.push({
      insertId: stem.insertId,
      name: stem.name,
      channels: stem.channels.map((id) => project.channels[id]?.name ?? id),
      m,
    });
  }
  opts.onProgress?.(1, 'Done');
  const report: MixReport = { what: describePlan(project, plan, seconds), seconds, master, tracks, notes: [] };
  report.notes = mixNotes(report, project);
  return report;
}

// ---------------------------------------------------------------------------------------------
// Findings and the text the AI gets

const LOW = [0, 1];
const lowShare = (m: Measurement) => LOW.reduce((a, i) => a + (m.bands[i] ?? 0), 0);
const label = (t: TrackReport) => `“${t.name.replace(/^\d+\s*/, '')}”`;
const num = (x: number, digits = 1) =>
  Number.isFinite(x) ? `${x < 0 ? '−' : ''}${Math.abs(x).toFixed(digits)}` : x > 0 ? '+∞' : '−∞';

/** Plain-words findings: loudness, peaks, clashes in the low end, balance and width. */
export function mixNotes(r: MixReport, project?: Project): string[] {
  const notes: string[] = [];
  const m = r.master;
  if (m.silent) return ['The mix is silent in this part: nothing plays.'];
  const limiterOnMaster = project?.mixer.inserts[MASTER]?.fx.some(
    (f) => f.enabled && /limiter/i.test(f.plugin.pluginId),
  );
  if (m.lufs < -20)
    notes.push(
      `The master is quiet (${num(m.lufs)} LUFS). Streaming plays songs at about −14 LUFS; ${limiterOnMaster ? 'raise the Limiter’s input' : 'a Limiter last on the master can raise it'}.`,
    );
  else if (m.lufs > -8)
    notes.push(`The master is very loud (${num(m.lufs)} LUFS): it may sound squashed, and streaming turns it down anyway.`);
  if (m.truePeakDb !== null && m.truePeakDb > -1)
    notes.push(
      `The master’s true peak is ${num(m.truePeakDb)} dBTP: above −1 it can clip once encoded (MP3, streaming). ${limiterOnMaster ? 'Set the Limiter’s ceiling to −1 dB.' : 'Put a Limiter last on the master with its ceiling at −1 dB.'}`,
    );
  if (m.correlation < 0.2)
    notes.push(`The master’s stereo correlation is low (${num(m.correlation, 2)}): parts may vanish in mono or sound hollow.`);
  if (lowShare(m) > 60) notes.push(`The mix is bass-heavy: ${Math.round(lowShare(m))}% of its energy is below 250 Hz.`);
  const top = (m.bands[4] ?? 0) + (m.bands[5] ?? 0);
  if (top < 4) notes.push(`The mix is dull: only ${num(top)}% of its energy is above 4 kHz.`);

  const heard = r.tracks.filter((t) => !t.m.silent);
  for (const t of r.tracks)
    if (t.m.silent) notes.push(`${label(t)} makes no sound in this part.`);
  for (const t of heard)
    if (t.m.peakDb > 0) notes.push(`${label(t)} peaks above 0 dBFS (${num(t.m.peakDb)} dB): turn its fader down a little.`);
  // Two loud tracks living in the same low end mask each other.
  const lowTracks = heard.filter((t) => lowShare(t.m) > 50).sort((a, b) => b.m.lufs - a.m.lufs);
  for (let i = 0; i + 1 < lowTracks.length && i < 2; i++) {
    const a = lowTracks[i] as TrackReport;
    const b = lowTracks[i + 1] as TrackReport;
    if (Math.abs(a.m.lufs - b.m.lufs) < 8)
      notes.push(
        `${label(a)} and ${label(b)} both live in the low end (below 250 Hz): duck one with the other (sidechain) or give each its own range with EQ.`,
      );
  }
  for (const t of heard)
    if (lowShare(t.m) > 50 && t.m.width > 0.25)
      notes.push(`${label(t)} is wide in the low end (width ${num(t.m.width, 2)}): keep bass close to mono (the Stereo effect’s Mono below).`);
  if (heard.length >= 3) {
    const sorted = [...heard].map((t) => t.m.lufs).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] as number;
    for (const t of heard)
      if (t.m.lufs > median + 8)
        notes.push(`${label(t)} is much louder than the rest (${num(t.m.lufs)} LUFS; the middle track is ${num(median)}).`);
  }
  return notes;
}

const pct = (m: Measurement) => BANDS.map((b, i) => `${b.id} ${Math.round(m.bands[i] ?? 0)}%`).join(', ');
const width = (w: number) => (Number.isFinite(w) ? num(w, 2) : 'out of phase');

function line(m: Measurement): string {
  if (m.silent) return 'silent';
  return [
    `${num(m.lufs)} LUFS (loudest 3 s ${num(m.shortTermMax)})`,
    `peak ${num(m.peakDb)} dBFS${m.truePeakDb !== null ? `, true peak ${num(m.truePeakDb)} dBTP` : ''}`,
    `crest ${num(m.crestDb)} dB`,
    `width ${width(m.width)}, correlation ${num(m.correlation, 2)}`,
    `tone: ${pct(m)}`,
  ].join('; ');
}

/** The analysis as the AI reads it. */
export function formatMixReport(r: MixReport): string {
  const lines = [
    `Analyzed ${r.what}, 48 kHz. Bands: ${BANDS.map((b) => `${b.id} = ${b.label}`).join(', ')}.`,
    `Master (what you hear, after its effects): ${line(r.master)}.`,
    'Mixer tracks (each as it reaches the master, before the master’s effects):',
    ...r.tracks.map((t) => `- ${t.name} (${t.channels.join(', ') || 'no channels'}): ${line(t.m)}`),
  ];
  if (r.notes.length) lines.push('Findings:', ...r.notes.map((n) => `- ${n}`));
  return lines.join('\n');
}

/** One line for the chat ("Master −11.2 LUFS, true peak −0.4 dBTP · 5 tracks · 2 findings"). */
export function summarizeMixReport(r: MixReport): string {
  const m = r.master;
  if (m.silent) return 'The mix is silent here.';
  const tp = m.truePeakDb !== null ? `, true peak ${num(m.truePeakDb)} dBTP` : '';
  const n = r.notes.length;
  return `Master ${num(m.lufs)} LUFS${tp} · ${r.tracks.length} track${r.tracks.length === 1 ? '' : 's'} · ${n ? `${n} finding${n === 1 ? '' : 's'}` : 'no problems found'}`;
}
