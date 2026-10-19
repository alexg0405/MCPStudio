import { describe, expect, it } from 'vitest';
import { audioClipProject, TestSamples } from '../../../../test/helpers/audio';
import { sing } from '../../../../test/helpers/sung';
import type { AudioClip, ClipId } from '@core/model/types';
import { makeHarmonies } from '../../harmony/voices';
import { defaultVoice } from '../../harmony/voice-spec';
import { createTestServices } from '../../testing';
import { applyAnswer } from '../apply';
import type { AiAction } from '../schema';

const SR = 48000;

function setup(key: { root: number; scale: string } | null = { root: 9, scale: 'minor' }) {
  const x = sing([{ from: 0.1, to: 0.8, midi: 69 }, { from: 1.0, to: 1.8, midi: 72 }], SR, 2);
  const samples = new TestSamples();
  const ref = samples.add([x], SR, 'lead vocal');
  const { project, clipIds } = audioClipProject(ref, [{ start: 0, length: 3840 * 2 }]);
  const s = createTestServices();
  s.fakeEngine.sampleAudio.set('lead vocal', { sampleRate: SR, channels: [x], duration: x.length / SR });
  s.history.load({ ...project, transport: { ...project.transport, ...(key ? { key } : {}) } });
  return { s, clipId: clipIds[0] as ClipId };
}
const run = (s: ReturnType<typeof createTestServices>, actions: AiAction[]) => applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });

describe('the make_harmonies and update_harmonies actions', () => {
  it('check the request and queue the app command for the background render', () => {
    const { s, clipId } = setup();
    const voices = [{ rule: 'third_above', level: -8, pan: -0.4 }, { rule: 'chord_below' }];
    const res = run(s, [{ op: 'make_harmonies', clip: clipId, voices, humanize: { timing_ms: 10 } }]);
    expect(res.warnings).toEqual([]);
    expect(res.changes.join(' ')).toMatch(/2 harmony voices \(3rd above, chord tone below\)/);
    expect(res.after).toContainEqual({
      kind: 'command',
      id: 'harmonies.make',
      args: { clip: clipId, voices, humanize: { timing_ms: 10 } },
      gesture: false,
    });
  });

  it('says what is wrong in plain words and queues nothing', () => {
    const { s, clipId } = setup(null);
    const noKey = run(s, [{ op: 'make_harmonies', clip: clipId, voices: [{ rule: 'third_above' }] }]);
    expect(noKey.warnings.join(' ')).toMatch(/no key/);
    expect(noKey.after).toEqual([]);
    const bad = run(s, [{ op: 'make_harmonies', clip: clipId, voices: [{ rule: 'wobble' }] }]);
    expect(bad.warnings.join(' ')).toMatch(/unknown rule/);
    const none = run(s, [{ op: 'make_harmonies', clip: clipId, voices: [] }]);
    expect(none.warnings.join(' ')).toMatch(/Say which voices/);
    const nothing = run(s, [{ op: 'update_harmonies' }]);
    expect(nothing.warnings.join(' ')).toMatch(/no harmony voices/);
  });

  it('update_harmonies asks the app to update the lead’s voices', async () => {
    const { s, clipId } = setup();
    await makeHarmonies(s, clipId, { voices: [defaultVoice({ kind: 'chord', side: 'above' }, 0, 1)], humanize: { timingMs: 10, driftCents: 5, vibrato: 0.2 }, seed: 2 });
    const voice = Object.values(s.doc.getState().project.playlist.clips).find((c): c is AudioClip => c.kind === 'audio' && !!c.harmony) as AudioClip;
    const res = run(s, [{ op: 'update_harmonies', clip: voice.id, force: true }]);
    expect(res.warnings).toEqual([]);
    expect(res.after).toContainEqual({ kind: 'command', id: 'harmonies.update', args: { clip: voice.id, force: true }, gesture: false });
  });
});
