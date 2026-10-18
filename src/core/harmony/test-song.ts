/**
 * A small project for harmony tests: one pattern of `chords.length` bars with a Chords part (held triads or sevenths), a
 * Bass part (roots), a Kick (four on the floor) and a Lead (a note per beat), placed on the first playlist track. Test
 * helper, not part of the app.
 */
import { createEmptyProject, makeInstrumentChannel, makePattern, makePluginInstance, paletteColor } from '../model/defaults';
import { newId } from '../model/ids';
import type { ChannelId, Clip, Note, PatternId, Project } from '../model/types';
import { parseChord } from './chord';
import { naiveVoicing, voiceChords } from './voicing';

const BAR = 3840;

export interface HarmonySong {
  project: Project;
  patternId: PatternId;
  channels: { chords: ChannelId; bass: ChannelId; kick: ChannelId; lead: ChannelId };
}

const makeNote = (tick: number, length: number, key: number, velocity = 0.8): Note => ({ id: newId.note(), tick, length, key, velocity });

/** A song with the given chord per bar (e.g. `['Am', 'F', 'C', 'G']`), in the key given (default C major). */
export function makeHarmonySong(chordNames: readonly string[], key = { root: 0, scale: 'major' }): HarmonySong {
  const project = createEmptyProject();
  const patternId = project.patternOrder[0] as PatternId;
  const pattern = makePattern('Loop', paletteColor(0), patternId);
  const plugin = () => makePluginInstance('agstudio.3xosc', 1, {});
  const chordsChannel = makeInstrumentChannel('Chords', plugin());
  const bassChannel = makeInstrumentChannel('Bass', plugin());
  const kickChannel = makeInstrumentChannel('Kick', plugin());
  const leadChannel = makeInstrumentChannel('Lead', plugin());
  const symbols = chordNames.map((name) => parseChord(name) ?? { root: 0, quality: 'maj' });
  const voicings = voiceChords(symbols).length ? voiceChords(symbols) : symbols.map((symbol) => naiveVoicing(symbol));
  const byChannel: Record<string, Record<string, Note>> = { [chordsChannel.id]: {}, [bassChannel.id]: {}, [kickChannel.id]: {}, [leadChannel.id]: {} };
  symbols.forEach((symbol, bar) => {
    for (const noteKey of voicings[bar] ?? []) {
      const note = makeNote(bar * BAR, BAR, noteKey);
      (byChannel[chordsChannel.id] as Record<string, Note>)[note.id] = note;
    }
    const bass = makeNote(bar * BAR, BAR, 36 + ((symbol.root - 36 + 120) % 12));
    (byChannel[bassChannel.id] as Record<string, Note>)[bass.id] = bass;
    for (let beat = 0; beat < 4; beat++) {
      const kick = makeNote(bar * BAR + beat * 960, 120, 60);
      (byChannel[kickChannel.id] as Record<string, Note>)[kick.id] = kick;
      const lead = makeNote(bar * BAR + beat * 960, 480, 72 + beat);
      (byChannel[leadChannel.id] as Record<string, Note>)[lead.id] = lead;
    }
  });
  pattern.notes = byChannel as never;
  pattern.length = chordNames.length * BAR;
  const laneId = project.playlist.laneOrder[0];
  const clip: Clip = { id: newId.clip(), kind: 'pattern', laneId: laneId as never, patternId, start: 0, length: chordNames.length * BAR, offset: 0 };
  const next: Project = {
    ...project,
    transport: { ...project.transport, key },
    channels: { [chordsChannel.id]: chordsChannel, [bassChannel.id]: bassChannel, [kickChannel.id]: kickChannel, [leadChannel.id]: leadChannel },
    channelOrder: [chordsChannel.id, bassChannel.id, kickChannel.id, leadChannel.id],
    patterns: { [patternId]: pattern },
    playlist: { ...project.playlist, clips: { [clip.id]: clip } },
  };
  return { project: next, patternId, channels: { chords: chordsChannel.id, bass: bassChannel.id, kick: kickChannel.id, lead: leadChannel.id } };
}
