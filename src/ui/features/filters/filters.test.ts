import { describe, expect, it } from 'vitest';
import { FILTERS } from '@core/filters/presets';
import type { AudioClipChannel, Clip, ClipId, MarkerId } from '@core/model/types';
import { addMarker } from '@core/ops/markers';
import { registerFeatures } from '@ui/features';
import { BAR, project, stackedSong } from '../../../../test/helpers/focus';
import type { MenuEntry } from '../../controls/ContextMenu';
import { extraMenuItems } from '../../context-menus';
import { getActionProviders } from '../../shell/actions';

const labels = (items: MenuEntry[]) => [...new Set(items.flatMap((i) => ('label' in i ? [i.label] : [])))];
const sub = (items: MenuEntry[], label: string): MenuEntry[] => {
  const e = items.find((i) => i.kind === 'submenu' && i.label === label);
  if (!e || e.kind !== 'submenu') throw new Error(`no submenu “${label}” in ${labels(items).join(' | ')}`);
  return typeof e.items === 'function' ? e.items() : e.items;
};

function setup() {
  const { s } = stackedSong();
  registerFeatures(s);
  return s;
}

describe('sound filter menus', () => {
  it('names the part in each right-click menu and lists every filter in two groups', () => {
    const s = setup();
    let chorus!: MarkerId;
    s.history.transact('marker', (d) => {
      chorus = addMarker(d, 16 * BAR, 'Chorus');
      addMarker(d, 24 * BAR, 'Verse 2');
    });
    const p = project(s);
    const clip = Object.values(p.playlist.clips).find((c) => c.kind === 'pattern' && c.start === 0) as Clip;
    const clipMenu = extraMenuItems('playlist.clip', { clip }, s);
    const items = sub(clipMenu, 'Filter this clip');
    expect(labels(items)).toEqual(['Speed and pitch', ...FILTERS.filter((f) => f.group === 'speed').map((f) => f.name), 'Tone', ...FILTERS.filter((f) => f.group === 'tone').map((f) => f.name)]);
    const nightcore = items.find((i) => 'label' in i && i.label === 'Nightcore');
    expect(nightcore && 'hint' in nightcore ? nightcore.hint : '').toMatch(/faster.*shorter/);
    expect(labels(extraMenuItems('playlist.marker', { markerId: chorus }, s))).toContain('Filter “Chorus” (bars 17–24)');
    expect(labels(extraMenuItems('playlist.empty', { tick: 20 * BAR + 5, laneId: p.playlist.laneOrder[0]! }, s))).toContain('Filter “Chorus” (bars 17–24)');
    s.view.getState().setLoop({ start: 4 * BAR, end: 8 * BAR });
    expect(labels(extraMenuItems('playlist.ruler', { tick: 0 }, s))).toContain('Filter bars 5–8');
    // Past the end of the song nothing plays: no filter offered.
    s.view.getState().setLoop(null);
    expect(labels(extraMenuItems('playlist.empty', { tick: 200 * BAR, laneId: p.playlist.laneOrder[0]! }, s)).some((l) => l.startsWith('Filter'))).toBe(false);
  });

  it('offers Remove filter on a filtered clip, and every filter in the action search', () => {
    const s = setup();
    const p = project(s);
    const clip = Object.values(p.playlist.clips).find((c) => c.kind === 'pattern') as Clip;
    // A filtered clip (as app/filters makes it, without the render).
    s.history.transact('fake filter', (d) => {
      const ch: AudioClipChannel = {
        kind: 'audioClip',
        id: 'ch_filtered' as AudioClipChannel['id'],
        name: 'Telephone (bar 1)',
        color: '#888888',
        muted: false,
        solo: false,
        volume: 1,
        pan: 0,
        output: d.mixer.order[0]!,
        sampleId: 'smp_f' as AudioClipChannel['sampleId'],
        filter: { preset: 'telephone', from: clip.start, to: clip.start + clip.length, originals: [{ ...clip }], pieces: [] },
      };
      d.samples[ch.sampleId] = { id: ch.sampleId, name: 'f', source: { kind: 'builtin', generator: 'kit/kick', version: 1 } };
      d.channels[ch.id] = ch;
      d.channelOrder.push(ch.id);
      delete d.playlist.clips[clip.id];
      d.playlist.clips['f' as ClipId] = { kind: 'audio', id: 'f' as ClipId, laneId: clip.laneId, start: clip.start, length: clip.length, channelId: ch.id, offsetSec: 0 };
    });
    const f = project(s).playlist.clips['f' as ClipId]!;
    const menu = extraMenuItems('playlist.clip', { clip: f }, s);
    const remove = menu.find((i) => (!i.kind || i.kind === 'item') && i.label === 'Remove filter') as Extract<MenuEntry, { label: string; onSelect(): void }> | undefined;
    expect(remove).toBeDefined();
    remove!.onSelect();
    expect(project(s).playlist.clips[clip.id]).toEqual(clip);
    expect(project(s).channels['ch_filtered' as AudioClipChannel['id']]).toBeUndefined();
    expect(s.history.status().undoLabel).toBe('Remove Telephone');

    const actions = getActionProviders().flatMap((pr) => pr(s));
    for (const x of FILTERS) expect(actions.some((a) => a.label === `Filter: ${x.name}`)).toBe(true);
  });
});
