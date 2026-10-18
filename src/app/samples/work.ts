/**
 * Sample work the Studio asks for (`place_sample`, `make_kit`): checked when the answer is read, done after it is applied
 * because reading a file and storing its audio takes time. Each piece is folded into the answer's undo step.
 */
import type { ChannelId, LaneId, Tick } from '@core/model/types';
import type { Services } from '../services';
import { addRowAsClip, addRowsAsChannels, loadRowOnPad, makeKitFromRows } from './actions';
import type { BrowserRow } from './browser';

export type SampleWork =
  | {
      kind: 'place';
      /** The row's id (resolved when the answer was read). */
      row: string;
      to: 'channel' | 'clip' | 'pad';
      /** clip: where (1-based track and tick); a loop follows the song tempo unless `followTempo` is false. */
      track?: number;
      start?: Tick;
      followTempo?: boolean;
      /** pad: the Drum Pads channel and pad (1–16). */
      channel?: ChannelId;
      pad?: number;
    }
  | { kind: 'kit'; rows: string[]; name?: string };

export interface WorkResult {
  changes: string[];
  warnings: string[];
}

/** Does the work in order; `entry` is the answer's undo entry (null until something is edited), and the entry that holds the edits comes back. */
export async function runSampleWork(s: Services, work: readonly SampleWork[], entry: number | null): Promise<WorkResult & { entry: number | null }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const rowOf = (id: string): BrowserRow | undefined => s.sampleBrowser.rowById(id);
  let current = entry;
  const edit = () => (current !== null ? { amend: current } : {});
  const after = (before: number) => {
    const cursor = s.history.status().cursor;
    if (current === null && cursor !== before) current = cursor;
  };
  for (const w of work) {
    const before = s.history.status().cursor;
    if (w.kind === 'kit') {
      const rows = w.rows.map(rowOf).filter((r): r is BrowserRow => !!r);
      const res = await makeKitFromRows(s, rows, w.name, edit());
      after(before);
      if (!res.channelId) warnings.push('make_kit: no pad got a sound (the sounds must be analyzed one-shots)');
      else {
        changes.push(`Made a Drum Pads kit “${(s.doc.getState().project.channels[res.channelId]?.name ?? 'Kit')}”: ${res.placed.map((p) => `pad ${p.pad} ${p.name}`).join(', ')}`);
        for (const sk of res.plan.skipped) warnings.push(`make_kit: left out ${sk.row.name} (${sk.why})`);
      }
      continue;
    }
    const row = rowOf(w.row);
    if (!row) {
      warnings.push('place_sample: that sound is no longer in the sample folders');
      continue;
    }
    if (w.to === 'channel') {
      const ids = await addRowsAsChannels(s, [row], edit());
      after(before);
      if (ids.length) changes.push(`Added “${row.name}” as a sampler channel`);
    } else if (w.to === 'clip') {
      const p = s.doc.getState().project;
      const lane: LaneId | null = w.track !== undefined ? (p.playlist.laneOrder[w.track - 1] ?? null) : null;
      const id = await addRowAsClip(s, row, { ...(w.start !== undefined ? { startTick: w.start } : {}), laneId: lane, ...(w.followTempo === false ? { followTempo: false } : {}), ...edit() });
      after(before);
      if (id) changes.push(`Put “${row.name}” on the playlist${row.analysis?.kind === 'loop' && row.analysis.bpm && w.followTempo !== false ? ` (a ${row.analysis.bpm} BPM loop that follows the song tempo)` : ''}`);
    } else {
      const ok = w.channel && w.pad ? await loadRowOnPad(s, row, w.channel, w.pad, edit()) : false;
      after(before);
      if (ok) changes.push(`Loaded “${row.name}” on pad ${w.pad} of ${s.doc.getState().project.channels[w.channel as ChannelId]?.name ?? 'the kit'}`);
      else warnings.push(`place_sample: “${row.name}” could not be loaded on that pad`);
    }
  }
  return { changes, warnings, entry: current };
}
