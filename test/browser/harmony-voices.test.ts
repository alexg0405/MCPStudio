/**
 * A harmony voice plays through the real engine (the offline render exports use): the clip made from a rendered voice sounds a
 * diatonic third above the lead, in time with it, while the lead alone sounds as sung. The planning and the render themselves are
 * checked in core/harmony/voices.
 */
import { describe, expect, it } from 'vitest';
import { humanizeNotes, planTargets, renderHarmonyVoice, shiftsFromTargets, type LeadNote, type SourceNote } from '@core/harmony/voices';
import { midiToHz } from '@core/voice/pitch';
import { analyzePitch } from '@core/voice/pitch-notes';
import type { AudioClip, Project } from '@core/model/types';
import { renderOffline } from '@engine/render-offline';
import { audioClipProject, TestSamples } from '../helpers/audio';
import { resolver } from '../helpers/fixtures';
import { centsBetween, peakFrequency, sing } from '../helpers/sung';

const SR = 48000;
const BAR = 3840;
const LIMITER = Math.round(0.0013 * SR);
const A_MINOR = { root: 9, scale: 'minor' };

async function render(project: Project, samples: TestSamples) {
  const r = await renderOffline(project, {
    plugins: resolver(),
    samples: samples.provider,
    view: { mode: 'song', patternId: null, loop: null },
    bars: 1,
    sampleRate: SR,
    tail: 0.2,
  });
  const start = Math.round(r.preRoll * SR) + LIMITER;
  return r.buffer.getChannelData(0).subarray(start);
}

describe('harmony voices in the engine', () => {
  it('a third-above voice clip plays C5 over a lead sung on A4, and the lead plays A4', async () => {
    const lead = sing([{ from: 0.1, to: 1.7, midi: 69 }], SR, 1.9);
    const notes: SourceNote[] = analyzePitch(lead, SR).notes.map((n) => ({ from: n.from, to: n.to, pitch: n.pitch }));
    const leadNotes: LeadNote[] = notes.map((n) => ({ pitch: n.pitch, startTick: n.from * 1920, endTick: n.to * 1920 }));
    const [targets] = planTargets(leadNotes, [{ kind: 'interval', steps: 2 }], { key: A_MINOR, chordTonesAt: () => null });
    const [voice] = renderHarmonyVoice({
      channels: [lead],
      sampleRate: SR,
      start: 0,
      notes,
      shifts: shiftsFromTargets(leadNotes, targets as number[]),
      humanize: humanizeNotes(notes.length, { timingMs: 0, driftCents: 0, vibrato: 0 }, 1),
      formantCents: 0,
    });

    const samples = new TestSamples();
    const leadSample = samples.add([lead, lead.slice()], SR, 'vocal');
    const voiceSample = samples.add([voice as Float32Array, (voice as Float32Array).slice()], SR, 'vocal harmony');
    const { project, clipIds } = audioClipProject(leadSample, [{ start: 0, length: BAR }]);
    const leadClip = project.playlist.clips[clipIds[0]!] as AudioClip;
    const leadChannel = project.channels[leadClip.channelId]!;
    // The voice: the same clip on its own channel and track, as "Make harmonies" writes it.
    const withVoice = (muteLead: boolean): Project => {
      const channelId = 'ch_voice' as typeof leadClip.channelId;
      const voiceClip: AudioClip = { ...leadClip, id: 'clip_voice' as typeof leadClip.id, channelId };
      return {
        ...project,
        samples: { ...project.samples, [voiceSample.id]: voiceSample },
        channels: {
          ...project.channels,
          [leadClip.channelId]: { ...leadChannel, muted: muteLead },
          [channelId]: { ...leadChannel, id: channelId, name: 'vocal harmony', sampleId: voiceSample.id, muted: !muteLead },
        },
        channelOrder: [...project.channelOrder, channelId],
        playlist: { ...project.playlist, clips: { ...project.playlist.clips, [voiceClip.id]: voiceClip } },
      };
    };
    const span = [Math.round(0.5 * SR), Math.round(1.5 * SR)] as const;
    const hears = async (p: Project, midi: number) => {
      const out = await render(p, samples);
      const want = midiToHz(midi);
      return centsBetween(peakFrequency(out, SR, 3 * want, span[0], span[1], 24), 3 * want);
    };
    // Only the voice sounds (lead muted): C5, 72 in MIDI. Only the lead: A4.
    expect(Math.abs(await hears(withVoice(true), 72))).toBeLessThan(5);
    expect(Math.abs(await hears(withVoice(false), 69))).toBeLessThan(5);
  }, 120_000);
});
