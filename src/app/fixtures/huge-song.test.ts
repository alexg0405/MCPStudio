import { produce } from 'immer';
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyProject } from '@core/model/defaults';
import { seededBytes, setIdSource } from '@core/model/ids';
import { repairProject } from '@core/schema/repair';
import { registerBuiltinPlugins } from '../plugins/discover';
import { PluginRegistry } from '../plugins/registry';
import { buildHugeSong, HUGE_PLUGIN_IDS, HUGE_SIZE, SMALL_HUGE_SIZE } from './huge-song';

beforeEach(() => setIdSource(seededBytes(9)));

const build = (size = HUGE_SIZE) => produce(createEmptyProject({ now: new Date(0) }), (d) => void buildHugeSong(d, size));

describe('the huge song fixture', () => {
  it('has the counts the speed work promises', () => {
    const project = build();
    const channels = Object.values(project.channels);
    const noteCount = Object.values(project.patterns).reduce(
      (sum, pattern) => sum + Object.values(pattern.notes).reduce((n, notes) => n + Object.keys(notes).length, 0),
      0,
    );
    const clips = Object.values(project.playlist.clips);
    expect(channels.filter((c) => c.kind !== 'automation')).toHaveLength(200);
    expect(channels.filter((c) => c.kind === 'audioClip').length).toBeGreaterThan(30);
    expect(project.mixer.order).toHaveLength(101);
    for (const id of project.mixer.order.slice(1)) {
      const effects = project.mixer.inserts[id]!.fx.length;
      expect(effects).toBeGreaterThanOrEqual(3);
      expect(effects).toBeLessThanOrEqual(7);
    }
    expect(project.patternOrder).toHaveLength(500);
    expect(noteCount).toBeGreaterThan(20000);
    expect(clips).toHaveLength(2000);
    expect(clips.filter((c) => c.kind === 'automation')).toHaveLength(300);
    expect(Object.keys(project.chords ?? {}).length).toBe(300);
    expect(Object.keys(project.lyrics ?? {}).length).toBeGreaterThan(500);
    expect(Math.max(...clips.map((c) => (c.start + c.length) / 3840))).toBeLessThanOrEqual(300);
  });

  it('is the same project every time and needs no repairs', () => {
    const first = build();
    setIdSource(seededBytes(9));
    expect(build()).toEqual(first);
    expect(repairProject(first).repairs).toEqual([]);
    expect(repairProject(build(SMALL_HUGE_SIZE)).repairs).toEqual([]);
  });

  it('keeps clips on one track from overlapping', () => {
    const project = build();
    const byLane = new Map<string, { start: number; end: number }[]>();
    for (const clip of Object.values(project.playlist.clips)) {
      const list = byLane.get(clip.laneId) ?? [];
      list.push({ start: clip.start, end: clip.start + clip.length });
      byLane.set(clip.laneId, list);
    }
    for (const list of byLane.values()) {
      list.sort((a, b) => a.start - b.start);
      list.forEach((span, i) => i > 0 && expect(span.start).toBeGreaterThanOrEqual(list[i - 1]!.end));
    }
  });

  it('uses only plugins that exist', () => {
    const registry = new PluginRegistry();
    registerBuiltinPlugins(registry);
    for (const id of HUGE_PLUGIN_IDS) expect(registry.get(id), id).toBeDefined();
  });
});
