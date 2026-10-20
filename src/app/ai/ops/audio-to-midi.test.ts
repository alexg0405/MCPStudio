import { describe, expect, it } from 'vitest';
import { audioClipProject, TestSamples } from '../../../../test/helpers/audio';
import { BEATS, drumLoop, TRANSCRIBE_RATE } from '../../../../test/helpers/transcribe-signals';
import type { ClipId, Project } from '@core/model/types';
import { forgetListening } from '../../transcribe/listening';
import { forgetPlans } from '../../transcribe/plan-cache';
import { createTestServices } from '../../testing';
import { applyAnswer } from '../apply';
import { runReadTool } from '../read';
import type { AiAction } from '../schema';

const SR = TRANSCRIBE_RATE;

function setup() {
  forgetListening();
  forgetPlans();
  const loop = drumLoop({ bpm: 120, bars: 2, patterns: [BEATS.house ?? []] });
  const samples = new TestSamples();
  const ref = samples.add([loop.mono], SR, 'Beat');
  const { project, clipIds } = audioClipProject(ref, [{ start: 0, length: 3840 * 2 }]);
  const s = createTestServices();
  s.fakeEngine.sampleAudio.set('Beat', { sampleRate: SR, channels: [loop.mono], duration: loop.mono.length / SR });
  s.history.load(project);
  return { s, clipId: clipIds[0] as ClipId };
}
const run = (s: ReturnType<typeof createTestServices>, actions: AiAction[]) => applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the audio_to_midi action', () => {
  it('checks the request and queues the app command for the background listening', () => {
    const { s, clipId } = setup();
    const res = run(s, [{ op: 'audio_to_midi', clip: clipId, mode: 'drums', quantize: '1/8', strength: 80, swing: 'keep' }]);
    expect(res.warnings).toEqual([]);
    expect(res.changes.join(' ')).toMatch(/to MIDI as drums/);
    expect(res.after).toContainEqual({
      kind: 'command',
      id: 'audioToMidi.convert',
      args: { clip: clipId, mode: 'drums', quantize: '1/8', strength: 80, swing: 'keep' },
      gesture: false,
    });
  });

  it('leaves the mode to the sound when it is not given', () => {
    const { s, clipId } = setup();
    const res = run(s, [{ op: 'audio_to_midi', clip: clipId }]);
    expect(res.after).toContainEqual({ kind: 'command', id: 'audioToMidi.convert', args: { clip: clipId, mode: 'auto' }, gesture: false });
  });

  it('says what is wrong in plain words and queues nothing', () => {
    const { s, clipId } = setup();
    const grid = run(s, [{ op: 'audio_to_midi', clip: clipId, mode: 'drums', quantize: 'wobbly' }]);
    expect(grid.warnings.join(' ')).toMatch(/quantize must be one of/);
    const target = run(s, [{ op: 'audio_to_midi', clip: clipId, mode: 'melody', target: 'No such channel' }]);
    expect(target.warnings.join(' ')).toMatch(/no channel/);
    const instrument = run(s, [{ op: 'audio_to_midi', clip: clipId, mode: 'melody', instrument: 'nope.synth' }]);
    expect(instrument.warnings.join(' ')).toMatch(/no instrument/);
    expect(grid.after.concat(target.after, instrument.after)).toEqual([]);
  });

  it('refuses a clip that cannot be converted', () => {
    const { s, clipId } = setup();
    const channelId = (s.doc.getState().project.playlist.clips[clipId] as { channelId: string }).channelId;
    s.history.transact('Reverse', (d) => {
      const channel = (d as Project).channels[channelId as never];
      if (channel?.kind === 'audioClip') channel.reverse = true;
    });
    const res = run(s, [{ op: 'audio_to_midi', clip: clipId, mode: 'drums' }]);
    expect(res.warnings.join(' ')).toMatch(/Reverse/);
    expect(res.after).toEqual([]);
  });
});

describe('the get_midi_conversion read', () => {
  it('starts listening on the first look and then lists the notes it would write', async () => {
    const { s, clipId } = setup();
    const first = runReadTool(s, 'get_midi_conversion', { clip: clipId, mode: 'drums' }) as { state: string };
    expect(first.state).toBe('analyzing');
    let second: { state: string; notes: { drum: string; bar: number }[]; notes_total: number; summary: string[] } | undefined;
    for (let i = 0; i < 100 && second?.state !== 'ready'; i++) {
      await wait(30);
      second = runReadTool(s, 'get_midi_conversion', { clip: clipId, mode: 'drums' }) as typeof second;
    }
    expect(second?.state).toBe('ready');
    expect(second?.notes_total).toBe(20);
    expect(second?.notes.map((n) => n.drum)).toContain('kick');
    expect(second?.summary[0]).toMatch(/kicks/);
    // It reads, it does not change: no pattern, no channel.
    expect(s.doc.getState().project.patternOrder).toHaveLength(1);
  });

  it('answers an unknown mode or clip with an error', () => {
    const { s, clipId } = setup();
    expect(runReadTool(s, 'get_midi_conversion', { clip: clipId, mode: 'banjo' })).toMatchObject({ error: expect.stringMatching(/mode must be one of/) });
    expect(runReadTool(s, 'get_midi_conversion', { clip: 'nope' })).toMatchObject({ error: expect.stringMatching(/no audio clip/) });
  });
});
