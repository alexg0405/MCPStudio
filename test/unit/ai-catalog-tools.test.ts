/**
 * The read tools of the catalog (src/app/ai/read/catalog-tools.ts): get_plugin_details, get_commands and search_catalog. They
 * are what the model calls, instead of guessing, for anything the request's attached details do not cover; the Studio chat's
 * `query` action and the MCP server have the same tools.
 */
import { describe, expect, it } from 'vitest';
import { createTestServices } from '@app/testing';
import { pluginCatalog } from '@app/ai/catalog';
import { commandCatalog } from '@app/ai/commands';
import { readTools, runReadTool } from '@app/ai/read';
import { registerFeatures } from '@ui/features';

function app() {
  const s = createTestServices();
  registerFeatures(s);
  return s;
}

type Found = { details?: string; not_found?: { id: string; did_you_mean?: string[] }[]; error?: string; results?: string[] };
const call = (s: ReturnType<typeof app>, tool: string, args: object) => runReadTool(s, tool, args) as Found;

describe('get_plugin_details', () => {
  it('gives the settings and presets of the plugins asked for, in the format of the old catalog', () => {
    const s = app();
    const { details } = call(s, 'get_plugin_details', { ids: ['agstudio.reverb', 'agstudio.ducker'] });
    expect(details).toContain('- agstudio.reverb "Reverb" [Reverb]');
    expect(details).toContain('- agstudio.ducker "Ducker" [Dynamics]');
    // the same lines the whole-catalog tool writes for them
    const whole = pluginCatalog(s.plugins, s.presets).text;
    for (const line of details!.split('\n').filter((l) => l.startsWith('  params: '))) expect(whole).toContain(line);
    expect(details).toMatch(/presets: /);
    expect(details).not.toContain('agstudio.limiter');
  });

  it('finds a plugin by its exact name in any case, a piano-roll tool, and a chain', () => {
    const s = app();
    expect(call(s, 'get_plugin_details', { ids: ['REVERB'] }).details).toContain('- agstudio.reverb "Reverb"');
    expect(call(s, 'get_plugin_details', { ids: ['agstudio.notes.humanize'] }).details).toContain(
      '- agstudio.notes.humanize "Humanize"',
    );
    const chain = call(s, 'get_plugin_details', { ids: ['Rap vocal'] }).details!;
    expect(chain).toContain('- "Rap vocal"');
    expect(chain).toContain('effects, in order:');
  });

  it('includes the musician’s own presets and chains', () => {
    const s = app();
    const osc = s.plugins.get('agstudio.3xosc')!;
    s.presets.save({ pluginId: osc.id, version: osc.version, name: 'Glass keys', params: { cutoff: 2345 } });
    expect(call(s, 'get_plugin_details', { ids: ['agstudio.3xosc'] }).details).toContain("the musician's own presets: Glass keys");
  });

  it('says which ids it did not know, with what they may have meant, and still answers for the rest', () => {
    const s = app();
    const result = call(s, 'get_plugin_details', { ids: ['agstudio.reverb', 'verb', 'file.save'] });
    expect(result.details).toContain('agstudio.reverb');
    expect(result.not_found?.map((n) => n.id)).toEqual(['verb', 'file.save']);
    expect(result.not_found![0]!.did_you_mean).toContain('agstudio.reverb (Reverb)');
    // a command is not a plugin: the other tool has it
    expect(result.not_found![1]).toEqual({ id: 'file.save' });
  });

  it('asks for ids, and for at most twelve at a time', () => {
    const s = app();
    expect(call(s, 'get_plugin_details', {}).error).toMatch(/give ids/);
    expect(call(s, 'get_plugin_details', { ids: Array.from({ length: 13 }, (_, i) => `agstudio.x${i}`) }).error).toMatch(/at most 12/);
  });

  it('is told to the model with its ids required', () => {
    const tool = readTools.find((t) => t.name === 'get_plugin_details')!;
    expect(tool.schema.required).toEqual(['ids']);
    expect(tool.schema.properties.ids).toMatchObject({ type: 'array', items: { type: 'string' } });
  });
});

describe('get_commands', () => {
  it('gives the title, hint and argument of the commands asked for, as the old command list wrote them', () => {
    const s = app();
    const { details } = call(s, 'get_commands', { ids: ['file.save', 'audioClip.gain'] });
    expect(details).toContain('- file.save "Save"');
    expect(details).toMatch(/- audioClip\.gain "Audio clip gain".*args: dB/);
    const whole = commandCatalog(s).text;
    for (const line of details!.split('\n').filter((l) => l.startsWith('- '))) expect(whole).toContain(line);
  });

  it('gives all the commands of an area, by its name in the index or the start of its ids', () => {
    const s = app();
    const byName = call(s, 'get_commands', { area: 'Piano roll' }).details!;
    const byPrefix = call(s, 'get_commands', { area: 'pianoRoll' }).details!;
    expect(byName).toContain('- pianoRoll.copy');
    expect(byName).toContain('- pianoRoll.transpose');
    expect(byPrefix).toBe(byName);
  });

  it('says what the areas are when the area is not one', () => {
    const result = call(app(), 'get_commands', { area: 'Nowhere' });
    expect(result.error).toMatch(/no command area "Nowhere".*Piano roll.*Transport/);
  });

  it('asks for ids or an area', () => {
    expect(call(app(), 'get_commands', {}).error).toMatch(/give ids/);
  });
});

describe('search_catalog', () => {
  const lines = (s: ReturnType<typeof app>, args: object) => call(s, 'search_catalog', args).results!;

  it('finds things by what they do, with the lines of the index', () => {
    const s = app();
    const found = lines(s, { query: 'sidechain' });
    expect(found.some((line) => line.startsWith('agstudio.ducker | Ducker | effect | Dynamics | '))).toBe(true);
    expect(lines(s, { query: 'export mp3' }).some((line) => line.startsWith('File: file.exportMp3'))).toBe(true);
    expect(lines(s, { query: 'make harmonies' }).join('\n')).toContain('harmonies.make');
  });

  it('can be limited to one kind and to a number of results', () => {
    const s = app();
    const commands = lines(s, { query: 'open', kind: 'command', limit: 5 });
    expect(commands.length).toBeLessThanOrEqual(5);
    for (const line of commands) expect(line).toMatch(/^[A-Z][A-Za-z ]+: /);
    const plugins = lines(s, { query: 'reverb', kind: 'plugin' });
    expect(plugins.every((line) => / \| (instrument|effect) \| /.test(line))).toBe(true);
    expect(lines(s, { query: 'reverb', limit: 1000 }).length).toBeLessThanOrEqual(30);
  });

  it('ignores the song: the same words find the same things whatever is selected', () => {
    const a = app();
    const b = app();
    b.session.getState().selectChannel(b.doc.getState().project.channelOrder[0] ?? null);
    expect(lines(b, { query: 'warm' })).toEqual(lines(a, { query: 'warm' }));
  });

  it('asks for a query, and says nothing found with an empty list', () => {
    const s = app();
    expect(call(s, 'search_catalog', {}).error).toMatch(/give a query/);
    expect(lines(s, { query: 'zzzzqqqq' })).toEqual([]);
  });
});

describe('where the tools are', () => {
  it('are read tools: in the Studio chat’s query action and, over MCP, in the lookup scope', () => {
    const names = readTools.map((tool) => tool.name);
    for (const name of ['get_plugin_details', 'get_commands', 'search_catalog']) expect(names).toContain(name);
  });
});
