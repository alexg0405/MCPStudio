import { produce } from 'immer';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import type { ChannelId, ClipId, LaneId, NoteId, PatternId, Project } from '@core/model/types';
import { addChannel } from '@core/ops/channels';
import { addNote } from '@core/ops/notes';
import { addClips } from '@core/ops/playlist';
import { defaultValues, defineWorkletInstrument, p, type PluginDef } from '@agstudio/sdk';
import processor from '../browser/tone.worklet.ts?worker&url';

// Browser tests only (the worklet module needs an AudioContext).

/** A 1 kHz sine at 0.25 × level while a note is held (bit-exact worklet kernel). */
export const tone = defineWorkletInstrument({
  id: 'test.tone',
  name: 'Tone',
  version: 1,
  params: { level: p.float(0, 1, 1) },
  processor,
  tailTime: 0.05,
}) as PluginDef;

/** Seeded white noise at 0.25 while a note is held. */
export const noise = defineWorkletInstrument({
  id: 'test.noise',
  name: 'Noise',
  version: 1,
  params: {},
  processor,
  tailTime: 0.05,
}) as PluginDef;

/**
 * One channel holding notes through `bars` bars of song (a pattern clip on track 1): one long note,
 * or back-to-back notes of `every` ticks (playback started inside a note doesn't play it).
 */
export function heldNote(
  def: PluginDef,
  bars: number,
  bpm = 120,
  every = bars * 3840,
): { project: Project; pid: PatternId; ch: ChannelId } {
  let project = createEmptyProject();
  const pid = project.patternOrder[0] as PatternId;
  const ch = makeInstrumentChannel(def.name, makePluginInstance(def.id, def.version, defaultValues(def.params)));
  project = produce(project, (d) => {
    d.transport.bpm = bpm;
    addChannel(d, ch);
    d.patterns[pid]!.length = bars * 3840;
    for (let t = 0, i = 0; t < bars * 3840; t += every, i++)
      addNote(d, pid, ch.id, { id: `n${i}` as NoteId, tick: t, length: every, key: 60, velocity: 1 });
    addClips(d, [
      {
        kind: 'pattern',
        id: 'c0' as ClipId,
        laneId: d.playlist.laneOrder[0] as LaneId,
        start: 0,
        length: bars * 3840,
        patternId: pid,
        offset: 0,
      },
    ]);
  });
  return { project, pid, ch: ch.id };
}
