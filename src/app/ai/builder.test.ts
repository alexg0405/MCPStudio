import { describe, expect, it } from 'vitest';
import { PluginBuilder, type SmokeReport } from './builder';
import { BUILDER_PROMPT, readBuilderAnswer } from './builder-prompt';

const file = (content: string) => [{ path: 'index.ts', content }];

/** A dev server stand-in: Claude's answers in order, and the draft checks' verdicts in order. */
function fakeServer(answers: unknown[], checks: string[][]) {
  const chats: { text: string; session: string | null }[] = [];
  const drafts: unknown[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url === '/api/ai/chat') {
      chats.push({ text: String(body.text), session: (body.session as string | null) ?? null });
      return new Response(JSON.stringify({ session: 'build-1', model: 'claude-opus-5-5', beat: answers.shift() }), {
        status: 200,
      });
    }
    if (url === '/api/plugins/draft') {
      drafts.push(body);
      return new Response(JSON.stringify({ folder: 'tape-stop', problems: checks.shift() ?? [] }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, chats, drafts };
}

const answer = (content: string) => ({
  message: 'A tape stop that slows everything to a halt.',
  plugin: { id: 'user.tape-stop', name: 'Tape Stop', kind: 'effect', files: file(content) },
});

describe('PluginBuilder', () => {
  it('sends the checks’ problems back to Claude and stops when everything passes', async () => {
    const server = fakeServer([answer('broken'), answer('fixed')], [["index.ts:1:7 TS2322: Type 'string' is not assignable"], []]);
    const smokes: string[] = [];
    const builder = new PluginBuilder({
      fetch: server.fetchImpl,
      smoke: async (folder): Promise<SmokeReport> => {
        smokes.push(folder);
        return { problems: [], peakDb: -9 };
      },
    });
    const stages: string[] = [];
    const result = await builder.build(
      { name: 'Tape Stop', kind: 'effect', description: 'Slows the audio down to a stop.' },
      { model: 'claude-opus-5-5', backend: 'subscription', progress: (stage, round) => stages.push(`${stage}${round}`) },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft).toMatchObject({ id: 'user.tape-stop', folder: 'tape-stop', rounds: 1, report: { peakDb: -9 } });
    expect(server.chats[0]!.text).toContain('Build this effect: Tape Stop');
    // The fix round continues the same conversation, with the problems.
    expect(server.chats[1]).toMatchObject({ session: 'build-1' });
    expect(server.chats[1]!.text).toContain("TS2322: Type 'string' is not assignable");
    // The test render only runs once the code checks pass.
    expect(smokes).toEqual(['tape-stop']);
    expect(stages).toEqual(['writing0', 'checking0', 'fixing1', 'checking1', 'testing1']);
  });

  it('gives up after three rounds of fixes and reports what is still wrong', async () => {
    const server = fakeServer(
      [answer('a'), answer('b'), answer('c'), answer('d')],
      [[], [], [], []],
    );
    const builder = new PluginBuilder({
      fetch: server.fetchImpl,
      smoke: async () => ({ problems: ['Tape Stop let no audio through.'], peakDb: null }),
    });
    const result = await builder.build(
      { name: 'Tape Stop', kind: 'effect', description: 'x' },
      { model: 'claude-opus-5-5', backend: 'subscription' },
    );
    expect(result.ok).toBe(false);
    expect(server.chats).toHaveLength(4);
    expect(result.ok ? [] : result.problems).toEqual(['Tape Stop let no audio through.']);
  });
});

describe('readBuilderAnswer', () => {
  it('rebuilds an id that breaks the rule from the name', () => {
    const r = readBuilderAnswer({
      message: 'hi',
      plugin: { id: 'agstudio.tape', name: 'Tape Stop 2', kind: 'effect', files: file('x') },
    });
    expect('value' in r && r.value.plugin.id).toBe('user.tape-stop-2');
  });

  it('needs a kind and files', () => {
    expect(readBuilderAnswer({ plugin: { id: 'user.x', name: 'X', kind: 'thing', files: file('x') } })).toEqual({
      error: 'the plugin kind must be "instrument" or "effect"',
    });
    expect(readBuilderAnswer({ plugin: { id: 'user.x', name: 'X', kind: 'effect', files: [] } })).toEqual({
      error: 'the plugin has no files',
    });
  });
});

describe('BUILDER_PROMPT', () => {
  it('carries the SDK guide and every template (Faust included), within the server’s prompt limit', () => {
    expect(BUILDER_PROMPT).toContain('## Faust plugins');
    for (const t of ['effect-graph', 'effect-worklet', 'effect-faust', 'instrument-graph', 'instrument-worklet', 'instrument-faust'])
      expect(BUILDER_PROMPT).toContain(`<template name="${t}">`);
    // The Faust templates arrive as their source text, not compiled.
    expect(BUILDER_PROMPT).toContain('hslider("[1]Cutoff');
    // tools/ai/server.ts refuses system prompts over 60 000 characters.
    expect(BUILDER_PROMPT.length).toBeLessThan(60_000);
  });

  it('leaves the on-disk sections and lazy editors out of the builder’s guide, and keeps the rest', () => {
    expect(BUILDER_PROMPT).not.toContain('## Hot reload');
    expect(BUILDER_PROMPT).not.toContain('## Testing');
    expect(BUILDER_PROMPT).not.toContain('lazyUi(');
    for (const h of ['## Custom editors', '## Note scripts', '## Presets and versions', '### Rules for audio-thread code'])
      expect(BUILDER_PROMPT).toContain(h);
  });
});
