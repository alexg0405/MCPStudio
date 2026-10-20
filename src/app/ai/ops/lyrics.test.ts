import { describe, expect, it } from 'vitest';
import { makeHarmonySong } from '@core/harmony/test-song';
import type { AudioClip, AudioClipChannel, ChannelId, ClipId, SampleId } from '@core/model/types';
import { addChannel, addSample } from '@core/ops/channels';
import { addClips } from '@core/ops/playlist';
import { lyricLines, lyricsSorted } from '@core/query/lyrics';
import { projectContext } from '../context';
import { createTestServices } from '../../testing';
import { applyAnswer } from '../apply';
import { runReadTool } from '../read';
import type { AiAction } from '../schema';

type TestServices = ReturnType<typeof createTestServices>;

const BAR = 3840;

function setup() {
  const s = createTestServices();
  const song = makeHarmonySong(['C', 'C', 'C', 'C']);
  s.history.load(song.project);
  s.view.getState().setCurrentPattern(song.patternId);
  return { s, song };
}
const run = (s: TestServices, actions: AiAction[]) => applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });
const ticks = (s: TestServices) => lyricsSorted(s.doc.getState().project).map((w) => `${w.tick}:${w.text}${w.continues ? '-' : ''}`);
const words = (s: TestServices) => lyricsSorted(s.doc.getState().project).map((w) => `${w.tick / 960}:${w.text}${w.continues ? '-' : ''}`);

describe('set_lyrics', () => {
  it('spreads lines evenly, one bar a line, as one undo step; undo takes them away', () => {
    const { s } = setup();
    const steps = s.history.steps().done.length;
    const turn = run(s, [{ op: 'set_lyrics', text: 'Hello dar-kness\nmy old friend', from_bar: 2 }]);
    expect(turn.warnings).toEqual([]);
    expect(turn.changes[0]).toMatch(/^Lyrics bars 2–3: placed 6 syllables \(2 lines\) spaced evenly/);
    expect(ticks(s)).toEqual(['3840:Hello', '5120:dar-', '6400:kness', '7680:my', '8960:old', '10240:friend']);
    expect(s.history.steps().done.length).toBe(steps + 1);
    expect(s.history.undo()).toBe(true);
    expect(s.doc.getState().project.lyrics).toBeUndefined();
  });

  it('on the notes of a channel: one syllable per note from the bar; extra words are reported', () => {
    const { s, song } = setup();
    const turn = run(s, [{ op: 'set_lyrics', text: 'one two three four five six seven eight', channel: song.channels.lead, from_bar: 2 }]);
    expect(turn.warnings).toEqual([]);
    expect(words(s)).toEqual(['4:one', '5:two', '6:three', '7:four', '8:five', '9:six', '10:seven', '11:eight']);
    expect(lyricsSorted(s.doc.getState().project).every((w) => w.length === 480)).toBe(true);
    // More words than notes in bars 4 (4 notes) only: the rest are left out, and it says so.
    const short = run(s, [{ op: 'set_lyrics', text: 'a b c d e f', channel: song.channels.lead, from_bar: 4, to_bar: 4 }]);
    expect(short.changes[0]).toMatch(/2 syllables had no note and were left out/);
  });

  it('replaces only the span it covers; the text shows up in the project text and get_lyrics', () => {
    const { s } = setup();
    run(s, [{ op: 'set_lyrics', text: 'la la la la', from_bar: 1 }]);
    run(s, [{ op: 'set_lyrics', text: 'sun shine\non me', from_bar: 3 }]);
    expect(lyricLines(s.doc.getState().project).map((l) => l.text)).toEqual(['la la la la', 'sun shine', 'on me']);
    expect(projectContext(s)).toContain('Lyrics (first bar of each line):\n  bar 1: la la la la\n  bar 3: sun shine\n  bar 4: on me');
    const read = runReadTool(s, 'get_lyrics', { words: true }) as { lines: Array<{ bar: number; text: string; words?: Array<{ text: string; bar: number }> }>; total_lines: number };
    expect(read.total_lines).toBe(3);
    expect(read.lines[1]).toMatchObject({ bar: 3, text: 'sun shine' });
    expect(read.lines[1]!.words!.map((w) => w.text)).toEqual(['sun', 'shine']);
    const limited = runReadTool(s, 'get_lyrics', { from_bar: 4 }) as { lines: unknown[] };
    expect(limited.lines).toHaveLength(1);
  });

  it('says what is wrong instead of guessing', () => {
    const { s, song } = setup();
    expect(run(s, [{ op: 'set_lyrics', text: '   ' }]).warnings.join(' ')).toMatch(/needs text/);
    expect(run(s, [{ op: 'set_lyrics', text: '- -' }]).warnings.join(' ')).toMatch(/there are no words/);
    expect(run(s, [{ op: 'set_lyrics', text: 'a b', align: 'notes' }]).warnings.join(' ')).toMatch(/needs channel/);
    expect(run(s, [{ op: 'set_lyrics', text: 'a b', align: 'clip' }]).warnings.join(' ')).toMatch(/needs clip/);
    expect(run(s, [{ op: 'set_lyrics', text: 'a b', clip: 'clip_nope' }]).warnings.join(' ')).toMatch(/no audio clip/);
    expect(run(s, [{ op: 'set_lyrics', text: 'a b', align: 'sideways' }]).warnings.join(' ')).toMatch(/align must be one of/);
    expect(run(s, [{ op: 'set_lyrics', text: 'a b', channel: song.channels.lead, from_bar: 40 }]).warnings.join(' ')).toMatch(/no notes to put the words on/);
  });
});

describe('set_lyrics on a sung clip', () => {
  /** An audio clip at bar 2 whose sample holds three sung notes (a pitch edit stands for the analysis). */
  function withSungClip() {
    const { s } = setup();
    const clipId = 'clip_vox' as ClipId;
    s.history.transact('Vocal', (d) => {
      addSample(d, { id: 'smp_vox' as SampleId, name: 'vox', source: { kind: 'builtin', generator: 'x', version: 1 } });
      const channel: AudioClipChannel = { kind: 'audioClip', id: 'ch_vox' as ChannelId, name: 'Vox', color: '#fff', muted: false, solo: false, volume: 1, pan: 0, output: 'master' as never, sampleId: 'smp_vox' as SampleId };
      addChannel(d, channel);
      const clip: AudioClip = {
        kind: 'audio',
        id: clipId,
        laneId: d.playlist.laneOrder[5]!,
        start: BAR,
        length: BAR * 2,
        channelId: channel.id,
        offsetSec: 0,
        pitchEdit: {
          notes: [
            { from: 0.1, to: 0.4, pitch: 60 },
            { from: 0.6, to: 0.9, pitch: 62 },
            { from: 1.2, to: 1.8, pitch: 64 },
          ],
        },
      };
      addClips(d, [clip]);
    });
    return { s, clipId };
  }

  it('puts one syllable on each sung note, at the notes’ own times (the test song is at 130 BPM: 2080 ticks a second, counted from the clip’s start)', () => {
    const { s, clipId } = withSungClip();
    const turn = run(s, [{ op: 'set_lyrics', text: 'mo-ment of', clip: clipId }]);
    expect(turn.warnings).toEqual([]);
    expect(turn.changes[0]).toMatch(/on the sung notes/);
    const placed = lyricsSorted(s.doc.getState().project);
    expect(placed.map((w) => w.text)).toEqual(['mo', 'ment', 'of']);
    expect(placed.map((w) => w.tick)).toEqual([BAR + 208, BAR + 1248, BAR + 2496]);
    expect(placed.map((w) => w.length)).toEqual([624, 624, 1248]);
  });

  it('asks for the clip to be analysed when its notes are not known yet', () => {
    const { s, clipId } = withSungClip();
    s.history.transact('Forget notes', (d) => void delete (d.playlist.clips[clipId] as AudioClip).pitchEdit);
    expect(run(s, [{ op: 'set_lyrics', text: 'a b', clip: clipId }]).warnings.join(' ')).toMatch(/analyse it first/);
  });
});

describe('clear_lyrics', () => {
  it('clears all of them, or some bars', () => {
    const { s } = setup();
    run(s, [{ op: 'set_lyrics', text: 'a\nb\nc\nd', from_bar: 1 }]);
    run(s, [{ op: 'clear_lyrics', from_bar: 2, to_bar: 3 }]);
    expect(lyricsSorted(s.doc.getState().project).map((w) => w.text)).toEqual(['a', 'd']);
    run(s, [{ op: 'clear_lyrics' }]);
    expect(s.doc.getState().project.lyrics).toBeUndefined();
    expect(run(s, [{ op: 'clear_lyrics' }]).warnings.join(' ')).toMatch(/there are no lyrics/);
  });
});

describe('the AI’s project text stays small', () => {
  it('lists the first lines and a count for a long song', () => {
    const { s } = setup();
    const text = Array.from({ length: 60 }, (_, i) => `line ${i + 1} of the song`).join('\n');
    run(s, [{ op: 'set_lyrics', text, from_bar: 1 }]);
    const context = projectContext(s);
    const section = context.slice(context.indexOf('Lyrics (first bar'));
    expect(section.split('\n').slice(0, 18).join('\n')).toContain('… and 44 more lines');
    expect(section.length).toBeLessThan(1200);
    expect(BAR).toBe(3840);
  });
});
