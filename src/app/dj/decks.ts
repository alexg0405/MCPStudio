/**
 * DJ live decks: the `DecksApi` implementation. Four decks, a mixer and a master, played through the engine's
 * output. This file is the control side (what a button, a MIDI controller or the Studio asks for, kept as state in
 * `store`); the sound is made by the players on the audio thread (`engine/deck/deck.kernel.ts`), which this talks
 * to through messages and reads back through shared memory. See docs/architecture.md, "DJ live decks".
 *
 * Deck state is live performance state: it is not in the project and not in History. The decks are created on first
 * use (`decks-factory.ts`) and their audio graph on the first song loaded.
 *
 * Positions are seconds of the song file everywhere in the API; the players count frames of the context's rate (the
 * song is decoded at it), so a frame is a second × `sampleRate`.
 */
import { createStore } from 'zustand/vanilla';
import {
  autoLoopSpan,
  beatJumpTarget,
  clampEq,
  clampPitch,
  clampTrim,
  crossfadeAt,
  deckGridOf,
  cuePressPlan,
  hotCuePosition,
  loopBeats,
  manualLoopSpan,
  nudgeBend,
  rangeFor,
  resizeLoop,
  scratchRate,
  shiftLoop,
  snapToGrid,
  syncPlan,
  type DeckGrid,
  liveMixTitle,
  REV_SEC,
  FADER_MAX,
} from '@core/dj/decks-math';
import { fillPeaks, newWaveform, PEAK_BUCKET, type DeckWaveform } from '@core/dj/deck-peaks';
import type { TrackAnalysis } from '@core/dj/types';
import { WavStreamEncoder } from '@core/io/wav';
import type { SampleRef } from '@core/model/types';
import type { DeckHost } from '@engine/api';
import { LONG_SONG_SEC, MAX_WHOLE_DECODE_SEC } from '@core/dj/long';
import { yieldToMain } from '@engine/audio-buffers';
import { DeckGraph } from '@engine/deck/deck-graph';
import type { SyncSpec } from '@engine/deck/deck-id';
import { bufferSource, blobReader, openSegmentSource, type DeckSource } from '@engine/deck/deck-source';
import { DeckStream, type PinnedPlace } from '@engine/deck/deck-stream';
import type { TapCapture } from '@engine/deck/tap-capture';
import { SampleCache } from '@engine/samples';
import {
  DECK_IDS,
  HOT_CUES,
  type DeckId,
  type DeckState,
  type DecksApi,
  type DecksState,
  type EqBand,
} from './decks-api';

/** What the decks need from the app (the factory wires them to the services; tests pass their own). */
export interface DecksDeps {
  /** The live-audio host of the running engine, or null when there is none (offline, tests). */
  host(): DeckHost | null;
  /** Calls back when the engine may have changed (a reboot gives a new context). */
  subscribeHost(fn: () => void): () => void;
  /** Resumes the audio context (browsers start it suspended until a click). */
  resume(): Promise<void>;
  cache: SampleCache;
  /** The song's analysis: cached, or computed now. Null when it can't be analyzed. `signal` stops the work (when nothing else wants it). */
  analysis(ref: SampleRef, opts?: { signal?: AbortSignal; onProgress?(fraction: number): void }): Promise<TrackAnalysis | null>;
  peekAnalysis(ref: SampleRef): TrackAnalysis | null;
  /** Puts a recording in the music library; resolves with its title. */
  addRecording(file: File, title: string): Promise<string | null>;
  toast(message: string, kind?: 'error'): void;
  /**
   * The song's file, read lazily a part at a time (an OPFS file), or null: what a song too long to decode whole is
   * played from. Without it every song is decoded whole through the cache.
   */
  openFile?(ref: SampleRef): Promise<Blob | null>;
  /** Cue points and hot cues kept per song (by content hash). */
  cues?: {
    load(hash: string): Promise<SavedCues | null>;
    save(hash: string, cues: SavedCues): void;
  };
  /** performance.now() (tests may drive time). */
  now?(): number;
}

export interface SavedCues {
  cuePoint: number;
  hotCues: (number | null)[];
}

const emptyDeck = (id: DeckId): DeckState => ({
  id,
  song: null,
  loading: false,
  playing: false,
  positionSec: 0,
  positionAt: 0,
  baseBpm: null,
  bpm: null,
  analyzing: null,
  pitch: 0,
  pitchRange: 0.08,
  keyLock: false,
  synced: false,
  volume: 1,
  trimDb: 0,
  eq: { low: 0, mid: 0, high: 0 },
  filter: 0,
  cueListen: false,
  cuePoint: 0,
  hotCues: Array.from({ length: HOT_CUES }, () => null),
  loop: null,
  beatJump: 4,
  level: 0,
});

export function initialDecksState(): DecksState {
  return {
    decks: { A: emptyDeck('A'), B: emptyDeck('B'), C: emptyDeck('C'), D: emptyDeck('D') },
    deckCount: 2,
    crossfader: 0,
    crossfaderAssign: { A: 'A', B: 'B', C: 'thru', D: 'thru' },
    crossfaderCurve: 'smooth',
    masterVolume: 1,
    recording: null,
  };
}

/** What the decks keep per deck besides its state. */
interface Rt {
  analysis: TrackAnalysis | null;
  grid: DeckGrid | null;
  wave: DeckWaveform | null;
  /** The song's audio as a window of blocks the player reads (its source is decoded or read from the file as it goes). */
  stream: DeckStream | null;
  /** Counts loads: an older load that finishes late is dropped. */
  token: number;
  /** The cue button is held and the deck plays from the cue point until it is let go. */
  previewing: boolean;
  /** The deck follows this one, matching its tempo as this multiple of its own. */
  syncMaster: DeckId | null;
  syncMult: 0.5 | 1 | 2;
  touching: boolean;
  /** The last seek (ms, and where to): until the player has handled it, its published position is the old one. */
  seekAt: number;
  seekTo: number;
  jogAt: number;
  scratchTimer: ReturnType<typeof setTimeout> | null;
  hash: string | null;
  /** The analysis being made in the background for a song read by parts (stopped when the deck lets go of the song). */
  analyzing: AbortController | null;
}

const emptyRt = (): Rt => ({
  analysis: null,
  grid: null,
  wave: null,
  stream: null,
  token: 0,
  previewing: false,
  syncMaster: null,
  syncMult: 1,
  touching: false,
  seekAt: 0,
  seekTo: 0,
  jogAt: 0,
  scratchTimer: null,
  hash: null,
  analyzing: null,
});

/**
 * Songs longer than this are not decoded whole when their file can be read by parts (WAV, MP3): the deck holds a window
 * of them around the play position (see `deck-stream.ts`), so a 2-hour mix needs no more memory than a 5-minute song.
 */
export { LONG_SONG_SEC };
export { MAX_WHOLE_DECODE_SEC };
/** Files this big are opened by parts when they can be even if their length isn't known yet. */
const BIG_FILE_BYTES = 48 * 1024 * 1024;
/** What a hot cue keeps loaded after its point (seconds): enough to start playing while the rest of its place is read. */
const HOT_CUE_KEEP_SEC = 2.8;
const TICK_MS = 200;

export function createDecks(deps: DecksDeps): DecksApi {
  const store = createStore<DecksState>(() => initialDecksState());
  const rt: Record<DeckId, Rt> = { A: emptyRt(), B: emptyRt(), C: emptyRt(), D: emptyRt() };
  const now = deps.now ?? (() => performance.now());
  let graph: DeckGraph | null = null;
  let graphP: Promise<DeckGraph> | null = null;
  let disposed = false;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let fadeTimer: ReturnType<typeof setInterval> | null = null;
  let capture: { cap: TapCapture; parts: Uint8Array[]; enc: WavStreamEncoder; frames: number } | null = null;
  let cueDevice = '';
  const levelBuf = new Float32Array(6);
  /** Decks whose platter is being held (a held platter doesn't let go by timeout). */
  const touchHeld = new Set<DeckId>();
  let keepUpFrom: { wall: number; ctx: number } | null = null;
  let keepUpValue: number | undefined;

  const idx = (id: DeckId) => DECK_IDS.indexOf(id);
  const get = (id: DeckId): DeckState => store.getState().decks[id];
  const set = (id: DeckId, patch: Partial<DeckState>) =>
    store.setState((s) => ({ decks: { ...s.decks, [id]: { ...s.decks[id], ...patch } } }));
  const chan = (id: DeckId) => graph?.channel(idx(id)) ?? null;
  const sr = () => graph?.ctx.sampleRate ?? 48000;
  const loaded = (id: DeckId) => get(id).song !== null;
  const durationOf = (id: DeckId) => get(id).song?.durationSec ?? 0;

  try {
    cueDevice = globalThis.localStorage?.getItem('agstudio.dj.cueDevice') ?? '';
  } catch {
    /* storage unavailable */
  }

  // ---- Graph lifecycle ----

  function ensureGraph(): Promise<DeckGraph> {
    if (graph && deps.host()?.ctx === graph.ctx) return Promise.resolve(graph);
    if (graphP) return graphP;
    const host = deps.host();
    if (!host) return Promise.reject(new Error('The audio engine isn’t running here, so the decks can’t play.'));
    const p = (async () => {
      const g = await DeckGraph.create(host);
      if (disposed) {
        g.dispose();
        throw new Error('The decks were closed.');
      }
      const old = graph;
      graph = g;
      attachAll(g, old);
      old?.dispose();
      if (cueDevice) void g.setCueOutput(cueDevice);
      return g;
    })().finally(() => {
      if (graphP === p) graphP = null;
    });
    graphP = p;
    return p;
  }

  // The engine rebooted (a new context): the decks move over with their songs, positions and settings.
  const offHost = deps.subscribeHost(() => {
    if (disposed || !graph) return;
    const h = deps.host();
    if (h && h.ctx !== graph.ctx) void ensureGraph().catch(() => {});
  });

  /** Pushes everything a graph needs to sound like the state says (a new graph, after a reboot). */
  function attachAll(g: DeckGraph, old: DeckGraph | null) {
    const s = store.getState();
    g.setMasterVolume(s.masterVolume);
    for (const id of DECK_IDS) {
      const d = s.decks[id];
      const ch = g.channel(idx(id));
      ch.onEnded = () => ended(id);
      ch.setTrim(d.trimDb);
      ch.setEq('low', d.eq.low);
      ch.setEq('mid', d.eq.mid);
      ch.setEq('high', d.eq.high);
      ch.setFilter(d.filter);
      ch.setFader(d.volume);
      ch.setCueListen(d.cueListen);
      ch.setCrossfade(s.crossfaderAssign[id], s.crossfader, s.crossfaderCurve);
      const r = rt[id];
      if (!d.song || !r.stream) continue;
      if (r.stream.sampleRate !== g.ctx.sampleRate) {
        // The new context runs at another rate: read the song again for it.
        const pos = old ? old.channel(idx(id)).snapshot().pos / r.stream.sampleRate : d.positionSec;
        set(id, { positionSec: pos, positionAt: now() });
        void reloadFor(id, g);
        continue;
      }
      const pos = old ? old.channel(idx(id)).snapshot().pos : d.positionSec * g.ctx.sampleRate;
      sendStream(id, r.stream, pos);
    }
    // Followers need the new masters' state blocks.
    for (const id of DECK_IDS) if (rt[id].syncMaster) sendSync(id);
    startTicker();
  }

  /** Hands a deck's player the song's window (and puts it where it was, with its tempo, loop and play state). */
  function sendStream(id: DeckId, stream: DeckStream, posFrames: number) {
    const ch = chan(id);
    if (!ch) return;
    const d = get(id);
    stream.moveTo(posFrames);
    ch.send({ t: 'stream', poolL: stream.poolL, poolR: stream.poolR, table: stream.table, frames: stream.frames, sampleRate: stream.sampleRate });
    ch.send({ t: 'tempo', rate: 1 + d.pitch, keyLock: d.keyLock });
    ch.send({ t: 'seek', pos: posFrames });
    if (d.loop?.active) sendLoop(id, d.loop.startSec, d.loop.endSec);
    if (d.playing) ch.send({ t: 'play', on: true });
    refreshPins(id);
  }

  /**
   * How a song is read: short ones decoded whole through the shared cache (kept there, pinned while the deck has it), long
   * ones, when their file can be read by parts, straight from the file a few seconds at a time, so no memory goes
   * to more than the window. Files that can only be decoded whole are refused beyond `MAX_WHOLE_DECODE_SEC`.
   */
  async function openSource(ref: SampleRef, title: string, g: DeckGraph): Promise<{ source: DeckSource; buffer: AudioBuffer | null }> {
    const rate = g.ctx.sampleRate;
    const known = ref.durationSec ?? deps.cache.knownDuration(ref, rate);
    const long = known !== null && known > LONG_SONG_SEC;
    if (deps.openFile && (long || known === null)) {
      const blob = await deps.openFile(ref).catch(() => null);
      if (blob && (long || blob.size > BIG_FILE_BYTES)) {
        const source = await openSegmentSource({ reader: blobReader(blob), sampleRate: rate, yieldNow: yieldToMain }).catch(() => null);
        if (source) return { source, buffer: null };
      }
    }
    const tooLong = () =>
      new Error(`“${title}” is longer than ${MAX_WHOLE_DECODE_SEC / 60} minutes and its format can’t be played in parts: use an MP3 or WAV of it.`);
    if (known !== null && known > MAX_WHOLE_DECODE_SEC) throw tooLong();
    const buffer = await deps.cache.load(ref, g.ctx);
    if (!buffer) throw new Error(`Couldn’t read “${title}” (it may have been removed from the library).`);
    if (buffer.duration > MAX_WHOLE_DECODE_SEC) throw tooLong();
    // The decoded copy stays in the cache's budget but can't be evicted while the deck plays from it.
    const release = deps.cache.pin(SampleCache.keyOf(ref.source, rate));
    return { source: bufferSource(buffer, release), buffer };
  }

  async function reloadFor(id: DeckId, g: DeckGraph) {
    const d = get(id);
    if (!d.song) return;
    const r = rt[id];
    const token = ++r.token;
    const old = r.stream;
    try {
      const { source } = await openSource(d.song.ref, d.song.title, g);
      if (token !== r.token || disposed) return void source.dispose();
      const stream = new DeckStream(source);
      r.stream = stream;
      old?.dispose();
      sendStream(id, stream, get(id).positionSec * stream.sampleRate);
    } catch (e) {
      if (token === r.token) deps.toast(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  /** What each deck keeps loaded beyond its window: the cue point, the hot cues (a few seconds each) and an active loop. */
  function refreshPins(id: DeckId) {
    const r = rt[id];
    const stream = r.stream;
    const d = get(id);
    if (!stream || !d.song) return;
    const rate = stream.sampleRate;
    const places: PinnedPlace[] = [];
    const keep = HOT_CUE_KEEP_SEC * rate;
    const at = (sec: number) => places.push({ startFrame: Math.max(0, Math.round(sec * rate)), endFrame: Math.round(sec * rate + keep) });
    if (d.loop?.active && d.loop.endSec > d.loop.startSec)
      places.push({ startFrame: Math.round(d.loop.startSec * rate), endFrame: Math.round(d.loop.endSec * rate) });
    for (const t of d.hotCues) if (t !== null) at(t);
    at(d.cuePoint);
    stream.setPins(places);
  }

  function sendLoop(id: DeckId, startSec: number, endSec: number) {
    const rate = sr();
    chan(id)?.send({ t: 'loop', start: startSec * rate, length: (endSec - startSec) * rate });
  }

  // ---- Positions ----

  /** Where a deck is right now in seconds, as heard (the players' state, carried on by the audio clock). */
  function positionNow(id: DeckId): number {
    const d = get(id);
    const ch = chan(id);
    const g = graph;
    const r = rt[id];
    if (!ch || !g || !d.song) return d.positionSec;
    // A paused deck is where the last seek put it (a held platter moves it: that is read from the player).
    if (!d.playing && !r.touching) return d.positionSec;
    const t = now();
    if (r.seekAt > 0 && t - r.seekAt < 60)
      return Math.max(0, Math.min(d.song.durationSec, r.seekTo + (d.playing ? ((t - r.seekAt) / 1000) * (1 + d.pitch) : 0)));
    const snap = ch.snapshot();
    const rate = g.ctx.sampleRate;
    let pos = snap.pos;
    if (snap.playing && g.ctx.state === 'running') {
      const delta = Math.max(-0.5 * rate, Math.min(0.5 * rate, g.heardFrame() - snap.frame));
      pos += delta * snap.rate;
    }
    return Math.max(0, Math.min(d.song.durationSec, pos / rate));
  }

  /** The player's stall flag (see `DecksApi.isStalled`): read from its published state, no React involved. */
  function isStalled(id: DeckId): boolean {
    const ch = chan(id);
    return !!ch && loaded(id) && ch.snapshot().stalled;
  }

  function refreshPosition(id: DeckId) {
    set(id, { positionSec: positionNow(id), positionAt: now() });
  }

  function ended(id: DeckId) {
    rt[id].previewing = false;
    set(id, { playing: false, positionSec: durationOf(id), positionAt: now() });
  }

  // ---- Ticker: positions, meters ----

  function startTicker() {
    if (ticker || disposed) return;
    ticker = setInterval(tick, TICK_MS);
  }

  function tick() {
    const g = graph;
    if (!g) return;
    const st = store.getState();
    const playing = DECK_IDS.filter((id) => st.decks[id].playing);
    measureKeepUp(playing.length > 0);
    if (playing.length === 0) {
      // Levels fall to nothing once nothing plays.
      if (DECK_IDS.some((id) => st.decks[id].level > 0)) {
        store.setState((s) => ({ decks: Object.fromEntries(DECK_IDS.map((id) => [id, { ...s.decks[id], level: 0 }])) as Record<DeckId, DeckState> }));
      }
      return;
    }
    for (const id of playing) {
      const snap = g.channel(idx(id)).snapshot();
      rt[id].stream?.update(snap.pos, snap.rate);
    }
    g.readLevels(levelBuf);
    const t = now();
    store.setState((s) => {
      const decks = { ...s.decks };
      for (const id of DECK_IDS) {
        const d = decks[id];
        if (!d.playing && d.level === 0) continue;
        const level = d.playing ? Math.min(1, Math.round((levelBuf[idx(id)] as number) * 100) / 100) : 0;
        decks[id] = d.playing ? { ...d, level, positionSec: positionNow(id), positionAt: t } : { ...d, level };
      }
      return { decks };
    });
  }

  function measureKeepUp(playing: boolean) {
    const g = graph;
    if (!g || !playing) {
      keepUpFrom = null;
      keepUpValue = undefined;
      return;
    }
    const wall = now();
    const t = g.ctx.currentTime;
    if (!keepUpFrom) {
      keepUpFrom = { wall, ctx: t };
      return;
    }
    const dt = (wall - keepUpFrom.wall) / 1000;
    if (dt < 1) return;
    keepUpValue = Math.min(1, (t - keepUpFrom.ctx) / dt);
    keepUpFrom = { wall, ctx: t };
  }

  // ---- Loading ----

  /** A deck with nothing loaded: the mixer settings (knobs, faders, key lock) stay, the song's things go. */
  function blank(id: DeckId, extra: Partial<DeckState> = {}): DeckState {
    const d = get(id);
    return {
      ...emptyDeck(id),
      eq: d.eq,
      filter: d.filter,
      volume: d.volume,
      trimDb: d.trimDb,
      cueListen: d.cueListen,
      keyLock: d.keyLock,
      pitchRange: d.pitchRange,
      beatJump: d.beatJump,
      ...extra,
    };
  }

  function forget(id: DeckId) {
    const r = rt[id];
    r.analysis = null;
    r.grid = null;
    r.wave = null;
    r.stream?.dispose();
    r.stream = null;
    r.hash = null;
    r.syncMaster = null;
    r.analyzing?.abort();
    r.analyzing = null;
  }

  async function load(id: DeckId, ref: SampleRef, title: string, artist?: string): Promise<void> {
    const r = rt[id];
    const token = ++r.token;
    for (const f of DECK_IDS) if (rt[f].syncMaster === id) unsync(f);
    stopDeck(id);
    forget(id);
    const info = { ref, title, ...(artist ? { artist } : {}) };
    set(id, blank(id, { loading: true, song: { ...info, durationSec: ref.durationSec ?? 0 } }));
    const stale = () => token !== r.token || disposed;
    let audioReady = false;
    try {
      void deps.resume().catch(() => {});
      const g = await ensureGraph();
      if (stale()) return;
      // The old song's window goes before the new one is made: a deck never holds two.
      chan(id)?.send({ t: 'eject' });
      const { source, buffer } = await openSource(ref, title, g);
      if (stale()) return void source.dispose();
      const stream = new DeckStream(source);
      r.stream = stream;
      // The first seconds are in the window before the song is announced (a source in memory needs no wait at all).
      stream.moveTo(0);
      // A file that can't be read (removed from the store, damaged) would wait forever: give it a while, then say so.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unreadable = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Couldn’t read “${title}”: its file can’t be read.`)), 20_000);
      });
      try {
        await Promise.race([stream.whenResident(0, Math.round(2 * stream.sampleRate)), unreadable]);
      } catch (e) {
        if (!stale()) throw e;
      } finally {
        clearTimeout(timer);
      }
      if (stale()) return;
      audioReady = true;
      set(id, { song: { ...info, durationSec: source.nativeFrames / source.nativeRate } });
      chan(id)?.send({ t: 'stream', poolL: stream.poolL, poolR: stream.poolR, table: stream.table, frames: stream.frames, sampleRate: stream.sampleRate });
      chan(id)?.send({ t: 'tempo', rate: 1, keyLock: get(id).keyLock });
      // The waveform and the analysis arrive while the song can already be played; a song read by parts is read through once
      // for its overview, in the background (an hour takes a while), and the deck is ready meanwhile.
      if (buffer) {
        if (!(await fillOverview(id, source, buffer, stale))) return;
      } else void fillOverview(id, source, null, stale);
      // A song decoded whole is analyzed now. A song read by parts has its analysis made in the background (it is read through
      // in pieces, which takes a while for a long one) unless that is done already: the deck is ready meanwhile and gets its grid after.
      const a = deps.peekAnalysis(ref) ?? (buffer ? await deps.analysis(ref).catch(() => null) : null);
      if (stale()) return;
      r.analysis = a;
      r.grid = a?.grid ? deckGridOf(a.grid) : null;
      r.hash = a?.hash ?? (ref.source.kind === 'embedded' ? ref.source.hash : null);
      const base = r.grid?.bpm ?? null;
      let cuePoint = r.grid ? Math.max(0, r.grid.firstDownbeat) : 0;
      let hotCues: (number | null)[] = Array.from({ length: HOT_CUES }, () => null);
      const saved = r.hash && deps.cues ? await deps.cues.load(r.hash).catch(() => null) : null;
      if (stale()) return;
      if (saved) {
        cuePoint = saved.cuePoint;
        hotCues = Array.from({ length: HOT_CUES }, (_, i) => saved.hotCues[i] ?? null);
      }
      set(id, { loading: false, baseBpm: base, bpm: base, cuePoint, hotCues });
      refreshPins(id);
      // Park at the first beat so the first press of play starts on the one.
      seek(id, cuePoint);
      if (!a && !buffer && ref.source.kind === 'embedded') analyzeInBackground(id, ref, title, stale);
    } catch (e) {
      if (stale()) return;
      if (audioReady) {
        set(id, { loading: false });
        deps.toast(e instanceof Error ? e.message : String(e), 'error');
      } else {
        chan(id)?.send({ t: 'eject' });
        r.stream?.dispose();
        r.stream = null;
        set(id, blank(id));
        throw e;
      }
    }
  }

  /** Analyzes a song read by parts while it sits on the deck; the grid, tempo and cue point arrive when it is done (`applyAnalysis`). */
  function analyzeInBackground(id: DeckId, ref: SampleRef, title: string, stale: () => boolean) {
    const r = rt[id];
    const control = new AbortController();
    r.analyzing = control;
    set(id, { analyzing: 0 });
    deps
      .analysis(ref, {
        signal: control.signal,
        onProgress: (f) => {
          const pct = Math.floor(f * 100) / 100;
          if (!stale() && pct !== get(id).analyzing) set(id, { analyzing: pct });
        },
      })
      .then((a) => {
        if (stale()) return;
        r.analyzing = null;
        if (a) applyAnalysis(id, a);
        else set(id, { analyzing: null });
      })
      .catch((e: unknown) => {
        if (stale()) return;
        r.analyzing = null;
        set(id, { analyzing: null });
        if ((e as { name?: string } | null)?.name !== 'AbortError') deps.toast(`Couldn’t analyze “${title}”: ${e instanceof Error ? e.message : String(e)}`, 'error');
      });
  }

  /** A song's analysis arriving after it was loaded: the beat grid, its tempo, and the cue point if it was left at the start. */
  function applyAnalysis(id: DeckId, a: TrackAnalysis) {
    const r = rt[id];
    const d = get(id);
    r.analysis = a;
    r.grid = a.grid ? deckGridOf(a.grid) : null;
    const base = r.grid?.bpm ?? null;
    const patch: Partial<DeckState> = { analyzing: null, baseBpm: base, bpm: base === null ? null : base * (1 + d.pitch) };
    // The cue point is the first downbeat, unless the DJ has set it somewhere (or a saved one was found: those aren't at the start).
    const fromStart = r.grid && d.cuePoint === 0 && d.hotCues.every((c) => c === null);
    if (fromStart) patch.cuePoint = Math.max(0, r.grid!.firstDownbeat);
    set(id, patch);
    refreshPins(id);
    // A deck still parked at the start goes to the first beat, as a deck whose analysis was ready when it loaded does.
    if (fromStart && !d.playing && d.positionSec < 0.05) seek(id, get(id).cuePoint);
  }

  /**
   * The peak overview, filled a slice at a time (the page stays free): from the decoded buffer, or for a song read by
   * parts by reading it through once in its own rate, the overview growing as it goes. False if the deck loaded
   * something else meanwhile.
   */
  async function fillOverview(id: DeckId, source: DeckSource, buffer: AudioBuffer | null, stale: () => boolean): Promise<boolean> {
    const r = rt[id];
    const wave = newWaveform(source.nativeFrames, source.nativeRate);
    const st = { lp: 0 };
    if (buffer) {
      const chans = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c));
      const PER_SLICE = 4096;
      for (let b = 0; b < wave.buckets; b += PER_SLICE) {
        fillPeaks(wave, chans, b, b + PER_SLICE, st);
        if (b + PER_SLICE < wave.buckets) await yieldToMain();
        if (stale()) return false;
      }
      r.wave = wave;
      set(id, {}); // wake subscribers: the waveform is there
      return true;
    }
    // About 22 s of the song per read; the drawing is told every few reads.
    const PIECE_BUCKETS = 4096;
    const l = new Float32Array(PIECE_BUCKETS * PEAK_BUCKET);
    const rr = new Float32Array(PIECE_BUCKETS * PEAK_BUCKET);
    r.wave = wave;
    for (let b = 0, k = 0; b < wave.buckets; b += PIECE_BUCKETS, k++) {
      const start = b * PEAK_BUCKET;
      const n = Math.min(l.length, source.nativeFrames - start);
      await source.readNative(start, n, l, rr).catch(() => {});
      if (stale()) return false;
      fillPeaks(wave, source.channels === 2 ? [l.subarray(0, n), rr.subarray(0, n)] : [l.subarray(0, n)], b, b + PIECE_BUCKETS, st, start);
      if (k % 4 === 3 || b + PIECE_BUCKETS >= wave.buckets) set(id, {});
      await yieldToMain();
    }
    return true;
  }

  function stopDeck(id: DeckId) {
    const ch = chan(id);
    ch?.send({ t: 'play', on: false });
    ch?.send({ t: 'noloop' });
    ch?.send({ t: 'sync', sync: null });
    const r = rt[id];
    r.previewing = false;
    r.touching = false;
    touchHeld.delete(id);
    if (r.scratchTimer) clearTimeout(r.scratchTimer);
    r.scratchTimer = null;
  }

  function eject(id: DeckId) {
    rt[id].token++;
    for (const f of DECK_IDS) if (rt[f].syncMaster === id) unsync(f);
    stopDeck(id);
    chan(id)?.send({ t: 'eject' });
    forget(id);
    set(id, blank(id));
  }

  // ---- Transport ----

  function play(id: DeckId) {
    if (!loaded(id) || get(id).playing) {
      rt[id].previewing = false;
      return;
    }
    rt[id].previewing = false;
    void deps.resume().catch(() => {});
    chan(id)?.send({ t: 'play', on: true });
    set(id, { playing: true, positionAt: now() });
    startTicker();
  }

  function pause(id: DeckId) {
    if (!get(id).playing) return;
    rt[id].previewing = false;
    const pos = positionNow(id);
    chan(id)?.send({ t: 'play', on: false });
    set(id, { playing: false, positionSec: pos, positionAt: now() });
  }

  function togglePlay(id: DeckId) {
    if (get(id).playing) pause(id);
    else play(id);
  }

  function seek(id: DeckId, sec: number) {
    if (!loaded(id)) return;
    const to = Math.max(0, Math.min(durationOf(id), sec));
    // The window moves to where the playhead is going before the player is told (a song in memory needs no wait).
    rt[id].stream?.moveTo(to * sr());
    chan(id)?.send({ t: 'seek', pos: to * sr() });
    rt[id].seekAt = now();
    rt[id].seekTo = to;
    set(id, { positionSec: to, positionAt: now() });
    alignFollowersSoon(id);
  }

  /** The followers of a deck that jumped move to its beat once the jump has been heard. */
  function alignFollowersSoon(master: DeckId) {
    for (const f of DECK_IDS) {
      if (rt[f].syncMaster !== master || !get(f).playing) continue;
      setTimeout(() => chan(f)?.send({ t: 'align' }), 40);
    }
  }

  function cueDown(id: DeckId) {
    const d = get(id);
    if (!d.song) return;
    const plan = cuePressPlan({ playing: d.playing, positionSec: positionNow(id), cuePoint: d.cuePoint, grid: rt[id].grid });
    if (plan.setCue !== undefined) {
      set(id, { cuePoint: plan.setCue });
      saveCues(id);
      refreshPins(id);
    }
    if (plan.pause) {
      rt[id].previewing = false;
      chan(id)?.send({ t: 'play', on: false });
      set(id, { playing: false });
    }
    if (plan.seek !== undefined) seek(id, plan.seek);
    if (plan.preview) {
      play(id);
      rt[id].previewing = true;
    }
  }

  function cueUp(id: DeckId) {
    const r = rt[id];
    if (!r.previewing) return;
    r.previewing = false;
    chan(id)?.send({ t: 'play', on: false });
    set(id, { playing: false });
    seek(id, get(id).cuePoint);
  }

  function saveCues(id: DeckId) {
    const r = rt[id];
    if (!r.hash || !deps.cues) return;
    const d = get(id);
    deps.cues.save(r.hash, { cuePoint: d.cuePoint, hotCues: d.hotCues });
  }

  function hotCue(id: DeckId, i: number) {
    const d = get(id);
    if (!d.song || i < 0 || i >= HOT_CUES) return;
    const at = d.hotCues[i];
    if (at === null || at === undefined) {
      const pos = hotCuePosition(positionNow(id), rt[id].grid);
      const hotCues = d.hotCues.slice();
      hotCues[i] = Math.min(pos, d.song.durationSec);
      set(id, { hotCues });
      saveCues(id);
      refreshPins(id);
      return;
    }
    seek(id, at);
    if (!d.playing) play(id);
  }

  function clearHotCue(id: DeckId, i: number) {
    const d = get(id);
    if (i < 0 || i >= HOT_CUES || d.hotCues[i] === null) return;
    const hotCues = d.hotCues.slice();
    hotCues[i] = null;
    set(id, { hotCues });
    saveCues(id);
    refreshPins(id);
  }

  // ---- Jog ----

  function jog(id: DeckId, delta: number, mode: 'nudge' | 'scratch') {
    const d = get(id);
    const ch = chan(id);
    if (!d.song || !ch || !Number.isFinite(delta)) return;
    const r = rt[id];
    const t = now();
    const dt = r.jogAt > 0 && t - r.jogAt < 200 ? (t - r.jogAt) / 1000 : 0.016;
    r.jogAt = t;
    if (mode === 'scratch') {
      if (!r.touching) {
        // A drag without a touch event (a mouse, a controller that doesn't send one): hold for the drag.
        r.touching = true;
        ch.send({ t: 'scratch', on: true });
      }
      ch.send({ t: 'scratchRate', rate: scratchRate(delta, dt) });
      // The platter stops when it stops moving; a touch that ended without being told lets go a moment later.
      if (r.scratchTimer) clearTimeout(r.scratchTimer);
      r.scratchTimer = setTimeout(() => {
        chan(id)?.send({ t: 'scratchRate', rate: 0 });
        r.scratchTimer = setTimeout(() => {
          if (r.touching && !r.previewing && !touchHeld.has(id)) {
            r.touching = false;
            chan(id)?.send({ t: 'scratch', on: false });
            refreshPosition(id);
          }
        }, 400);
      }, 60);
    } else if (d.playing) {
      ch.send({ t: 'nudge', bend: nudgeBend(delta, dt) });
    } else {
      // Paused: the rim turns the song by hand, a revolution being REV_SEC.
      seek(id, positionNow(id) + delta * REV_SEC);
    }
  }

  function jogTouch(id: DeckId, touching: boolean) {
    const r = rt[id];
    const ch = chan(id);
    if (!get(id).song || !ch) return;
    if (touching) {
      touchHeld.add(id);
      r.touching = true;
      r.jogAt = 0;
      ch.send({ t: 'scratch', on: true });
      ch.send({ t: 'scratchRate', rate: 0 });
    } else {
      touchHeld.delete(id);
      if (r.scratchTimer) clearTimeout(r.scratchTimer);
      r.scratchTimer = null;
      r.touching = false;
      ch.send({ t: 'scratch', on: false });
      setTimeout(() => refreshPosition(id), 30);
      alignFollowersSoon(id);
    }
  }

  // ---- Pitch, key lock, sync ----

  function sendTempo(id: DeckId) {
    const d = get(id);
    chan(id)?.send({ t: 'tempo', rate: 1 + d.pitch, keyLock: d.keyLock });
  }

  function applyPitch(id: DeckId, pitch: number) {
    const d = get(id);
    const p = clampPitch(pitch, d.pitchRange);
    set(id, { pitch: p, bpm: d.baseBpm === null ? null : d.baseBpm * (1 + p) });
    sendTempo(id);
    updateFollowers(id);
  }

  function setPitch(id: DeckId, pitch: number) {
    if (rt[id].syncMaster) unsync(id);
    applyPitch(id, pitch);
  }

  function setPitchRange(id: DeckId, range: DeckState['pitchRange']) {
    set(id, { pitchRange: range });
    applyPitch(id, get(id).pitch);
  }

  function setKeyLock(id: DeckId, on: boolean) {
    set(id, { keyLock: on });
    sendTempo(id);
  }

  /** The tempo (BPM) a deck is playing at. */
  const bpmOf = (id: DeckId): number | null => {
    const d = get(id);
    return d.baseBpm === null ? null : d.baseBpm * (1 + d.pitch);
  };

  /** Followers keep their own pitch shown and sent in step with their master's. */
  function updateFollowers(master: DeckId) {
    const m = bpmOf(master);
    if (m === null) return;
    for (const f of DECK_IDS) {
      const r = rt[f];
      const d = get(f);
      if (r.syncMaster !== master || d.baseBpm === null) continue;
      const pitch = m / (d.baseBpm * r.syncMult) - 1;
      const range = rangeFor(pitch);
      if (range === null) {
        unsync(f);
        deps.toast(`Deck ${f} came out of sync: deck ${master}’s tempo is too far from its song’s.`, 'error');
        continue;
      }
      set(f, { pitch, pitchRange: Math.max(d.pitchRange, range) as DeckState['pitchRange'], bpm: m / r.syncMult });
      sendTempo(f);
      updateFollowers(f);
    }
  }

  /** The deck to follow: a playing deck that isn't itself following, else any playing deck, else any other loaded deck. */
  function pickMaster(id: DeckId): DeckId | null {
    const others = DECK_IDS.filter((x) => x !== id && get(x).song && rt[x].grid && x !== id);
    const free = (x: DeckId) => rt[x].syncMaster === null && rt[x].syncMaster !== id;
    return (
      others.find((x) => get(x).playing && free(x)) ??
      others.find((x) => get(x).playing && rt[x].syncMaster !== id) ??
      others.find((x) => rt[x].syncMaster !== id) ??
      null
    );
  }

  function syncSpecFor(id: DeckId): SyncSpec | null {
    const r = rt[id];
    const m = r.syncMaster;
    const mch = m ? chan(m) : null;
    const mg = m ? rt[m].grid : null;
    const fg = r.grid;
    if (!m || !mch || !mg || !fg) return null;
    const rate = sr();
    // A song with tracked beats (its tempo drifts) hands them over in frames: the player follows the beats it has.
    const inFrames = (g: DeckGrid) => (g.map && g.beats ? Float64Array.from(g.beats, (t) => t * rate) : undefined);
    const selfBeats = inFrames(fg);
    const masterBeats = inFrames(mg);
    return {
      master: mch.stateBuffer,
      ratio: mg.bpm / (fg.bpm * r.syncMult),
      selfFirst: fg.firstDownbeat * rate,
      selfBeat: (60 / (fg.bpm * r.syncMult)) * rate,
      masterFirst: mg.firstDownbeat * rate,
      masterBeat: (60 / mg.bpm) * rate,
      selfMult: r.syncMult,
      ...(selfBeats ? { selfBeats } : {}),
      ...(masterBeats ? { masterBeats } : {}),
    };
  }

  function sendSync(id: DeckId) {
    const ch = chan(id);
    const spec = syncSpecFor(id);
    if (ch && spec) ch.send({ t: 'sync', sync: spec });
  }

  function unsync(id: DeckId) {
    const r = rt[id];
    if (r.syncMaster === null && !get(id).synced) return;
    r.syncMaster = null;
    chan(id)?.send({ t: 'sync', sync: null });
    set(id, { synced: false });
  }

  function sync(id: DeckId, on?: boolean) {
    const d = get(id);
    const want = on ?? !d.synced;
    if (!want) return unsync(id);
    const r = rt[id];
    if (!d.song || !r.grid || d.baseBpm === null) {
      deps.toast(`Deck ${id} has no steady beat to sync (its song wasn’t analyzed, or has no clear tempo).`, 'error');
      return;
    }
    const m = pickMaster(id);
    if (!m) {
      deps.toast('Load a second song on another deck to sync to.', 'error');
      return;
    }
    const mBpm = bpmOf(m);
    if (mBpm === null) return;
    const plan = syncPlan(mBpm, d.baseBpm);
    const range = rangeFor(plan.pitch);
    if (range === null) {
      deps.toast(`Deck ${id}’s song is too far from deck ${m}’s tempo to sync (more than 50% apart).`, 'error');
      return;
    }
    r.syncMaster = m;
    r.syncMult = plan.multiple;
    set(id, { synced: true, pitch: plan.pitch, pitchRange: Math.max(d.pitchRange, range) as DeckState['pitchRange'], bpm: mBpm / plan.multiple });
    sendTempo(id);
    sendSync(id);
    // Playing next to a playing master: land on its beat now.
    if (d.playing && get(m).playing) chan(id)?.send({ t: 'align' });
    updateFollowers(id);
  }

  // ---- Mixer ----

  function setVolume(id: DeckId, v: number) {
    const x = Math.max(0, Math.min(FADER_MAX, Number.isFinite(v) ? v : 0));
    set(id, { volume: x });
    chan(id)?.setFader(x);
  }
  function setTrim(id: DeckId, db: number) {
    const x = clampTrim(db);
    set(id, { trimDb: x });
    chan(id)?.setTrim(x);
  }
  function setEq(id: DeckId, band: EqBand, db: number) {
    const x = clampEq(db);
    set(id, { eq: { ...get(id).eq, [band]: x } });
    chan(id)?.setEq(band, x);
  }
  function setFilter(id: DeckId, v: number) {
    const x = Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0));
    set(id, { filter: x });
    chan(id)?.setFilter(x);
  }
  function setCueListen(id: DeckId, on: boolean) {
    set(id, { cueListen: on });
    chan(id)?.setCueListen(on);
  }
  function applyCrossfade() {
    const s = store.getState();
    for (const id of DECK_IDS) chan(id)?.setCrossfade(s.crossfaderAssign[id], s.crossfader, s.crossfaderCurve);
  }
  function cancelFade() {
    if (fadeTimer) clearInterval(fadeTimer);
    fadeTimer = null;
  }
  function setCrossfader(v: number) {
    cancelFade();
    store.setState({ crossfader: Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0)) });
    applyCrossfade();
  }
  function setCrossfaderAssign(id: DeckId, side: 'A' | 'B' | 'thru') {
    store.setState((s) => ({ crossfaderAssign: { ...s.crossfaderAssign, [id]: side } }));
    applyCrossfade();
  }
  function setMasterVolume(v: number) {
    const x = Math.max(0, Math.min(1.5, Number.isFinite(v) ? v : 1));
    store.setState({ masterVolume: x });
    graph?.setMasterVolume(x);
  }
  function crossfade(to: number, beats: number) {
    const target = Math.max(-1, Math.min(1, to));
    const playing = DECK_IDS.filter((id) => get(id).playing);
    const bpm = bpmOf(playing[0] ?? DECK_IDS.find((id) => get(id).song) ?? 'A') ?? 120;
    const total = (Math.max(0, beats) * 60) / bpm;
    cancelFade();
    const from = store.getState().crossfader;
    if (total < 0.03) return setCrossfader(target);
    const t0 = now();
    fadeTimer = setInterval(() => {
      const t = Math.min(1, (now() - t0) / 1000 / total);
      store.setState({ crossfader: crossfadeAt(from, target, t) });
      applyCrossfade();
      if (t >= 1) cancelFade();
    }, 20);
  }

  // ---- Loops ----

  const loopOf = (id: DeckId) => get(id).loop;

  function setLoopState(id: DeckId, loop: DeckState['loop']) {
    set(id, { loop });
    // The loop's audio stays in the window while it is on (before the player is told, so it never waits for it).
    refreshPins(id);
    if (loop?.active) sendLoop(id, loop.startSec, loop.endSec);
    else chan(id)?.send({ t: 'noloop' });
  }

  function loopIn(id: DeckId) {
    if (!loaded(id)) return;
    const at = snapToGrid(positionNow(id), rt[id].grid, 0.25);
    set(id, { loop: { startSec: Math.max(0, at), endSec: Math.max(0, at), active: false } });
    refreshPins(id);
    chan(id)?.send({ t: 'noloop' });
  }

  function loopOut(id: DeckId) {
    const l = loopOf(id);
    if (!loaded(id)) return;
    if (!l) return loopIn(id);
    if (l.active) return exitLoop(id);
    if (l.endSec > l.startSec) return setLoopState(id, { ...l, active: true }); // reloop
    const span = manualLoopSpan(l.startSec, positionNow(id), rt[id].grid);
    setLoopState(id, { ...span, active: true });
  }

  function autoLoop(id: DeckId, beats: number) {
    if (!loaded(id)) return;
    const l = loopOf(id);
    const grid = rt[id].grid;
    // Pressing the size that is looping already lets go of it.
    if (l?.active && Math.abs(loopBeats(l, grid) - beats) < 1e-6) return exitLoop(id);
    const span = autoLoopSpan(positionNow(id), beats, grid);
    const end = Math.min(durationOf(id), span.endSec);
    setLoopState(id, { startSec: span.startSec, endSec: end, active: true });
  }

  function resize(id: DeckId, factor: 0.5 | 2) {
    const l = loopOf(id);
    if (!l || l.endSec <= l.startSec) return;
    const span = resizeLoop(l, factor, rt[id].grid, durationOf(id));
    setLoopState(id, { ...span, active: l.active });
  }

  function exitLoop(id: DeckId) {
    const l = loopOf(id);
    if (!l?.active) return;
    setLoopState(id, { ...l, active: false });
  }

  function beatJumpBy(id: DeckId, beats: number) {
    if (!loaded(id)) return;
    const pos = positionNow(id);
    const to = beatJumpTarget(pos, beats, rt[id].grid, durationOf(id));
    const l = loopOf(id);
    // A loop that is on moves with the jump.
    if (l?.active) setLoopState(id, { ...shiftLoop(l, to - pos, durationOf(id)), active: true });
    seek(id, to);
  }

  // ---- Recording ----

  async function startRecording(): Promise<void> {
    if (capture || store.getState().recording) return;
    const g = await ensureGraph();
    await deps.resume().catch(() => {});
    const parts: Uint8Array[] = [];
    const enc = new WavStreamEncoder(2, g.ctx.sampleRate, { bitDepth: 16, dither: true, seed: 1 });
    const rec = { cap: null as unknown as TapCapture, parts, enc, frames: 0 };
    rec.cap = await g.openCapture((ch) => {
      parts.push(enc.push(ch));
      rec.frames += ch[0].length;
    });
    capture = rec;
    store.setState({ recording: { startedAt: now() } });
  }

  async function stopRecording(): Promise<string | null> {
    const rec = capture;
    if (!rec) return null;
    capture = null;
    store.setState({ recording: null });
    const info = await rec.cap.stop(0.05);
    if (info.frames === 0) return null;
    const header = rec.enc.header(info.frames);
    const trailer = rec.enc.trailer();
    const title = liveMixTitle(new Date());
    const file = new File([header as BlobPart, ...(rec.parts as BlobPart[]), trailer as BlobPart], `${title}.wav`, { type: 'audio/wav' });
    return deps.addRecording(file, title);
  }

  // ---- Misc ----

  function setDeckCount(count: 2 | 4) {
    store.setState({ deckCount: count });
  }

  async function setCueDevice(deviceId: string): Promise<boolean> {
    cueDevice = deviceId;
    try {
      globalThis.localStorage?.setItem('agstudio.dj.cueDevice', deviceId);
    } catch {
      /* storage unavailable */
    }
    const g = graph ?? (loadedAny() ? await ensureGraph().catch(() => null) : null);
    return g ? g.setCueOutput(deviceId) : true;
  }
  const loadedAny = () => DECK_IDS.some(loaded);

  function dispose() {
    if (disposed) return;
    disposed = true;
    offHost();
    cancelFade();
    if (ticker) clearInterval(ticker);
    ticker = null;
    capture?.cap.cancel();
    capture = null;
    for (const id of DECK_IDS) {
      stopDeck(id);
      rt[id].token++;
      rt[id].stream?.dispose();
      rt[id].stream = null;
    }
    graph?.dispose();
    graph = null;
    store.setState(initialDecksState());
  }

  const api: DecksApi = {
    store,
    load,
    eject,
    play,
    pause,
    togglePlay,
    cueDown,
    cueUp,
    seek,
    jog,
    jogTouch,
    setPitch,
    setPitchRange,
    setKeyLock,
    sync,
    setVolume,
    setTrim,
    setEq,
    setFilter,
    setCueListen,
    setCrossfader,
    setCrossfaderAssign,
    setMasterVolume,
    hotCue,
    clearHotCue,
    loopIn,
    loopOut,
    autoLoop,
    loopHalve: (id) => resize(id, 0.5),
    loopDouble: (id) => resize(id, 2),
    exitLoop,
    beatJumpBy,
    startRecording,
    stopRecording,
    positionNow,
    dispose,
    setCrossfaderCurve(curve) {
      store.setState({ crossfaderCurve: curve });
      applyCrossfade();
    },
    setDeckCount,
    setBeatJump(id, beats) {
      set(id, { beatJump: Math.max(1, Math.min(32, Math.round(beats))) });
    },
    crossfade,
    readLevels(out) {
      if (graph) graph.readLevels(out);
      else out.fill(0);
    },
    waveformOf: (id) => rt[id].wave,
    analysisOf: (id) => rt[id].analysis,
    setCueDevice,
    keepUp: () => keepUpValue,
    isStalled,
    settled: async () => {
      // Every deck's window has what is about to be heard (a source read from a file takes a moment after a jump), then the players
      // have handled everything sent.
      for (const id of DECK_IDS) {
        const stream = rt[id].stream;
        if (!stream || !get(id).song) continue;
        const at = Math.round(get(id).positionSec * stream.sampleRate);
        await stream.whenResident(at - Math.round(0.5 * stream.sampleRate), at + 4 * stream.sampleRate).catch(() => {});
      }
      await graph?.settled();
    },
  };
  return api;
}
