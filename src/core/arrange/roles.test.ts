import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createEmptyProject } from '../model/defaults';
import { buildStackedSong } from '../fixtures/stacked-song';
import { channelRoles, gmDrumRole, ROLE_GROUP, type Role } from './roles';

const hint = (pluginId: string): Role | undefined =>
  pluginId === 'agstudio.bass808' ? '808' : pluginId === 'agstudio.drum-pads' ? 'kit' : undefined;

describe('channel roles', () => {
  it('reads samples, plugins, names and notes', () => {
    let ids!: ReturnType<typeof buildStackedSong>;
    const p = produce(createEmptyProject(), (d) => {
      ids = buildStackedSong(d);
    });
    const roles = channelRoles(p, hint);
    const role = (name: string) => roles.get(ids.channels[name]!);
    expect(
      ['Kick', 'Clap', 'Hat', 'Snare', 'Crash', '808', 'Pluck', 'Dark Pad', 'Choir', 'Organ', 'Riser', 'Reverse Crash', 'Sub Drop', 'Bell Arp', 'Perc', 'Downlifter'].map(
        (n) => [n, role(n)],
      ),
    ).toEqual([
      ['Kick', 'kick'],
      ['Clap', 'clap'],
      ['Hat', 'hat'],
      ['Snare', 'snare'],
      ['Crash', 'crash'],
      ['808', '808'],
      ['Pluck', 'pluck'],
      ['Dark Pad', 'pad'],
      ['Choir', 'pad'],
      ['Organ', 'keys'],
      ['Riser', 'fx'],
      ['Reverse Crash', 'fx'],
      ['Sub Drop', 'fx'],
      ['Bell Arp', 'arp'],
      ['Perc', 'kit'],
      ['Downlifter', 'fx'],
    ]);
    // "Saw Layer" says nothing: its notes (one at a time, above C3) make it a lead.
    expect(role('Saw Layer')).toBe('lead');
    expect(ROLE_GROUP[role('808')!]).toBe('bass');
  });

  it('maps General MIDI drum keys', () => {
    expect([36, 38, 39, 42, 46, 45, 49, 70].map(gmDrumRole)).toEqual(['kick', 'snare', 'clap', 'hat', 'open-hat', 'tom', 'crash', 'perc']);
  });
});
