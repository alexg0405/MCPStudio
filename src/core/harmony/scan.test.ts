import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { channelRoles } from '../arrange/roles';
import { formatChord } from './chord';
import { detectProjectChords, harmonyNotes } from './scan';
import { makeHarmonySong } from './test-song';

const BAR = 3840;
const names = (spans: ReturnType<typeof detectProjectChords>) => spans.map((span) => `${span.tick / BAR}+${span.length / BAR} ${formatChord(span.chord)}`);

describe('finding the chords of a project', () => {
  const song = makeHarmonySong(['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G']);
  const roles = channelRoles(song.project);

  it('reads the whole song from its harmonic parts, ignoring drums and the lead', () => {
    const notes = harmonyNotes(song.project, roles, { kind: 'song' });
    // Chords (3 notes a bar) plus the bass root; no kick, no lead.
    expect(notes.length).toBeGreaterThan(8 * 3);
    expect(notes.every((note) => note.key !== 60 || note.length !== 120)).toBe(true);
    expect(names(detectProjectChords(song.project, roles, { kind: 'song' }))).toEqual(['0+1 Am', '1+1 F', '2+1 C', '3+1 G', '4+1 Am', '5+1 F', '6+1 C', '7+1 G']);
  });

  it('reads a stretch of bars, some clips or some patterns', () => {
    expect(names(detectProjectChords(song.project, roles, { kind: 'range', from: BAR * 2, to: BAR * 4 }))).toEqual(['2+1 C', '3+1 G']);
    const clipId = Object.keys(song.project.playlist.clips)[0] as never;
    expect(detectProjectChords(song.project, roles, { kind: 'clips', clipIds: [clipId] })).toHaveLength(8);
    const patterns = detectProjectChords(song.project, roles, { kind: 'patterns', patternIds: [song.patternId] });
    expect(names(patterns).slice(0, 2)).toEqual(['0+1 Am', '1+1 F']);
  });

  it('merges repeated bars and splits at half bars on request', () => {
    const held = makeHarmonySong(['Am', 'Am', 'F', 'F']);
    const spans = detectProjectChords(held.project, channelRoles(held.project), { kind: 'song' });
    expect(names(spans)).toEqual(['0+2 Am', '2+2 F']);
    const half = detectProjectChords(held.project, channelRoles(held.project), { kind: 'song' }, { resolution: 'half' });
    expect(names(half)).toEqual(['0+2 Am', '2+2 F']);
  });

  it('falls back to the melody when nothing harmonic plays, and ignores muted channels', () => {
    const noHarmony = produce(song.project, (draft) => {
      draft.channels[song.channels.chords]!.muted = true;
      draft.channels[song.channels.bass]!.muted = true;
    });
    const notes = harmonyNotes(noHarmony, channelRoles(noHarmony), { kind: 'song' });
    expect(notes.length).toBe(8 * 4);
  });
});
