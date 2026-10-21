import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '../model/defaults';
import { MASTER, type Project } from '../model/types';
import { missingPlugins, pluginUsage, placeCount } from '../query/plugin-usage';
import { addChannel } from './channels';
import { addFxSlot } from './mixer';
import { renamePluginId } from './plugin-rename';

/** A song with a user instrument, the same user effect on two tracks, and a mixer snapshot that remembers the effect. */
function song(): Project {
  return produce(createEmptyProject(), (d) => {
    addChannel(d, makeInstrumentChannel('Bell', makePluginInstance('user.fm-bell', 2, { pitch: 3 })));
    const slotOn = (insertId: string, id: string) => addFxSlot(d, insertId as never, makePluginInstance('user.tape-stop', 1, { time: 0.5 }), undefined, id as never);
    slotOn(MASTER, 'slot_a');
    const other = d.mixer.order[1]!;
    slotOn(other, 'slot_b');
    d.mixer.inserts[other]!.fx.push({ id: 'slot_c' as never, plugin: makePluginInstance('agstudio.reverb', 1, {}), enabled: true, mix: 1, sidechain: null });
    d.mixSnapshots = [
      {
        id: 'snap_1' as never,
        name: 'A',
        savedAt: 0,
        inserts: {
          [MASTER]: { name: 'Master', volume: 1, pan: 0, muted: false, solo: false, sends: {}, fx: { slot_a: { plugin: 'user.tape-stop', enabled: true, mix: 1, params: { time: 0.5 } } } },
        } as never,
      },
    ];
  });
}

describe('where a plugin is used', () => {
  it('counts instrument channels and effect slots by plugin id', () => {
    const usage = pluginUsage(song());
    expect(usage.get('user.fm-bell')!.channels).toMatchObject([{ name: 'Bell' }]);
    expect(usage.get('user.tape-stop')!.inserts.map((i) => i.slotId)).toEqual(['slot_a', 'slot_b']);
    expect(placeCount(usage.get('user.tape-stop')!)).toBe(2);
    expect(usage.get('agstudio.reverb')!.inserts).toHaveLength(1);
  });

  it('lists only user plugins that are missing, never built-ins', () => {
    const missing = missingPlugins(song(), (id) => id === 'user.fm-bell');
    expect([...missing.keys()]).toEqual(['user.tape-stop']);
    expect([...missingPlugins(song(), () => false).keys()].sort()).toEqual(['user.fm-bell', 'user.tape-stop']);
    expect(missingPlugins(song(), () => true).size).toBe(0);
  });
});

describe('renaming a plugin id in a project', () => {
  it('points channels, effect slots and snapshots at the new id and keeps every setting', () => {
    const before = song();
    let changes = 0;
    const after = produce(before, (d) => void (changes = renamePluginId(d, 'user.tape-stop', 'user.tape-halt')));
    expect(changes).toBe(3);
    expect(after.mixer.inserts[MASTER]!.fx[0]!.plugin).toEqual({ ...before.mixer.inserts[MASTER]!.fx[0]!.plugin, pluginId: 'user.tape-halt' });
    expect(after.mixSnapshots![0]!.inserts[MASTER]!.fx['slot_a' as never]!.plugin).toBe('user.tape-halt');
    expect(pluginUsage(after).has('user.tape-stop')).toBe(false);
    // Everything else is the very same object: a rename touches nothing it does not have to.
    expect(after.channels).toBe(before.channels);
    expect(after.patterns).toBe(before.patterns);
  });

  it('does nothing for the same id or an id that is not used', () => {
    const before = song();
    expect(produce(before, (d) => void renamePluginId(d, 'user.tape-stop', 'user.tape-stop'))).toBe(before);
    expect(produce(before, (d) => void renamePluginId(d, 'user.unused', 'user.other'))).toBe(before);
  });
});
