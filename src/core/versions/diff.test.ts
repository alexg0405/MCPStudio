import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import type { ChannelId, Note, NoteId } from '../model/types';
import { describeProjectChanges, summarizeChanges } from './diff';
import { emptySong, songWithClips, withClip, withFader, withPattern } from './test-songs';

describe('describeProjectChanges', () => {
  it('says nothing changed for the same project', () => {
    const song = songWithClips(2);
    expect(describeProjectChanges(song, song)).toEqual({ parts: [], lines: [] });
  });

  it('counts clips added and removed', () => {
    const before = songWithClips(2);
    const patternId = before.patternOrder[0]!;
    const after = withClip(withClip(withClip(before, patternId, 2), patternId, 3), patternId, 4);
    expect(describeProjectChanges(before, after).parts).toEqual(['+3 clips']);
    expect(describeProjectChanges(after, before).parts).toEqual(['−3 clips']);
    expect(describeProjectChanges(before, after).lines).toEqual(['Playlist: 3 clips added']);
  });

  it('notices a clip that moved', () => {
    const before = songWithClips(1);
    const after = produce(before, (draft) => {
      const clip = Object.values(draft.playlist.clips)[0]!;
      clip.start += 3840;
    });
    expect(describeProjectChanges(before, after).parts).toEqual(['1 clip changed']);
  });

  it('names a new pattern and a removed one', () => {
    const before = emptySong();
    const { project: after } = withPattern(before, 'Drop 2');
    expect(describeProjectChanges(before, after).parts).toEqual(["new pattern 'Drop 2'"]);
    expect(describeProjectChanges(after, before).parts).toEqual(["removed pattern 'Drop 2'"]);
  });

  it('names a mixer fader change in dB', () => {
    const before = emptySong();
    const after = withFader(before, 1, 0.794328);
    const name = before.mixer.inserts[before.mixer.order[1]!]!.name;
    const { parts, lines } = describeProjectChanges(before, after);
    expect(parts).toEqual([`mixer: ${name} −2.0 dB`]);
    expect(lines[0]).toContain(`${name}: fader`);
  });

  it('keeps the mixer phrase short when many tracks changed', () => {
    let after = emptySong();
    const before = after;
    for (let track = 1; track <= 4; track++) after = withFader(after, track, 0.5);
    const [part] = describeProjectChanges(before, after).parts;
    expect(part).toMatch(/^mixer: .+ −6\.0 dB, .+ −6\.0 dB and 2 more$/);
  });

  it('reports tempo and key', () => {
    const before = emptySong();
    const after = produce(before, (draft) => {
      draft.transport.bpm = 140;
      draft.transport.key = { root: 9, scale: 'minor' };
    });
    expect(describeProjectChanges(before, after).parts).toEqual(['tempo 130 → 140 BPM', 'key none → A minor']);
  });

  it('counts notes added, removed and edited', () => {
    const base = emptySong();
    const patternId = base.patternOrder[0]!;
    const channelId = 'ch_x' as ChannelId;
    const note = (id: string, tick: number): Note => ({ id: id as NoteId, tick, length: 240, key: 60, velocity: 0.8 });
    const before = produce(base, (draft) => {
      draft.patterns[patternId]!.notes[channelId] = { n1: note('n1', 0), n2: note('n2', 240) } as Record<NoteId, Note>;
    });
    const after = produce(before, (draft) => {
      const notes = draft.patterns[patternId]!.notes[channelId]!;
      notes['n3' as NoteId] = note('n3', 480);
      notes['n4' as NoteId] = note('n4', 720);
      delete notes['n2' as NoteId];
      notes['n1' as NoteId]!.key = 62;
    });
    const { parts } = describeProjectChanges(before, after);
    expect(parts).toEqual(['+2 notes', '−1 note', '1 note edited']);
  });

  it('puts the phrases in a fixed order: song, patterns, clips, notes, mixer', () => {
    const before = songWithClips(1);
    const { project: withDrop } = withPattern(before, 'Drop 2');
    const after = withFader(withClip(produce(withDrop, (d) => void (d.transport.bpm = 150)), withDrop.patternOrder[0]!, 5), 1, 0.5);
    const parts = describeProjectChanges(before, after).parts;
    expect(parts.map((p) => p.split(' ')[0])).toEqual(['tempo', 'new', '+1', 'mixer:']);
  });
});

describe('summarizeChanges', () => {
  it('joins the first phrases and counts the rest', () => {
    expect(summarizeChanges(['+3 clips', 'mixer: Kick −2.0 dB', "new pattern 'Drop 2'"])).toBe(
      "+3 clips, mixer: Kick −2.0 dB, new pattern 'Drop 2'",
    );
    expect(summarizeChanges(['a', 'b', 'c', 'd', 'e', 'f'])).toBe('a, b, c, d and 2 other changes');
    expect(summarizeChanges(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c, d and 1 other change');
    expect(summarizeChanges([])).toBe('No changes');
  });
});
