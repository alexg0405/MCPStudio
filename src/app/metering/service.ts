/**
 * The metering suite in the app: who is listening to which part of the mix, the Meters window's settings, and the
 * loudness report. A meter is opened only while somebody holds a lease on it (the Meters window, the mixer's master
 * readout, a Studio read) and closed the moment the last lease is released, so closed windows cost the audio thread
 * nothing. Leases on the same source share one meter; asking for full detail upgrades it while that lease lasts.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { MASTER, type InsertId } from '@core/model/types';
import { formatReport, type LoudnessReport } from '@core/metering/report';
import type { MeterHandle } from '@engine/api';
import { R } from '@engine/meter/layout';
import type { Services } from '../services';
import { whileBusy } from '../storage/busy';
import { loudnessReport, type ReportOptions } from './report';
import { resolveTarget, TARGET_CHOICES, type ResolvedTarget, type TargetChoice } from './targets';

const SETTINGS_KEY = 'agstudio:meters';
/** How long a Studio read keeps a meter open so that its next read has numbers (ms). */
const READ_LISTEN_MS = 30_000;

export interface MeterSettings {
  /** The mixer track the Meters window listens to (the master by default). */
  source: InsertId;
  target: TargetChoice;
  /** Tilt of the spectrum in dB per octave around 1 kHz (0: true levels; positive lifts the highs). */
  slopeDb: number;
  /** Restart the integrated loudness whenever the song starts playing. */
  resetOnPlay: boolean;
}

export interface MeterState extends MeterSettings {
  /** The last loudness report (it ages: the song may change after it). */
  report: LoudnessReport | null;
  /** The report panel of the Meters window is showing. */
  reportOpen: boolean;
  /** A report is being made: what, and how far (0 to 1). */
  working: { label: string; fraction: number } | null;
}

const DEFAULT_SETTINGS: MeterSettings = { source: MASTER, target: 'auto', slopeDb: 0, resetOnPlay: true };

/** The live numbers of the master, for Studio and the MCP tools (null values: nothing measured yet). */
export interface LiveReadings {
  momentary: number | null;
  shortTerm: number | null;
  integrated: number | null;
  range: number;
  truePeakDb: number | null;
  maxMomentary: number | null;
  maxShortTerm: number | null;
  correlation: number;
  monoLossDb: number;
  playing: boolean;
}

export interface MeterLeaseHandle {
  readonly meter: MeterHandle;
  release(): void;
}

interface Entry {
  meter: MeterHandle;
  basic: number;
  full: number;
}

function loadSettings(): MeterSettings {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(SETTINGS_KEY) ?? 'null') as Partial<MeterSettings> | null;
    if (!saved) return { ...DEFAULT_SETTINGS };
    const target = TARGET_CHOICES.includes(saved.target as TargetChoice) ? (saved.target as TargetChoice) : DEFAULT_SETTINGS.target;
    const slopeDb = typeof saved.slopeDb === 'number' && Math.abs(saved.slopeDb) <= 6 ? saved.slopeDb : 0;
    return { source: MASTER, target, slopeDb, resetOnPlay: saved.resetOnPlay !== false };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const finiteOrNull = (value: number | undefined) => (value !== undefined && Number.isFinite(value) ? value : null);

export class MeterService {
  readonly store: StoreApi<MeterState>;
  private readonly entries = new Map<InsertId, Entry>();
  private stopWatchingEngine: (() => void) | null = null;
  private wasPlaying = false;
  private readTimer: ReturnType<typeof setTimeout> | null = null;
  private readLease: MeterLeaseHandle | null = null;
  private reportAbort: AbortController | null = null;

  constructor(private readonly services: Services) {
    this.store = createStore<MeterState>(() => ({ ...loadSettings(), report: null, reportOpen: false, working: null }));
    this.store.subscribe((state, before) => {
      if (state.target === before.target && state.slopeDb === before.slopeDb && state.resetOnPlay === before.resetOnPlay) return;
      this.saveSettings();
    });
  }

  /** The target line for the current project and choice. */
  target(): ResolvedTarget {
    return resolveTarget(this.store.getState().target, this.services.doc.getState().project);
  }

  /** Opens (or shares) a meter on `source`; release the lease when the window or readout goes away. */
  listen(source: InsertId, opts: { full: boolean }): MeterLeaseHandle {
    let entry = this.entries.get(source);
    if (!entry) {
      const meter = this.services.engine.openMeter?.(source, { full: opts.full });
      if (!meter) return { meter: unavailableMeter, release: () => {} };
      entry = { meter, basic: 0, full: 0 };
      this.entries.set(source, entry);
      this.watchEngine();
    }
    if (opts.full) entry.full++;
    else entry.basic++;
    entry.meter.setDetail(entry.full > 0);
    const held = entry;
    let released = false;
    return {
      meter: held.meter,
      release: () => {
        if (released) return;
        released = true;
        if (opts.full) held.full--;
        else held.basic--;
        if (held.full + held.basic > 0) {
          held.meter.setDetail(held.full > 0);
          return;
        }
        held.meter.close();
        if (this.entries.get(source) === held) this.entries.delete(source);
        if (this.entries.size === 0) this.unwatchEngine();
      },
    };
  }

  /** Meters that are open (a closed Meters window and mixer leave none). */
  get openCount(): number {
    return this.entries.size;
  }

  /** Restarts the integrated loudness, the loudness range, the maximums and the history of every open meter. */
  reset(): void {
    for (const entry of this.entries.values()) entry.meter.reset();
  }

  /**
   * The master's numbers right now, for Studio. With no meter open it opens one for a while (the numbers
   * start from this call: the answer says to play the song and ask again), and returns null.
   */
  live(): LiveReadings | null {
    const entry = this.entries.get(MASTER);
    if (!entry) {
      this.listenForAWhile();
      return null;
    }
    this.listenForAWhile();
    const r = entry.meter.readings;
    return {
      momentary: finiteOrNull(r[R.momentary]),
      shortTerm: finiteOrNull(r[R.shortTerm]),
      integrated: finiteOrNull(r[R.integrated]),
      range: Math.round((r[R.range] as number) * 10) / 10,
      truePeakDb: finiteOrNull(Math.max(r[R.truePeakL] as number, r[R.truePeakR] as number)),
      maxMomentary: finiteOrNull(r[R.maxMomentary]),
      maxShortTerm: finiteOrNull(r[R.maxShortTerm]),
      correlation: Math.round((r[R.correlation] as number) * 100) / 100,
      monoLossDb: Math.round((r[R.monoLoss] as number) * 10) / 10,
      playing: this.services.engine.playing,
    };
  }

  /** Makes the loudness report (renders the song offline). Resolves null when it was stopped or there is nothing to play. */
  async makeReport(opts: Omit<ReportOptions, 'signal' | 'onProgress'> & { signal?: AbortSignal } = {}): Promise<LoudnessReport | null> {
    if (this.store.getState().working) return null;
    const abort = new AbortController();
    this.reportAbort = abort;
    opts.signal?.addEventListener('abort', () => abort.abort(), { once: true });
    this.store.setState({ working: { label: 'Listening to the song', fraction: 0 } });
    try {
      const project = this.services.doc.getState().project;
      const report = await whileBusy(
        () =>
          loudnessReport(this.services, {
            ...opts,
            signal: abort.signal,
            onProgress: (label, fraction) => this.store.setState({ working: { label, fraction } }),
          }),
        { project },
      );
      if (report) this.store.setState({ report });
      return report;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      throw error;
    } finally {
      this.reportAbort = null;
      this.store.setState({ working: null });
    }
  }

  /** Shows the report panel and makes a new report (the Meters window's button, the menu, Studio). */
  async showReport(opts: Parameters<MeterService['makeReport']>[0] = {}): Promise<LoudnessReport | null> {
    this.store.setState({ reportOpen: true });
    const report = await this.makeReport(opts);
    if (!report && !this.store.getState().report && !this.store.getState().working) {
      this.services.session.getState().toast('There is nothing to measure yet: add a pattern or put clips in the playlist.', 'info');
    }
    return report;
  }

  /** Stops the report that is being made. */
  stopReport(): void {
    this.reportAbort?.abort();
  }

  /** The last report as plain text (or null when there is none). */
  reportText(): string | null {
    const report = this.store.getState().report;
    return report ? formatReport(report, this.services.doc.getState().project.transport.timeSig) : null;
  }

  private listenForAWhile(): void {
    if (!this.readLease) this.readLease = this.listen(MASTER, { full: false });
    if (this.readTimer) clearTimeout(this.readTimer);
    this.readTimer = setTimeout(() => {
      this.readLease?.release();
      this.readLease = null;
      this.readTimer = null;
    }, READ_LISTEN_MS);
  }

  /** Starts a new measurement whenever the song starts playing (if the musician wants that). */
  private watchEngine(): void {
    if (this.stopWatchingEngine) return;
    this.wasPlaying = this.services.engine.playing;
    this.stopWatchingEngine = this.services.engine.subscribe(() => {
      const playing = this.services.engine.playing;
      if (playing && !this.wasPlaying && this.store.getState().resetOnPlay) this.reset();
      this.wasPlaying = playing;
    });
  }

  private unwatchEngine(): void {
    this.stopWatchingEngine?.();
    this.stopWatchingEngine = null;
  }

  private saveSettings(): void {
    const { target, slopeDb, resetOnPlay } = this.store.getState();
    try {
      globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify({ target, slopeDb, resetOnPlay }));
    } catch {
      /* storage is unavailable: the settings last until the page closes */
    }
  }
}

/** What a lease holds when metering is impossible (no engine, no cross-origin isolation): nothing is ever measured. */
const unavailableMeter: MeterHandle = (() => {
  const readings = new Float64Array(32);
  readings[R.momentary] = readings[R.shortTerm] = readings[R.integrated] = -Infinity;
  readings[R.truePeakL] = readings[R.truePeakR] = readings[R.peakL] = readings[R.peakR] = -Infinity;
  readings[R.maxMomentary] = readings[R.maxShortTerm] = readings[R.levelLow] = -Infinity;
  return {
    readings,
    history: new Float32Array(0),
    spectrum: new Float32Array(0),
    scope: new Float32Array(0),
    sampleRate: 0,
    active: false,
    blocks: 0,
    setDetail: () => {},
    reset: () => {},
    close: () => {},
  };
})();
