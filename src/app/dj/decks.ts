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
import { fillPeaks, newWaveform, type DeckWaveform } from '@core/dj/deck-peaks';
import type { TrackAnalysis } from '@core/dj/types';
import { WavStreamEncoder } from '@core/io/wav';
import type { SampleRef } from '@core/model/types';
import type { DeckHost } from '@engine/api';
import { yieldToMain } from '@engine/audio-buffers';
import { DeckGraph, songDataOf, type DeckSongData } from '@engine/deck/deck-graph';
import type { SyncSpec } from '@engine/deck/deck-id';
import type { TapCapture } from '@engine/deck/tap-capture';
import type { SampleCache } from '@engine/samples';
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
  /** The song's analysis: cached, or computed now. Null when it can't be analyzed. */
  analysis(ref: SampleRef): Promise<TrackAnalysis | null>;
  peekAnalysis(ref: SampleRef): TrackAnalysis | null;
  /** Puts a recording in the music library; resolves with its title. */
  addRecording(file: File, title: string): Promise<string | null>;
  toast(message: string, kind?: 'error'): void;
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
  data: DeckSongData | null;
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
}

const emptyRt = (): Rt => ({
  analysis: null,
  grid: null,
  wave: null,
  data: null,
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
});

/** The longest song a deck takes: it is held in memory, decoded (15 minutes of stereo at 48 kHz is ~350 MB). */
export const MAX_DECK_SONG_SEC = 20 * 60;
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
      if (!d.song || !r.data) continue;
      if (r.data.sampleRate !== g.ctx.sampleRate) {
        // The new context runs at another rate: decode the song again for it.
        const pos = old ? (old.channel(idx(id)).snapshot().pos / r.data.sampleRate) : d.positionSec;
        set(id, { positionSec: pos, positionAt: now() });
        void reloadFor(id, g);
        continue;
      }
      const pos = old ? old.channel(idx(id)).snapshot().pos : d.positionSec * g.ctx.sampleRate;
      sendSong(id, r.data, pos);
    }
    // Followers need the new masters' state blocks.
    for (const id of DECK_IDS) if (rt[id].syncMaster) sendSync(id);
    startTicker();
  }

  function sendSong(id: DeckId, data: DeckSongData, posFrames: number) {
    const ch = chan(id);
    if (!ch) return;
    const d = get(id);
    ch.send({ t: 'song', channels: data.channels, frames: data.frames, sampleRate: data.sampleRate });
    ch.send({ t: 'tempo', rate: 1 + d.pitch, keyLock: d.keyLock });
    ch.send({ t: 'seek', pos: posFrames });
    if (d.loop?.active) sendLoop(id, d.loop.startSec, d.loop.endSec);
    if (d.playing) ch.send({ t: 'play', on: true });
  }

  async function reloadFor(id: DeckId, g: DeckGraph) {
    const d = get(id);
    if (!d.song) return;
    const token = ++rt[id].token;
    const buffer = await deps.cache.load(d.song.ref, g.ctx);
    if (!buffer || token !== rt[id].token || disposed) return;
    const data = await songDataOf(buffer);
    if (token !== rt[id].token || disposed) return;
    rt[id].data = data;
    sendSong(id, data, get(id).positionSec * data.sampleRate);
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
    r.data = null;
    r.hash = null;
    r.syncMaster = null;
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
      const buffer = await deps.cache.load(ref, g.ctx);
      if (stale()) return;
      if (!buffer) throw new Error(`Couldn’t read “${title}” (it may have been removed from the library).`);
      if (buffer.duration > MAX_DECK_SONG_SEC)
        throw new Error(`“${title}” is longer than ${MAX_DECK_SONG_SEC / 60} minutes: a deck keeps its whole song in memory, so it can’t take that.`);
      const data = await songDataOf(buffer);
      if (stale()) return;
      r.data = data;
      audioReady = true;
      set(id, { song: { ...info, durationSec: buffer.length / buffer.sampleRate } });
      chan(id)?.send({ t: 'song', channels: data.channels, frames: data.frames, sampleRate: data.sampleRate });
      chan(id)?.send({ t: 'tempo', rate: 1, keyLock: get(id).keyLock });
      // The waveform and the analysis arrive while the song can already be played.
      const wave = newWaveform(buffer.length, buffer.sampleRate);
      const chans = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c));
      const st = { lp: 0 };
      const PER_SLICE = 4096;
      for (let b = 0; b < wave.buckets; b += PER_SLICE) {
        fillPeaks(wave, chans, b, b + PER_SLICE, st);
        if (b + PER_SLICE < wave.buckets) await yieldToMain();
        if (stale()) return;
      }
      r.wave = wave;
      set(id, {}); // wake subscribers: the waveform is there
      const a = deps.peekAnalysis(ref) ?? (await deps.analysis(ref).catch(() => null));
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
      // Park at the first beat so the first press of play starts on the one.
      seek(id, cuePoint);
    } catch (e) {
      if (stale()) return;
      if (audioReady) {
        set(id, { loading: false });
        deps.toast(e instanceof Error ? e.message : String(e), 'error');
      } else {
        chan(id)?.send({ t: 'eject' });
        set(id, blank(id));
        throw e;
      }
    }
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
    if (loop?.active) sendLoop(id, loop.startSec, loop.endSec);
    else chan(id)?.send({ t: 'noloop' });
  }

  function loopIn(id: DeckId) {
    if (!loaded(id)) return;
    const at = snapToGrid(positionNow(id), rt[id].grid, 0.25);
    set(id, { loop: { startSec: Math.max(0, at), endSec: Math.max(0, at), active: false } });
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
    settled: async () => void (await graph?.settled()),
  };
  return api;
}
