/**
 * Tune pulls a recorded voice to the notes another channel plays (Target = played notes, Guide channel =
 * its position among the instrument channels): the notes travel engine → plugin host → SDK → kernel in a
 * real AudioWorklet, in an offline render (what export uses).
 */
import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import type { Clip, PatternId, Project } from '@core/model/types';
import { addChannel } from '@core/ops/channels';
import { addNotes } from '@core/ops/notes';
import { defaultValues } from '@agstudio/sdk';
import { renderOffline } from '@engine/render-offline';
import bass808 from '../../src/plugins/builtin/bass808';
import tune from '../../src/plugins/builtin/tune';
import { audioClipProject, TestSamples } from '../helpers/audio';
import { resolver, withInsert } from '../helpers/fixtures';
import { note } from '../helpers/notes';
import { centsBetween, peakFrequency, sing } from '../helpers/sung';

const SR = 48000;
const BAR = 3840;
const LIMITER = Math.round(0.0013 * SR);
const C4 = 261.6256;

function build(tuneParams: Record<string, string | number | boolean>, guideKey: number | null) {
  // A voice 45 cents sharp of C4, 3 s.
  const voice = sing([{ from: 0, to: 3, midi: 60.45 }], SR, 3);
  const samples = new TestSamples();
  const ref = samples.add([voice, voice.slice()], SR, 'vocal');
  const { project: base, channelId } = audioClipProject(ref, [{ start: 0, length: 2 * BAR }]);
  // The guide: the first (and only) instrument channel, silent, playing one long note.
  const guide = { ...makeInstrumentChannel('Guide', makePluginInstance(bass808.id, bass808.version, defaultValues(bass808.params))), volume: 0 };
  const pid = base.patternOrder[0] as PatternId;
  const withGuide = produce(base, (d) => {
    addChannel(d, guide);
    if (guideKey !== null) addNotes(d, pid, guide.id, [note('g1', 0, guideKey, 2 * BAR - 10)]);
    const clip: Clip = { kind: 'pattern', id: newId.clip(), laneId: d.playlist.laneOrder[1]!, start: 0, length: 2 * BAR, patternId: pid, offset: 0 };
    d.playlist.clips[clip.id] = clip;
  });
  const { project } = withInsert(withGuide, [channelId], { fx: [{ def: tune, params: { speed: 0, ...tuneParams } }] });
  return { project: project as Project, samples };
}

async function hearsAt(project: Project, samples: TestSamples, guideHz: number): Promise<number> {
  const r = await renderOffline(project, {
    plugins: resolver(),
    samples: samples.provider,
    view: { mode: 'song', patternId: null, loop: null },
    bars: 2,
    sampleRate: SR,
    tail: 0.2,
  });
  const out = r.buffer.getChannelData(0).subarray(Math.round(r.preRoll * SR) + LIMITER);
  // Tune delays the voice by 12 ms and the mixer compensates: measure the steady part.
  const from = Math.round(1.0 * SR);
  const to = Math.round(2.4 * SR);
  return centsBetween(peakFrequency(out, SR, 3 * guideHz, from, to, 40), 3 * guideHz);
}

describe('Tune with a guide melody (real engine, offline render)', () => {
  it('pulls the voice to the note the guide channel plays, and leaves it alone with no guide', async () => {
    // Guide plays C4: the voice (45 cents sharp) lands on it.
    const c4 = build({ source: 'notes', notesFrom: 1 }, 60);
    expect(Math.abs(await hearsAt(c4.project, c4.samples, C4))).toBeLessThan(4);
    // Guide plays D4: the voice follows it up a tone and a bit.
    const d4 = build({ source: 'notes', notesFrom: 1 }, 62);
    expect(Math.abs(await hearsAt(d4.project, d4.samples, 293.6648))).toBeLessThan(5);
    // No guide channel chosen (0), or one that doesn't exist (2): the voice stays 45 cents sharp.
    for (const notesFrom of [0, 2]) {
      const t = build({ source: 'notes', notesFrom }, 60);
      expect(Math.abs((await hearsAt(t.project, t.samples, C4)) - 45)).toBeLessThan(4);
    }
    // The key and scale target ignores the guide.
    const scale = build({ source: 'scale', notesFrom: 1, key: 'C', scale: 'chromatic' }, 62);
    expect(Math.abs(await hearsAt(scale.project, scale.samples, C4))).toBeLessThan(4);
  }, 180_000);
});
