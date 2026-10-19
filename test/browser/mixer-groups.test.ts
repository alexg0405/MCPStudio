/**
 * Mixer groups, VCAs and snapshot glide in the audio engine (offline renders in headless Chrome): a VCA scales a
 * group like moving its members' faders would, without moving them; its automation follows the curve; a render is
 * bit-identical run to run; and a snapshot recall's fader move glides instead of stepping.
 */
import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import type { ClipId, GroupId, InsertId, LaneId, PatternId, Project } from '@core/model/types';
import { addClips } from '@core/ops/playlist';
import { addVca, createGroup, removeGroup, removeVca, setVcaLevel } from '@core/ops/groups';
import { setInsertProp } from '@core/ops/mixer';
import { captureSnapshot } from '@core/snapshots/capture';
import { recallSnapshot } from '@core/snapshots/recall';
import type { DocChange } from '@core/history/history';
import { Engine } from '@engine/engine';
import { type PluginDef } from '@agstudio/sdk';
import { automate, pt } from '../helpers/automation';
import { kitProject, maxDiff, resolver, withInsert } from '../helpers/fixtures';
import { heldNote, tone } from '../helpers/tone';

const SR = 48000;
const BAR = 3840;
const dbToGain = (db: number) => 10 ** (db / 20);

/** Kick, snare and hats on three tracks. */
function drums() {
  const { project, patternId, channels } = kitProject([
    { generator: 'kit/kick', steps: [0, 8] },
    { generator: 'kit/snare', steps: [4, 12] },
    { generator: 'kit/hat-closed', steps: [2, 6, 10, 14] },
  ]);
  let doc = project;
  const inserts: InsertId[] = [];
  channels.forEach((channel, i) => {
    const routed = withInsert(doc, [channel], { index: i + 1 });
    doc = routed.project;
    inserts.push(routed.insertId);
  });
  return { project: doc, patternId, inserts };
}

/** The pattern played on the playlist, one clip per bar, so song mode (which plays automation) has something to play. */
function onPlaylist(project: Project, patternId: PatternId, bars: number): Project {
  return produce(project, (d) => {
    for (let bar = 0; bar < bars; bar++) {
      addClips(d, [
        {
          kind: 'pattern',
          id: `bar${bar}` as ClipId,
          laneId: d.playlist.laneOrder[0] as LaneId,
          start: bar * BAR,
          length: BAR,
          patternId,
          offset: 0,
        },
      ]);
    }
  });
}

/**
 * Applies the documents in turn to one engine (the first is a load), then renders a bar. `song` plays the playlist
 * (and so its automation) instead of looping the pattern.
 */
async function render(docs: Project[], patternId: PatternId, options: { offline?: boolean; song?: boolean } = {}) {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: SR * 3, sampleRate: SR });
  const engine = new Engine(ctx, { plugins: resolver() }, options.offline ?? true);
  let prev: Project | null = null;
  for (const next of docs) {
    const change: DocChange = prev
      ? { next, prev, patches: [], origin: 'edit' }
      : { next, prev: next, patches: null, origin: 'load' };
    engine.applyDocChange(change);
    prev = next;
  }
  engine.setTransportView({ mode: options.song ? 'song' : 'pattern', patternId, loop: null });
  await engine.ready();
  const preRoll = 2048 / SR;
  engine.startOffline(0, preRoll);
  engine.pumpOffline(preRoll + engine.barSeconds() - 1e-6);
  await engine.syncWorklets();
  const buffer = await ctx.startRendering();
  await engine.dispose();
  return buffer;
}

/** The buffer from `frame` on. */
function slice(buffer: AudioBuffer, frame: number): AudioBuffer {
  const out = new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: buffer.length - frame, sampleRate: buffer.sampleRate });
  for (let c = 0; c < buffer.numberOfChannels; c++) out.copyToChannel(buffer.getChannelData(c).subarray(frame), c);
  return out;
}

function grouped(vca: number | null) {
  const d = drums();
  let id!: GroupId;
  const project = produce(d.project, (draft) => {
    id = createGroup(draft, [d.inserts[0]!, d.inserts[1]!], { name: 'Drums' })!;
    if (vca !== null) addVca(draft, id, vca);
  });
  return { ...d, project, id };
}

describe('VCA in the engine', () => {
  it('scales the members like their faders would, and leaves a track outside the group alone', async () => {
    const { project, patternId, inserts, id } = grouped(1);
    const minus6 = dbToGain(-6);
    const viaVca = produce(project, (d) => setVcaLevel(d, id, minus6));
    const viaFaders = produce(project, (d) => {
      removeGroup(d, id);
      setInsertProp(d, inserts[0]!, 'volume', minus6);
      setInsertProp(d, inserts[1]!, 'volume', minus6);
    });
    const a = await render([viaVca], patternId);
    const b = await render([viaFaders], patternId);
    expect(maxDiff(a, b)).toBeLessThan(1e-6);
    // The faders did not move, and the hats (outside the group) are at full level in both.
    expect(viaVca.mixer.inserts[inserts[0]!]!.volume).toBe(1);
    const plain = await render([produce(project, (d) => void removeGroup(d, id))], patternId);
    expect(maxDiff(a, plain)).toBeGreaterThan(0.01);
  });

  it('is bit-exact with no group at all while the VCA is at 0 dB, or the group has none', async () => {
    const noVca = grouped(null);
    const unity = grouped(1);
    const { patternId } = noVca;
    const plain = await render([produce(noVca.project, (d) => void removeGroup(d, noVca.id))], patternId);
    const noVcaRender = await render([noVca.project], patternId);
    const unityRender = await render([unity.project], patternId);
    expect(maxDiff(noVcaRender, plain)).toBe(0);
    // Different projects have different ids but the same sound, so the unity render is checked against its own group-less copy.
    const unityPlain = await render([produce(unity.project, (d) => void removeGroup(d, unity.id))], patternId);
    expect(maxDiff(unityRender, unityPlain)).toBe(0);
  });

  it('adding, moving and removing a VCA while the engine runs lands on what a fresh engine builds', async () => {
    const { project, patternId, id } = grouped(null);
    const added = produce(project, (d) => addVca(d, id, dbToGain(-9)));
    const moved = produce(added, (d) => setVcaLevel(d, id, dbToGain(-3)));
    const removed = produce(moved, (d) => void removeVca(d, id));
    expect(maxDiff(await render([project, added, moved], patternId), await render([moved], patternId))).toBeLessThan(1e-6);
    expect(maxDiff(await render([project, added, moved, removed], patternId), await render([project], patternId))).toBeLessThan(1e-6);
  });

  it('follows its automation like a fader automation of the same curve (members at unity)', async () => {
    const base = grouped(1);
    const { patternId, inserts, id } = base;
    const project = onPlaylist(base.project, patternId, 2);
    const curve = [pt(0, 0.8), pt(BAR, 0.4)];
    const clip = [{ start: 0, length: 2 * BAR, lane: 1 }];
    const viaVca = automate(project, { kind: 'vca', groupId: id }, curve, clip).project;
    let viaFaders = produce(project, (d) => void removeGroup(d, id));
    for (const insert of [inserts[0]!, inserts[1]!]) {
      viaFaders = automate(viaFaders, { kind: 'insert', insertId: insert, param: 'volume' }, curve, clip).project;
    }
    const a = await render([viaVca], patternId, { song: true });
    const b = await render([viaFaders], patternId, { song: true });
    expect(maxDiff(a, b)).toBeLessThan(1e-5);
    expect(maxDiff(a, await render([project], patternId, { song: true }))).toBeGreaterThan(0.001);
  });

  it('renders bit for bit the same twice with VCA automation (several members sum into the master)', async () => {
    const base = grouped(0.7);
    const { patternId, id } = base;
    const project = onPlaylist(base.project, patternId, 2);
    const curve = [pt(0, 1), pt(BAR / 2, 0.3), pt(BAR, 0.9)];
    const automated = automate(project, { kind: 'vca', groupId: id }, curve, [{ start: 0, length: 2 * BAR, lane: 1 }]).project;
    const first = await render([automated], patternId, { song: true });
    const second = await render([automated], patternId, { song: true });
    expect(maxDiff(first, second)).toBe(0);
  });

  it('a realtime-mode engine and an offline-mode engine agree', async () => {
    const base = grouped(dbToGain(-4.5));
    const { patternId, id } = base;
    const project = onPlaylist(base.project, patternId, 2);
    const curve = [pt(0, 0.9), pt(BAR, 0.5)];
    const automated = automate(project, { kind: 'vca', groupId: id }, curve, [{ start: 0, length: 2 * BAR, lane: 1 }]).project;
    const offlineMode = await render([automated], patternId, { offline: true, song: true });
    const realtimeMode = await render([automated], patternId, { offline: false, song: true });
    // A realtime-mode engine ramps into automation from the document value over its first few milliseconds (for any
    // control), so the comparison starts after the first hit, once both follow the curve.
    const settled = Math.round(0.1 * SR);
    expect(maxDiff(slice(offlineMode, settled), slice(realtimeMode, settled))).toBeLessThan(1e-5);
    expect(maxDiff(offlineMode, realtimeMode)).toBeGreaterThan(0);
  });
});

describe('snapshot recall glide', () => {
  const FADE_AT = 0.5;
  const HOLD = 4;

  /** One tone through one track; at 0.5 s the fader changes, with the glide the recall asks for (or none). */
  async function renderFaderMove(glideSec: number | undefined): Promise<Float32Array> {
    const held = heldNote(tone, HOLD);
    const routed = withInsert(held.project, [held.ch]);
    const snapshot = captureSnapshot(routed.project, 'Quiet', 0);
    const quiet = produce(snapshot, (s) => {
      s.inserts[routed.insertId]!.volume = 0;
    });
    const after = produce(routed.project, (d) => void recallSnapshot(d, quiet));
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(SR * 1.2), sampleRate: SR });
    const engine = new Engine(ctx, { plugins: resolver(tone as PluginDef) }, true);
    engine.applyDocChange({ next: routed.project, prev: routed.project, patches: null, origin: 'load' });
    engine.setTransportView({ mode: 'song', patternId: held.pid, loop: null });
    await engine.ready();
    engine.startOffline(0, 0.01);
    engine.pumpOffline(1.1);
    void ctx.suspend(FADE_AT).then(() => {
      engine.applyDocChange({
        next: after,
        prev: routed.project,
        patches: [],
        origin: 'edit',
        ...(glideSec ? { glideSec } : {}),
      });
      void ctx.resume();
    });
    await engine.syncWorklets();
    const buffer = await ctx.startRendering();
    await engine.dispose();
    return buffer.getChannelData(0).slice();
  }

  /** The largest swing of the signal (peak to peak over one 1 kHz period) around `seconds` after the move. */
  function swing(data: Float32Array, seconds: number): number {
    const start = Math.round((FADE_AT + seconds) * SR);
    let low = Infinity;
    let high = -Infinity;
    for (let i = start; i < start + 48; i++) {
      low = Math.min(low, data[i]!);
      high = Math.max(high, data[i]!);
    }
    return high - low;
  }

  /** The biggest jump between two neighbouring samples around the move. */
  function biggestStep(data: Float32Array): number {
    let step = 0;
    for (let i = Math.round(FADE_AT * SR) - 200; i < Math.round((FADE_AT + 0.15) * SR); i++) {
      step = Math.max(step, Math.abs(data[i]! - data[i - 1]!));
    }
    return step;
  }

  it('glides a fader move over about 30 ms: no step bigger than the tone itself makes, and slower than a plain edit', async () => {
    const stepped = await renderFaderMove(undefined);
    const glided = await renderFaderMove(0.03);
    // A 1 kHz sine at 0.25 moves at most 0.25 · 2π · 1000 / 48000 ≈ 0.033 per sample; a gain step would add its own.
    const natural = (0.25 * 0.78 * 2 * Math.PI * 1000) / SR;
    expect(biggestStep(glided)).toBeLessThan(natural * 1.05);
    expect(biggestStep(stepped)).toBeLessThan(natural * 1.1);
    const before = swing(glided, -0.01);
    expect(before).toBeGreaterThan(0.2);
    // 10 ms in, the plain edit (time constant 4 ms) is nearly gone and the glide (7.5 ms) is not.
    expect(swing(glided, 0.01) / before).toBeGreaterThan(0.2);
    expect(swing(stepped, 0.01) / before).toBeLessThan(0.15);
    // 30 ms in the glide has arrived (within 2%), and it ends at silence.
    expect(swing(glided, 0.03) / before).toBeLessThan(0.05);
    expect(swing(glided, 0.3)).toBeLessThan(1e-4);
  });
});
