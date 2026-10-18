/**
 * What you do with a sound of the sample browser: audition it, put it in the project (a sampler channel, an audio clip, a
 * Drum Pads pad) or make a Drum Pads kit from several. Each placement is one undoable edit; auditioning and favorites are
 * not part of the project. The window, its menus and the Studio's `place_sample` / `make_kit` all come through here.
 */
import type { ChannelId, ClipId, LaneId, SampleRef, Tick } from '@core/model/types';
import { addChannel, addSample } from '@core/ops/channels';
import { padSlot, planKit, type KitPlan } from '@core/samples/kit';
import { previewPlan } from '@core/samples/preview';
import { addAudioClip, addSampleChannels, importAudioFile, setPluginSlotSample } from '../actions/samples';
import { instrumentChannelFor } from '../default-project';
import type { Services } from '../services';
import type { BrowserRow } from './browser';

/** The Drum Pads' plugin id (the plugin lives in `plugins/builtin`, which the app does not import). */
export const DRUM_PADS_ID = 'agstudio.drum-pads';

let previewSeq = 0;
let previewTimer: ReturnType<typeof setTimeout> | null = null;

/** The file of a row, or null (with a toast) when it can no longer be read. */
async function fileOf(s: Services, row: BrowserRow): Promise<File | null> {
  try {
    return await row.handle.getFile();
  } catch (e) {
    s.session.getState().toast(`Can't read "${row.name}": ${e instanceof Error ? e.message : String(e)}`, 'error');
    return null;
  }
}

/** Stops the audition. */
export function stopPreviewRow(s: Services): void {
  previewSeq++;
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = null;
  s.engine.stopPreview();
  s.sampleBrowser.setPlaying(null);
}

/**
 * Auditions a row through the engine's preview bus. Loops play at the project tempo (stretched or resampled, as set) from the
 * next beat while the song plays and repeat until the next sound or a stop; a tonal sound can be moved to the song key.
 * With `toggle`, a row that is playing is stopped instead.
 */
export async function previewRow(s: Services, row: BrowserRow, opts: { toggle?: boolean } = {}): Promise<boolean> {
  const browser = s.sampleBrowser;
  const st = browser.store.getState();
  if (opts.toggle && st.playing === row.id) {
    stopPreviewRow(s);
    return true;
  }
  const seq = ++previewSeq;
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = null;
  browser.setPlaying(row.id);
  const file = await fileOf(s, row);
  if (!file) {
    if (seq === previewSeq) browser.setPlaying(null);
    return false;
  }
  const transport = s.doc.getState().project.transport;
  const plan = previewPlan(row.analysis, st, { bpm: transport.bpm, ...(transport.key ? { key: transport.key } : {}) });
  s.engine.setPreviewVolume(st.volume);
  const ok = await s.engine.previewAudio(await file.arrayBuffer(), plan.opts).catch(() => false);
  if (!ok) {
    s.session.getState().toast(`Can't play "${row.name}"`, 'error');
    if (seq === previewSeq) browser.setPlaying(null);
    return false;
  }
  // A one-shot clears its highlight when it has played (a loop plays until it is stopped).
  if (seq === previewSeq && !plan.opts.loop) {
    const seconds = (row.analysis?.durationSec ?? 1) / (plan.opts.rate ?? 1);
    previewTimer = setTimeout(() => {
      if (seq === previewSeq) browser.setPlaying(null);
    }, Math.min(15, seconds + 0.3) * 1000);
  }
  return true;
}

/** A row as a sample of the project (stored once by content), or null with a toast. */
export async function sampleRefOf(s: Services, row: BrowserRow): Promise<SampleRef | null> {
  const file = await fileOf(s, row);
  return file ? importAudioFile(s, file) : null;
}

/** Sampler channels for rows (one undo step), after the selected channel. */
export async function addRowsAsChannels(s: Services, rows: readonly BrowserRow[]): Promise<ChannelId[]> {
  const refs: SampleRef[] = [];
  const used: string[] = [];
  for (const r of rows) {
    const ref = await sampleRefOf(s, r);
    if (ref) {
      refs.push(ref);
      used.push(r.id);
    }
  }
  if (refs.length === 0) return [];
  s.sampleBrowser.markUsed(used);
  return addSampleChannels(s, refs);
}

/**
 * An audio clip on the playlist for a row, at `startTick` (default: the song position marker) on `laneId` (default: the first
 * track with room). A loop with a tempo follows the song tempo and lasts its bars.
 */
export async function addRowAsClip(
  s: Services,
  row: BrowserRow,
  opts: { startTick?: Tick; laneId?: LaneId | null; followTempo?: boolean } = {},
): Promise<ClipId | null> {
  const ref = await sampleRefOf(s, row);
  if (!ref) return null;
  const a = row.analysis;
  const follow = opts.followTempo !== false && a?.kind === 'loop' && a.bpm ? { followBpm: a.bpm, ...(a.bars ? { bars: a.bars } : {}) } : {};
  const start = opts.startTick ?? s.view.getState().songStart;
  s.sampleBrowser.markUsed([row.id]);
  return addAudioClip(s, ref, opts.laneId ?? null, start, follow);
}

/** Puts a row on one pad (1–16) of a Drum Pads channel (one undo step). */
export async function loadRowOnPad(s: Services, row: BrowserRow, channelId: ChannelId, pad: number): Promise<boolean> {
  if (!Number.isInteger(pad) || pad < 1 || pad > 16) return false;
  const ch = s.doc.getState().project.channels[channelId];
  if (!ch || ch.kind !== 'instrument' || ch.plugin.pluginId !== DRUM_PADS_ID) return false;
  const ref = await sampleRefOf(s, row);
  if (!ref) return false;
  setPluginSlotSample(s, { kind: 'channel', channelId }, padSlot(pad), ref);
  s.sampleBrowser.markUsed([row.id]);
  return true;
}

export interface KitResult {
  channelId: ChannelId | null;
  plan: KitPlan;
  /** Pad number and name for each pad that got a sound. */
  placed: { pad: number; name: string }[];
}

/**
 * A Drum Pads channel whose pads are the rows' one-shots, laid out like the default kit (kick on pad 1, snare 3, clap 4, hats 7
 * and 9, open hat 11, toms on the left, cymbals at the end). One undo step; pads without a sound keep their built-in drum.
 */
export async function makeKitFromRows(s: Services, rows: readonly BrowserRow[], name?: string): Promise<KitResult> {
  const plan = planKit(rows);
  const def = s.plugins.get(DRUM_PADS_ID);
  const empty: KitResult = { channelId: null, plan, placed: [] };
  if (!def || plan.pads.every((p) => p === null)) return empty;
  const refs = new Map<number, SampleRef>();
  const used: string[] = [];
  for (let i = 0; i < plan.pads.length; i++) {
    const row = plan.pads[i] as BrowserRow | null;
    if (!row) continue;
    const ref = await sampleRefOf(s, row);
    if (ref) {
      refs.set(i + 1, ref);
      used.push(row.id);
    }
  }
  if (refs.size === 0) return empty;
  const project = s.doc.getState().project;
  const samples = Object.fromEntries([...refs].map(([pad, ref]) => [padSlot(pad), ref.id]));
  const firstFolder = (plan.pads.find((p) => p) as BrowserRow | undefined)?.folder;
  const channel = instrumentChannelFor(def, (name ?? (firstFolder ? `${firstFolder} kit` : 'Kit')).slice(0, 64), project.channelOrder.length, samples);
  const sel = s.session.getState().selectedChannelId;
  const at = sel ? project.channelOrder.indexOf(sel) + 1 : project.channelOrder.length;
  s.history.transact(`Make a kit from ${refs.size} sample${refs.size === 1 ? '' : 's'}`, (d) => {
    for (const ref of refs.values()) addSample(d, ref);
    addChannel(d, channel, at);
  });
  s.session.getState().selectChannel(channel.id);
  s.sampleBrowser.markUsed(used);
  return { channelId: channel.id, plan, placed: [...refs].map(([pad, ref]) => ({ pad, name: ref.name })) };
}
