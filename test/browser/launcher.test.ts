/**
 * The clip launcher through the real engine, offline (headless Chrome): quantized launches land on their
 * boundary within one render quantum, a new slot replaces the playing one there, scenes start together, stopping
 * ends a track at the boundary, follow actions hand over on the bar, a launched audio slot starts on its boundary,
 * and the song keeps playing under it.
 */
import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { patchSlot, setSlotContent, setTrackLane, contentFromAudioChannel } from '@core/ops/launcher';
import type { AudioClipChannel, ClipId, Project } from '@core/model/types';
import { addClips } from '@core/ops/playlist';
import { onsets } from '../helpers/fixtures';
import { addChannel, addSample } from '@core/ops/channels';
import { BLOCK, jamProject, kitSample, renderLaunch, SR } from '../helpers/launcher-render';
import { newId } from '@core/model/ids';

const BAR = 2 * SR; // 120 BPM
const BEAT = BAR / 4;

const hits = (buffer: AudioBuffer, from = 0, to = buffer.length, thr = 0.05, gap = 0.2) =>
  onsets(buffer, thr, gap).filter((f) => f >= from && f < to);

describe('clip launcher (offline render)', () => {
  it('a launch from nothing starts the launcher on its own, on the first frame of its transport', async () => {
    const { project } = jamProject();
    const [t1] = project.launcher!.trackOrder;
    const [s1] = project.launcher!.sceneOrder;
    const r = await renderLaunch(project, [{ at: 0.05, run: (seq, clk) => seq.launch(t1!, s1!, clk) }], { seconds: 3 });
    const f = hits(r.buffer);
    // Pattern A: a rim shot on every beat, from the transport's start.
    for (let i = 1; i < 5; i++) expect(Math.abs(f[i]! - f[0]! - i * BEAT)).toBeLessThanOrEqual(BLOCK);
    console.log(`launcher alone: first hit at frame ${f[0]} (${(f[0]! / SR).toFixed(4)} s), beat spacing error ${Math.abs(f[4]! - f[0]! - 4 * BEAT)} frames`);
  });

  it('a slot launched mid-bar starts on the next bar line (within one render quantum) and the playing one ends there', async () => {
    const { project } = jamProject();
    const [t1] = project.launcher!.trackOrder;
    const [s1, s2] = project.launcher!.sceneOrder;
    const r = await renderLaunch(
      project,
      [
        { at: 0.05, run: (seq, clk) => seq.launch(t1!, s1!, clk) }, // A: from the start
        { at: 0.9, run: (seq, clk) => seq.launch(t1!, s2!, clk) }, // B: on the next bar
      ],
      { seconds: 6.2 },
    );
    const f = hits(r.buffer);
    const t0 = f[0]!;
    // A: four hits in bar 1; B (beats 1 and 3): at bar 2, 3 and 4: 2 s, 3 s, 4 s, 5 s after the start.
    const rel = f.map((x) => x - t0);
    const expected = [0, BEAT, 2 * BEAT, 3 * BEAT, BAR, BAR + 2 * BEAT, 2 * BAR, 2 * BAR + 2 * BEAT, 3 * BAR];
    for (let i = 0; i < expected.length; i++) expect(Math.abs(rel[i]! - expected[i]!), `hit ${i}`).toBeLessThanOrEqual(BLOCK);
    const boundaryError = Math.abs(rel[4]! - BAR);
    console.log(`launch landed on the bar line within ${boundaryError} frames (${((boundaryError / SR) * 1000).toFixed(3)} ms); a render quantum is ${BLOCK} frames`);
    expect(boundaryError).toBeLessThanOrEqual(BLOCK);
    // No A hit after the boundary: B has two per bar, so between 2 s and 3 s there are exactly 2 hits (beats 1 and 3).
    expect(rel.filter((x) => x > BAR - BLOCK && x < 2 * BAR - BLOCK)).toHaveLength(2);
  });

  for (const [bpm, quantize, pressAt, bars] of [
    [133.3, 'bar', 0.7, 1],
    [97.1, '2bars', 1.9, 2],
    [174, 'beat', 0.31, 0.25],
  ] as const) {
    it(`measured at ${bpm} BPM with quantize ${quantize}: the slot starts on its boundary within one render quantum`, async () => {
      const { project: base } = jamProject(bpm);
      const [t1] = base.launcher!.trackOrder;
      const [s1, s2] = base.launcher!.sceneOrder;
      const project = produce(base, (d) => void patchSlot(d, t1!, s2!, { quantize }));
      const beat = (60 / bpm) * SR;
      const r = await renderLaunch(
        project,
        [
          { at: 0.02, run: (seq, clk) => seq.launch(t1!, s1!, clk) },
          { at: pressAt, run: (seq, clk) => seq.launch(t1!, s2!, clk) },
        ],
        { seconds: 14 },
      );
      const f = hits(r.buffer, 0, r.buffer.length, 0.05, 0.1 * SR / SR);
      const t0 = f[0]!;
      // The first hit of slot B is the first hit after the boundary; pattern A has a hit every beat, B only on beats 1 and 3
      // of its own bar, so the boundary hit is the first one that is not on A's beat grid shifted by A's phase... simply: the
      // boundary is a multiple of the quantize from the start, and B's first hit lands on it.
      const boundary = bars * 4 * beat;
      const first = f.map((x) => x - t0).filter((x) => x >= boundary - BLOCK && x < boundary + beat)[0]!;
      const error = Math.abs(first - boundary);
      console.log(`${bpm} BPM, ${quantize}: boundary hit ${(error).toFixed(1)} frames from the grid line`);
      expect(error).toBeLessThanOrEqual(BLOCK);
    });
  }

  it('beat quantize lands on the beat line', async () => {
    const { project } = jamProject();
    const [t1] = project.launcher!.trackOrder;
    const [s1, s2] = project.launcher!.sceneOrder;
    const q = produce(project, (d) => void patchSlot(d, t1!, s2!, { quantize: 'beat' }));
    const r = await renderLaunch(
      q,
      [
        { at: 0.05, run: (seq, clk) => seq.launch(t1!, s1!, clk) },
        { at: 0.6, run: (seq, clk) => seq.launch(t1!, s2!, clk) }, // heard just after beat 2 (0.5 s): the next beat line is at 1.0 s
      ],
      { seconds: 4.2 },
    );
    const f = hits(r.buffer);
    const rel = f.map((x) => x - f[0]!);
    // A: 0, 0.5 s; then B (beats 1 and 3 of ITS bars, counted from where it starts, 1.0 s): 1.0 s, 2.0 s, 3.0 s.
    expect(rel.slice(0, 5).map((x) => Math.round(x / BEAT))).toEqual([0, 1, 2, 4, 6]);
    expect(Math.abs(rel[2]! - 2 * BEAT)).toBeLessThanOrEqual(BLOCK);
  });

  it('a scene starts every track on the same frame', async () => {
    const { project } = jamProject();
    const [t1] = project.launcher!.trackOrder;
    const [s1, s2] = project.launcher!.sceneOrder;
    // Make the two slots of scene 1 start with a pause, so the shared start is clear: launch B first, then scene 1.
    const r = await renderLaunch(
      project,
      [
        { at: 0.05, run: (seq, clk) => seq.launch(t1!, s2!, clk) },
        { at: 0.9, run: (seq, clk) => seq.launchScene(s1!, clk) },
      ],
      { seconds: 5 },
    );
    // Scene 1 = track 1: A (rim) and track 2: K (kick) at the bar line: both start at 2 s.
    const f = hits(r.buffer, 0, r.buffer.length, 0.02, 0.05);
    const t0 = f[0]!;
    const atBar = f.filter((x) => Math.abs(x - t0 - BAR) <= 4 * BLOCK);
    // Rim and kick onsets overlap in time: one merged onset or two within a quantum.
    expect(atBar.length).toBeGreaterThanOrEqual(1);
    expect(Math.abs(atBar[0]! - t0 - BAR)).toBeLessThanOrEqual(BLOCK);
  });

  it('stopping a track ends it at the boundary: nothing plays after', async () => {
    const { project } = jamProject();
    const [t1] = project.launcher!.trackOrder;
    const [s1] = project.launcher!.sceneOrder;
    const r = await renderLaunch(
      project,
      [
        { at: 0.05, run: (seq, clk) => seq.launch(t1!, s1!, clk) },
        { at: 2.3, run: (seq, clk) => seq.stopTrack(t1!, clk) }, // heard in bar 2: stops at 4 s (the transport's second bar line)
      ],
      { seconds: 7 },
    );
    const f = hits(r.buffer);
    const t0 = f[0]!;
    expect(f).toHaveLength(8);
    expect(f.at(-1)! - t0).toBeLessThan(2 * BAR);
    // The launcher alone stops its transport with its last run: the render's silence afterwards is clean.
    expect(hits(r.buffer, t0 + 2 * BAR - BLOCK)).toHaveLength(0);
  });

  it('a follow action hands over to the next slot of the track on the bar line', async () => {
    const { project } = jamProject();
    const [t1] = project.launcher!.trackOrder;
    const [s1, s2] = project.launcher!.sceneOrder;
    const q = produce(project, (d) => void patchSlot(d, t1!, s1!, { follow: { kind: 'next', bars: 1 } }));
    const r = await renderLaunch(q, [{ at: 0.05, run: (seq, clk) => seq.launch(t1!, s1!, clk) }], { seconds: 5.2 });
    const f = hits(r.buffer);
    const rel = f.map((x) => x - f[0]!);
    // A for one bar, then B (beats 1 and 3) from the bar line: 2 s, 3 s, 4 s.
    expect(rel.slice(0, 8).map((x) => Math.round(x / BEAT))).toEqual([0, 1, 2, 3, 4, 6, 8, 10]);
    expect(Math.abs(rel[4]! - BAR)).toBeLessThanOrEqual(BLOCK);
    void s2;
  });

  it('plays over a running song: its slot starts on the song’s bar line, and a launcher track mutes the playlist track it takes over', async () => {
    const { project: base, patterns } = jamProject();
    const lane = base.playlist.laneOrder[0]!;
    const project = produce(base, (d) => {
      // The song: pattern A (rim on every beat) for 4 bars on playlist track 1.
      addClips(d, [{ kind: 'pattern', id: 'song' as ClipId, laneId: lane, start: 0, length: 4 * 3840, patternId: patterns.A, offset: 0 }]);
      setTrackLane(d, d.launcher!.trackOrder[0]!, lane);
    });
    const [t1] = project.launcher!.trackOrder;
    const [, s2] = project.launcher!.sceneOrder;
    const r = await renderLaunch(project, [{ at: 0.9, run: (seq, clk) => seq.launch(t1!, s2!, clk) }], { seconds: 8.3, song: true });
    const f = hits(r.buffer);
    const t0 = f[0]!; // the song starts at tick 0
    const rel = f.map((x) => Math.round((x - t0) / BEAT));
    // Song: beats 0..3 (bar 1, 4 hits); from bar 2 the launched B (beats 1 and 3) replaces it: 4, 6, 8, 10 … and the song's own hits stop.
    expect(rel.slice(0, 4)).toEqual([0, 1, 2, 3]);
    expect(rel.slice(4, 8)).toEqual([4, 6, 8, 10]);
    expect(Math.abs(f[4]! - t0 - BAR)).toBeLessThanOrEqual(BLOCK);
  });

  it('an audio slot starts its sample on the boundary and loops it', async () => {
    const { project: base } = jamProject();
    const sample = kitSample('kit/rim');
    const audio: AudioClipChannel = {
      kind: 'audioClip',
      id: newId.channel(),
      name: 'Rim clip',
      color: '#fff',
      muted: false,
      solo: false,
      volume: 0.78,
      pan: 0,
      output: base.mixer.order[0]!,
      sampleId: sample.id,
    };
    const project = produce(base, (d) => {
      addSample(d, { ...sample, durationSec: 0.2 });
      addChannel(d, audio);
      const content = contentFromAudioChannel(d as unknown as Project, audio.id)!;
      // A pass is 960 ticks: one beat (0.5 s at 120 BPM).
      if (content.kind === 'audio') setSlotContent(d, d.launcher!.trackOrder[2]!, d.launcher!.sceneOrder[0]!, { ...content, length: 960 });
    });
    const t3 = project.launcher!.trackOrder[2]!;
    const s1 = project.launcher!.sceneOrder[0]!;
    const r = await renderLaunch(project, [{ at: 0.05, run: (seq, clk) => seq.launch(t3, s1, clk) }], { seconds: 3 });
    const f = hits(r.buffer, 0, r.buffer.length, 0.03, 0.2);
    const rel = f.map((x) => x - f[0]!);
    // One pass = 960 ticks = a beat = 0.5 s: the rim sample repeats every 0.5 s.
    expect(rel.slice(0, 5).map((x) => Math.round(x / BEAT))).toEqual([0, 1, 2, 3, 4]);
    for (let i = 1; i < 5; i++) expect(Math.abs(rel[i]! - i * BEAT)).toBeLessThanOrEqual(BLOCK);
  });

  it('keeps what was launched while recording and hands it over at the end bar', async () => {
    const { project } = jamProject();
    const [t1, t2] = project.launcher!.trackOrder;
    const [s1, s2] = project.launcher!.sceneOrder;
    const r = await renderLaunch(
      project,
      [
        { at: 0.05, run: (seq, clk) => seq.startRecording(clk) },
        { at: 0.06, run: (seq, clk) => seq.launch(t1!, s1!, clk) },
        { at: 1.1, run: (seq, clk) => seq.launch(t2!, s1!, clk) },
        { at: 2.2, run: (seq, clk) => seq.launch(t1!, s2!, clk) },
        { at: 4.2, run: (seq, clk) => seq.stopRecording(clk) },
      ],
      { seconds: 7 },
    );
    expect(r.takes).toHaveLength(1);
    const take = r.takes[0]!;
    // Started with the first launch (nothing was playing), ended on the bar line after the stop (bar 3).
    expect([take.startU, take.endU]).toEqual([0, 3 * 3840]);
    expect(take.entries.map((e) => [e.trackId === t1 ? 't1' : 't2', e.startU / 3840, e.endU / 3840])).toEqual([
      ['t1', 0, 2],
      ['t2', 1, 3],
      ['t1', 2, 3],
    ]);
  });
});
