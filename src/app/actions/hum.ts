/**
 * Hum to notes: record a sung or hummed line over the beat (count-in first) and turn it into piano
 * roll notes on a channel: the voice analysis finds the notes and their pitch (YIN), the grid
 * quantizer places them, and the take is written as one undo step. Works offline (no AI).
 */
import { analyzeVoice, quantizeToGrid } from '@core/voice';
import { newId } from '@core/model/ids';
import type { ChannelId, Note, PatternId } from '@core/model/types';
import { addNotes } from '@core/ops/notes';
import { TICKS_PER_STEP } from '@core/time/ppq';
import type { RecordingHandle } from '@engine/api';
import { openMic, type MicInput } from '@platform/mic';
import type { Services } from '../services';

export interface HumOptions {
  channelId: ChannelId;
  patternId: PatternId;
  bars: number;
  /** Play the pattern while humming (echo cancellation keeps it out of the take). */
  playAlong: boolean;
}

export type HumResult = { notes: number } | { error: string };

let active: { handle: RecordingHandle; mic: MicInput } | null = null;

/** Stops a running hum recording early (keeps what was sung). */
export function stopHumming(): void {
  active?.handle.stop();
}

export function isHumming(): boolean {
  return active !== null;
}

export async function humToNotes(s: Services, opts: HumOptions): Promise<HumResult> {
  if (active) return { error: 'Already recording.' };
  const project = s.doc.getState().project;
  const ts = project.transport.timeSig;
  const bpm = project.transport.bpm;
  let mic: MicInput;
  try {
    mic = await openMic({ ...s.audioInput.micOptions(), echoCancellation: opts.playAlong });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  try {
    if (opts.playAlong) s.view.getState().setMode('pattern');
    const handle = await s.engine.record(mic.stream, {
      bpm,
      beatsPerBar: ts.num,
      countInBeats: ts.num,
      bars: opts.bars,
      click: true,
      ...s.audioInput.performanceLatency(mic.latency),
      playAlong: opts.playAlong,
    });
    active = { handle, mic };
    const rec = await handle.done;
    const raw = analyzeVoice(rec.samples, rec.sampleRate, { mode: 'tonal' });
    const events = quantizeToGrid(raw, { bpm, startSec: rec.barOneSec, bars: opts.bars }, { resolution: 0.5 }).filter(
      (e) => e.pitch !== null,
    );
    if (events.length === 0)
      return { error: "I couldn't hear a melody. Try again a little louder or closer to the mic." };
    const notes: Note[] = events.map((e) => ({
      id: newId.note(),
      tick: Math.round(e.step * TICKS_PER_STEP),
      length: Math.max(60, Math.round(e.lengthSteps * TICKS_PER_STEP)),
      key: Math.max(0, Math.min(127, Math.round(e.pitch as number))),
      velocity: Math.max(0.4, Math.min(1, 0.5 + e.strength / 2)),
    }));
    s.history.transact('Hum to notes', (d) => addNotes(d, opts.patternId, opts.channelId, notes));
    return { notes: notes.length };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return { error: 'Cancelled.' };
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    active = null;
    mic.close();
  }
}
