import { SCALES } from '@agstudio/sdk/notes';
import type { ChannelId, Project } from '@core/model/types';
import type { AuditionPhrase } from '../ai/apply';
import type { Services } from '../services';

/**
 * Auditioning a sound: a short phrase on a channel through the preview path (nothing is written to
 * the project), so the musician hears what the AI made. In the song's key when it has one.
 */
export interface PhraseNote {
  /** Seconds from the start. */
  at: number;
  dur: number;
  key: number;
  velocity: number;
}

/** The scale degree's semitone above the tonic (degree 0 = tonic; wraps into higher octaves). */
function degree(intervals: readonly number[], d: number): number {
  const n = intervals.length;
  const oct = Math.floor(d / n);
  return (intervals[((d % n) + n) % n] as number) + 12 * oct;
}

const DRUM_PLUGINS = new Set(['agstudio.drum-pads', 'agstudio.drum-synth']);

export function phraseNotes(project: Project, channelId: ChannelId, phrase: AuditionPhrase): PhraseNote[] {
  const beat = 60 / Math.max(40, Math.min(220, project.transport.bpm));
  const key = project.transport.key;
  const intervals = SCALES.find((x) => x.id === key?.scale)?.intervals ?? SCALES[0]!.intervals;
  const tonic = key?.root ?? 0;
  const ch = project.channels[channelId];
  const at = (octaveC: number, d: number) => octaveC + tonic + degree(intervals, d);
  switch (phrase) {
    case 'chord': {
      // The tonic chord with its seventh, held, around middle C.
      const root = 48 + tonic;
      return [0, 2, 4, 6].map((d) => ({ at: 0, dur: beat * 3, key: root + degree(intervals, d), velocity: 0.75 }));
    }
    case 'riff':
      return [0, 2, 4, 7, 4, 2, 0, 4].map((d, i) => ({ at: i * beat * 0.5, dur: beat * 0.45, key: at(60, d), velocity: 0.8 }));
    case 'bass':
      return [
        { at: 0, dur: beat, key: at(36, 0), velocity: 0.9 },
        { at: beat * 1.5, dur: beat * 0.5, key: at(36, 0), velocity: 0.75 },
        { at: beat * 2, dur: beat * 0.5, key: at(36, 4), velocity: 0.8 },
        { at: beat * 2.5, dur: beat * 1.5, key: at(36, 0), velocity: 0.85 },
      ];
    case 'hits': {
      // Kit instruments: kick, hat, snare on the General MIDI keys; a one-sound channel plays its own key.
      if (ch?.kind === 'instrument' && DRUM_PLUGINS.has(ch.plugin.pluginId)) {
        const pattern = [36, 42, 38, 42, 36, 36, 38, 42];
        return pattern.map((k, i) => ({ at: i * beat * 0.5, dur: beat * 0.25, key: k, velocity: i % 2 ? 0.6 : 0.9 }));
      }
      const root = ch && ch.kind === 'instrument' ? ch.rootKey : 60;
      return [0, 0.75, 1.5, 2, 3].map((b, i) => ({ at: b * beat, dur: beat * 0.25, key: root, velocity: i % 2 ? 0.65 : 0.9 }));
    }
  }
}

/** Plays the phrase now; returns a function that stops it (and releases its notes). */
export function audition(s: Services, channelId: ChannelId, phrase: AuditionPhrase): () => void {
  const notes = phraseNotes(s.doc.getState().project, channelId, phrase);
  const timers: ReturnType<typeof setTimeout>[] = [];
  const sounding = new Set<number>();
  void s.engine.resume().catch(() => {});
  for (const n of notes) {
    timers.push(
      setTimeout(() => {
        const id = s.engine.previewNoteOn(channelId, n.key, n.velocity);
        sounding.add(id);
        timers.push(
          setTimeout(() => {
            s.engine.previewNoteOff(channelId, id);
            sounding.delete(id);
          }, n.dur * 1000),
        );
      }, n.at * 1000),
    );
  }
  return () => {
    for (const t of timers) clearTimeout(t);
    for (const id of sounding) s.engine.previewNoteOff(channelId, id);
    sounding.clear();
  };
}
