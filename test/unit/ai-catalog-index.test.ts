/**
 * The catalog index (src/app/ai/catalog-index.ts): the table of contents in Studio's system prompt. It has to be small, say what
 * each thing is in a few words, and be byte-identical for the same installed plugins and commands, so the AI's prompt cache
 * reuses the system prompt from chat to chat. Its version changes exactly when the installed things do.
 */
import { describe, expect, it } from 'vitest';
import { defineEffect, p, type PluginDef } from '@agstudio/sdk';
import { createTestServices } from '@app/testing';
import { catalogIndex, diffIndex, shortCommandLabel, summarize } from '@app/ai/catalog-index';
import { registerFeatures } from '@ui/features';

function app() {
  const s = createTestServices();
  registerFeatures(s);
  return s;
}

/** A plugin of the musician's own, as the plugins folder would make one. */
const userEffect = (id: string, name: string, description = 'Does a thing to the sound in a few words.') =>
  defineEffect({
    id,
    name,
    version: 1,
    description,
    category: 'Mine',
    params: { amount: p.float(0, 1, 0.5) },
    create: () => {
      throw new Error('not in tests');
    },
  }) as PluginDef;

const installUserPlugins = (s: ReturnType<typeof app>, defs: PluginDef[]) =>
  s.plugins.sync(
    'user',
    defs.map((def) => ({ path: `/plugins/${def.id}.ts`, def })),
  );

describe('the catalog index', () => {
  it('has one line per plugin: id, name, kind, category, a few words about it, the preset count', () => {
    const { text } = catalogIndex(app());
    expect(text).toMatch(/^agstudio\.reverb \| Reverb \| effect \| Reverb \| Stereo reverb: .+ \| 5 presets$/m);
    expect(text).toMatch(/^agstudio\.bass808 \| 808 Bass \| instrument \| Synths \| .+ \| \d+ presets$/m);
    const lines = text.split('\n').filter((line) => /^agstudio\.[a-z0-9-]+ \| /.test(line) && !line.startsWith('agstudio.notes.'));
    expect(lines.length).toBeGreaterThanOrEqual(30);
    for (const line of lines) {
      const [id, name, kind, category, description, presets] = line.split(' | ');
      expect(['instrument', 'effect'], id).toContain(kind);
      expect(name, id).toBeTruthy();
      expect(category, id).toBeTruthy();
      const words = description!.trim().split(/\s+/).length;
      expect(words, `${id}: ${description}`).toBeLessThanOrEqual(10);
      expect(words, `${id}: ${description}`).toBeGreaterThanOrEqual(3);
      expect(description, id).not.toMatch(/[.,;:]$|\b(and|with|to|of|the|a)$/);
      expect(presets, id).toMatch(/^\d+ presets?$/);
    }
  });

  it('has no settings, ranges or presets by name: those come as details', () => {
    const { text } = catalogIndex(app());
    expect(text).not.toMatch(/params:|float -?\d|one of |presets: /);
  });

  it('has one line per command area, with ids and very short labels (a star marks an argument)', () => {
    const { text } = catalogIndex(app());
    const transport = text.split('\n').find((line) => line.startsWith('Transport: '))!;
    expect(transport).toContain('transport.metronome');
    expect(transport).toMatch(/transport\.countIn\*/);
    expect(transport).toContain('transport.tapTempo');
    // a label is at most three words, and is left out when the id already says it
    expect(transport).not.toMatch(/transport\.metronome "/);
    for (const entry of transport.slice('Transport: '.length).split(', ')) {
      const label = /"([^"]*)"/.exec(entry)?.[1];
      if (label) expect(label.split(/\s+/).length, entry).toBeLessThanOrEqual(3);
    }
    expect(text).toMatch(/^Piano roll: .*pianoRoll\.copy/m);
  });

  it('is small enough for a system prompt', () => {
    expect(catalogIndex(app()).text.length).toBeLessThan(24_000);
  });

  it('says what it is and how to look more up, in the same words every time', () => {
    const { text } = catalogIndex(app());
    expect(text).toContain('This is the catalog index');
    expect(text).toContain('get_plugin_details');
    expect(text).toContain('search_catalog');
    expect(text).toMatch(/Catalog index v[a-z0-9]+: \d+ plugins, \d+ piano-roll tools, \d+ chains, \d+ MIDI effects, \d+ commands\./);
  });
});

describe('the catalog index is the same while the catalog is', () => {
  it('byte for byte, in two apps started separately', () => {
    expect(catalogIndex(app()).text).toBe(catalogIndex(app()).text);
  });

  it('whatever order the musician’s plugins were loaded in, with theirs after the built-in ones, by id', () => {
    const first = app();
    const second = app();
    const b = userEffect('user.bravo', 'Bravo');
    const a = userEffect('user.alpha', 'Alpha');
    installUserPlugins(first, [b, a]);
    installUserPlugins(second, [a, b]);
    const text = catalogIndex(first).text;
    expect(text).toBe(catalogIndex(second).text);
    const at = (id: string) => text.indexOf(`\n${id} | `);
    expect(at('user.alpha')).toBeGreaterThan(at('agstudio.vocoder'));
    expect(at('user.alpha')).toBeLessThan(at('user.bravo'));
  });

  it('has no timestamp, session or random id in it', () => {
    const { text } = catalogIndex(app());
    expect(text).not.toMatch(/\b(ch|ins|fx|pat|clip|mk)_[A-Za-z0-9_-]{6,}/);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{10,}/);
  });

  it('keeps the same version when the musician saves a preset or a chain (those are not installations)', () => {
    const s = app();
    const before = catalogIndex(s);
    const osc = s.plugins.get('agstudio.3xosc')!;
    s.presets.save({ pluginId: osc.id, version: osc.version, name: 'Glass keys', params: { cutoff: 2345 } });
    expect(catalogIndex(s)).toMatchObject({ text: before.text, version: before.version });
  });

  it('changes the version when a plugin is installed, changed or removed', () => {
    const s = app();
    const base = catalogIndex(s);
    installUserPlugins(s, [userEffect('user.alpha', 'Alpha')]);
    const installed = catalogIndex(s);
    expect(installed.version).not.toBe(base.version);
    expect(installed.text).toContain('user.alpha | Alpha | effect | Mine |');
    installUserPlugins(s, [userEffect('user.alpha', 'Alpha', 'Now does something else to the sound.')]);
    const changed = catalogIndex(s);
    expect(changed.version).not.toBe(installed.version);
    installUserPlugins(s, []);
    expect(catalogIndex(s).version).toBe(base.version);
  });

  it('changes the version when a command is added', () => {
    const s = app();
    const base = catalogIndex(s);
    s.commands.register({ id: 'test.thing', title: 'Do the thing', hint: 'Does a thing', run: () => {} });
    const next = catalogIndex(s);
    expect(next.version).not.toBe(base.version);
    expect(next.text).toMatch(/^Other: .*test\.thing "Do thing"/m);
  });
});

describe('what changed between two indexes', () => {
  it('lists added, changed and removed lines', () => {
    const s = app();
    const before = catalogIndex(s);
    installUserPlugins(s, [userEffect('user.alpha', 'Alpha'), userEffect('user.bravo', 'Bravo')]);
    const withTwo = catalogIndex(s);
    installUserPlugins(s, [userEffect('user.alpha', 'Alpha', 'Changed words for the sound.')]);
    const next = catalogIndex(s);

    expect(diffIndex(before.lines, before.lines)).toEqual({ added: [], changed: [], removed: [] });
    const added = diffIndex(before.lines, withTwo.lines);
    expect(added.added.map((line) => line.split(' | ')[0])).toEqual(['user.alpha', 'user.bravo']);
    expect(added.changed).toEqual([]);
    const later = diffIndex(withTwo.lines, next.lines);
    expect(later.changed.map((line) => line.split(' | ')[0])).toEqual(['user.alpha']);
    expect(later.removed).toEqual(['effect:user.bravo']);
  });
});

describe('short descriptions', () => {
  it('keeps the first sentence, drops parentheses, and cuts on a phrase, never on a little word', () => {
    expect(summarize('Sine bass with pitch punch, long decay and drive; overlapping notes glide (mono, legato).')).toBe(
      'Sine bass with pitch punch, long decay and drive',
    );
    expect(summarize('Three oscillators into a resonant low-pass filter with amp and filter envelopes.')).not.toMatch(
      /\b(and|with)$/,
    );
    expect(summarize('Silences a track between its hits (or whenever another track is quiet, with a sidechain).')).toBe(
      'Silences a track between its hits',
    );
    expect(summarize('')).toBe('');
  });

  it('shortens a command title to three words, or to nothing when the id says it', () => {
    expect(shortCommandLabel('Save', 'file.save')).toBe('');
    expect(shortCommandLabel('Export as MP3', 'file.exportMp3')).toBe('Export as MP3');
    expect(shortCommandLabel('Freeze channel to audio', 'channels.freeze')).toBe('Freeze channel');
    expect(shortCommandLabel('Put an effect chain on the selected mixer track', 'mixer.applyChain')).toBe('Put effect chain');
  });
});
