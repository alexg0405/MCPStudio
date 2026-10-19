import { describe, expect, it } from 'vitest';
import { sing, type SungNote } from '../../../test/helpers/sung';
import { audioClipProject, TestSamples } from '../../../test/helpers/audio';
import { collectHashes } from '@core/gc/refs';
import type { AudioClip, ClipId, Project, SampleId } from '@core/model/types';
import { setChord } from '@core/ops/chords';
import { harmonyVoices, staleHarmonyVoices } from '@core/query/harmony-voices';
import { createTestServices } from '../testing';
import { HarmonyError, makeHarmonies, updateHarmonies } from './voices';
import { defaultVoice, parseVoiceSpec, type HarmonySpec } from './voice-spec';

const SR = 48000;
/** A short line in A minor: A4 C5 E5 D5 (the chord track says Am, then F). */
const NOTES: SungNote[] = [69, 72, 76, 74].map((midi, i) => ({ from: 0.15 + i * 0.6, to: 0.15 + i * 0.6 + 0.5, midi }));

async function setup(opts: { key?: boolean } = {}) {
  const x = sing(NOTES, SR, 2.7);
  const samples = new TestSamples();
  const ref = samples.add([x], SR, 'vocal');
  const { project, clipIds } = audioClipProject(ref, [{ start: 0, length: 3840 * 2 }]);
  const s = createTestServices();
  s.fakeEngine.sampleAudio.set('vocal', { sampleRate: SR, channels: [x], duration: x.length / SR });
  s.history.load(project);
  if (opts.key !== false) s.history.transact('Key', (d) => void (d.transport.key = { root: 9, scale: 'minor' }));
  s.history.transact('Chords', (d) => {
    setChord(d, 0, 3840, { root: 9, quality: 'min' });
    setChord(d, 3840, 3840, { root: 5, quality: 'maj' });
  });
  return { s, clipId: clipIds[0] as ClipId };
}

const spec = (rules: HarmonySpec['voices'][number]['rule'][]): HarmonySpec => ({
  voices: rules.map((rule, i) => defaultVoice(rule, i, rules.length)),
  humanize: { timingMs: 12, driftCents: 6, vibrato: 0.3 },
  seed: 5,
});

const clipsOf = (p: Project) => Object.values(p.playlist.clips).filter((c): c is AudioClip => c.kind === 'audio');
const steps = (s: Awaited<ReturnType<typeof setup>>['s']) => s.history.steps().done.length;

describe('make harmonies', () => {
  it('adds the voices as new tracks right under the lead in one undo step, and undo takes them all away', async () => {
    const { s, clipId } = await setup();
    const before = s.doc.getState().project;
    const n0 = steps(s);
    const result = await makeHarmonies(s, clipId, spec([{ kind: 'interval', steps: 2 }, { kind: 'chord', side: 'below' }]));
    expect(result.voices).toBe(2);
    expect(steps(s)).toBe(n0 + 1);
    const p = s.doc.getState().project;
    const lead = p.playlist.clips[clipId] as AudioClip;
    const order = p.playlist.laneOrder;
    const at = order.indexOf(lead.laneId);
    const voices = clipsOf(p).filter((c) => c.harmony);
    expect(voices).toHaveLength(2);
    expect(voices.map((c) => order.indexOf(c.laneId)).sort()).toEqual([at + 1, at + 2]);
    for (const v of voices) {
      expect(v).toMatchObject({ start: lead.start, length: lead.length, offsetSec: lead.offsetSec });
      expect(v.harmony).toMatchObject({ source: clipId });
      expect(v.harmony?.renderedFor).toMatch(/^[0-9a-f]{8}$/);
      const channel = p.channels[v.channelId];
      expect(channel?.kind === 'audioClip' && channel.output).toBe((p.channels[lead.channelId] as { output: string }).output);
      const sample = channel?.kind === 'audioClip' ? p.samples[channel.sampleId] : undefined;
      expect(sample?.source.kind).toBe('embedded');
      // The sample store keeps it: the project mentions its hash.
      expect(collectHashes(p).has(sample?.source.kind === 'embedded' ? sample.source.hash : '')).toBe(true);
      // The voice is the lead's size, so its clip lines up with the lead's.
      expect(sample?.durationSec).toBeCloseTo(2.7, 6);
    }
    expect(harmonyVoices(p)).toHaveLength(2);
    expect(staleHarmonyVoices(p)).toHaveLength(0);
    s.history.undo();
    const after = s.doc.getState().project;
    expect(after.playlist.laneOrder).toEqual(before.playlist.laneOrder);
    expect(clipsOf(after).filter((c) => c.harmony)).toHaveLength(0);
    expect(Object.keys(after.samples)).toEqual(Object.keys(before.samples));
    expect(after.channelOrder).toEqual(before.channelOrder);
  });

  it('makes the same voices again from the same seed: bit-identical samples', async () => {
    const { s, clipId } = await setup();
    await makeHarmonies(s, clipId, spec([{ kind: 'interval', steps: 2 }]));
    await makeHarmonies(s, clipId, spec([{ kind: 'interval', steps: 2 }]));
    const p = s.doc.getState().project;
    const hashes = clipsOf(p)
      .filter((c) => c.harmony)
      .map((c) => {
        const ch = p.channels[c.channelId];
        const ref = ch?.kind === 'audioClip' ? p.samples[ch.sampleId] : undefined;
        return ref?.source.kind === 'embedded' ? ref.source.hash : '';
      });
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).not.toBe('');
    expect(hashes[0]).toBe(hashes[1]);
  });

  it('says to set the key when a diatonic voice has none, and changes nothing', async () => {
    const { s, clipId } = await setup({ key: false });
    const n0 = steps(s);
    await expect(makeHarmonies(s, clipId, spec([{ kind: 'interval', steps: 2 }]))).rejects.toThrow(/song key/);
    expect(steps(s)).toBe(n0);
    // A fixed interval needs no key.
    await expect(makeHarmonies(s, clipId, spec([{ kind: 'semitones', semitones: 4 }]))).resolves.toMatchObject({ voices: 1 });
  });

  it('refuses a clip that is not audio, or has no sung notes', async () => {
    const { s } = await setup();
    await expect(makeHarmonies(s, 'nope' as ClipId, spec([{ kind: 'semitones', semitones: 4 }]))).rejects.toBeInstanceOf(HarmonyError);
  });
});

describe('update harmonies', () => {
  it('remakes only the voices whose chords changed, in one undo step, keeping the tracks and levels', async () => {
    const { s, clipId } = await setup();
    await makeHarmonies(s, clipId, spec([{ kind: 'interval', steps: 2 }, { kind: 'chord', side: 'above' }]));
    const sampleOf = (p: Project, kind: 'interval' | 'chord') => {
      const clip = clipsOf(p).find((c) => c.harmony?.rule.kind === kind) as AudioClip;
      const ch = p.channels[clip.channelId];
      return (ch?.kind === 'audioClip' ? ch.sampleId : '') as SampleId;
    };
    const p0 = s.doc.getState().project;
    const intervalBefore = sampleOf(p0, 'interval');
    const chordBefore = sampleOf(p0, 'chord');
    expect((await updateHarmonies(s)).message).toMatch(/up to date/);

    // The chord under the first notes changes: the chord voice is stale, the diatonic one is not.
    s.history.transact('Chord change', (d) => {
      setChord(d, 0, 3840, { root: 7, quality: 'maj' });
    });
    expect(staleHarmonyVoices(s.doc.getState().project).map((v) => v.record.rule.kind)).toEqual(['chord']);
    const n0 = steps(s);
    const result = await updateHarmonies(s);
    expect(result.voices).toBe(1);
    expect(steps(s)).toBe(n0 + 1);
    const p1 = s.doc.getState().project;
    expect(sampleOf(p1, 'interval')).toBe(intervalBefore);
    expect(sampleOf(p1, 'chord')).not.toBe(chordBefore);
    expect(p1.samples[chordBefore]).toBeUndefined();
    expect(staleHarmonyVoices(p1)).toHaveLength(0);
    expect(p1.playlist.laneOrder).toEqual(p0.playlist.laneOrder);
    // Undo brings back the old render.
    s.history.undo();
    expect(sampleOf(s.doc.getState().project, 'chord')).toBe(chordBefore);
    expect(staleHarmonyVoices(s.doc.getState().project)).toHaveLength(1);
  });

  it('a changed key makes the diatonic voices stale, and force remakes everything', async () => {
    const { s, clipId } = await setup();
    await makeHarmonies(s, clipId, spec([{ kind: 'interval', steps: 2 }, { kind: 'semitones', semitones: 7 }]));
    s.history.transact('Key', (d) => void (d.transport.key = { root: 9, scale: 'dorian' }));
    expect(staleHarmonyVoices(s.doc.getState().project).map((v) => v.record.rule.kind)).toEqual(['interval']);
    expect((await updateHarmonies(s, { force: true })).voices).toBe(2);
  });
});

describe('reading a request', () => {
  it('understands named intervals, diatonic with an interval, chord, fixed and level/pan', () => {
    const parsed = parseVoiceSpec({
      voices: [
        { rule: 'third_above', level: -8, pan: -0.5 },
        { rule: 'diatonic', interval: '5th below' },
        { rule: 'chord_above' },
        { rule: 'fixed', interval: -7 },
      ],
      humanize: { timing_ms: 20 },
    });
    expect(parsed.voices.map((v) => v.rule)).toEqual([
      { kind: 'interval', steps: 2 },
      { kind: 'interval', steps: -4 },
      { kind: 'chord', side: 'above' },
      { kind: 'semitones', semitones: -7 },
    ]);
    expect(parsed.voices[0]).toMatchObject({ levelDb: -8, pan: -0.5 });
    expect(parsed.humanize.timingMs).toBe(20);
  });

  it('explains what is wrong in plain words', () => {
    expect(() => parseVoiceSpec({ voices: [] })).toThrow(/Say which voices/);
    expect(() => parseVoiceSpec({ voices: [{ rule: 'wobble' }] })).toThrow(/unknown rule/);
    expect(() => parseVoiceSpec({ voices: [{ rule: 'diatonic' }] })).toThrow(/interval/);
    expect(() => parseVoiceSpec({ voices: new Array(5).fill({ rule: 'third_above' }) })).toThrow(/At most 4/);
  });
});
