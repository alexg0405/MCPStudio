/**
 * What a Studio turn sends to the AI server (no real AI: a fake /api/ai): a stable cached prefix, the details of what the
 * request needs, a small diff when the catalog changes mid-chat, and read tools only when the page can answer them.
 *
 *  - The system prompt (the rules and the catalog index) is byte-identical from chat to chat and across reloads while the
 *    installed plugins and commands are the same, and changes only when they change.
 *  - The turn's text carries the project and the details of the plugins and commands the request most likely needs, each
 *    told once to a conversation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineEffect, p, type PluginDef } from '@agstudio/sdk';
import { createTestServices } from '@app/testing';
import { BeatAssistant } from '@app/assistant/assistant';
import { catalogIndex } from '@app/ai/catalog-index';
import { registerFeatures } from '@ui/features';
import { TWO_HUNDRED_CHANNEL_SONG, buildSyntheticSong, withSeededIds } from '../helpers/context-songs';
import { MAX_SYSTEM_CHARS, MAX_TEXT_CHARS } from '../../tools/ai/types.ts';

interface Sent {
  backend: string;
  session: string | null;
  system: string;
  systemBlocks?: string[];
  text: string;
  readTools?: boolean;
}

/** A fake AI server: the status it reports, and every request it got. A turn can be made to fail. */
function fakeServer(options: { mcp?: boolean | undefined; failNext?: () => boolean } = {}) {
  const calls: Sent[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/status')) {
      const status = {
        subscription: { ok: true },
        api: { ok: false },
        codex: { ok: false },
        ...(options.mcp === undefined ? {} : { lookups: { mcp: options.mcp } }),
      };
      return new Response(JSON.stringify(status), { status: 200 });
    }
    calls.push(JSON.parse(String(init?.body)) as Sent);
    if (options.failNext?.()) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), {
        status: 529,
      });
    }
    const body = JSON.parse(String(init?.body)) as Sent;
    return new Response(
      JSON.stringify({ session: body.session ?? 'sess-1', model: 'claude-opus-5-5', beat: { message: 'Done.', actions: [] } }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function chat(options: Parameters<typeof fakeServer>[0] = {}) {
  const server = fakeServer(options);
  const s = createTestServices();
  registerFeatures(s);
  const a = new BeatAssistant(s, { fetch: server.fetchImpl });
  a.set({ autoplay: false });
  return { s, a, ...server };
}

const userEffect = (id: string, name: string): PluginDef =>
  defineEffect({
    id,
    name,
    version: 1,
    description: 'Warps the sound in a strange way.',
    category: 'Mine',
    params: { amount: p.float(0, 1, 0.5, { label: 'Amount' }) },
    create: () => {
      throw new Error('not in tests');
    },
  }) as PluginDef;

const install = (s: ReturnType<typeof chat>['s'], ...defs: PluginDef[]) =>
  s.plugins.sync(
    'user',
    defs.map((def) => ({ path: `/plugins/${def.id}.ts`, def })),
  );

const storage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
};

afterEach(() => vi.unstubAllGlobals());

describe('the system prompt is the same until the catalog changes', () => {
  it('byte for byte in two new chats of one app, and in a second app (a reload)', async () => {
    const first = chat();
    await first.a.send('make a dark beat');
    first.a.newBeat();
    await first.a.send('now something with a lot of reverb');
    const reloaded = chat();
    await reloaded.a.send('a different request altogether, with an arpeggio');

    const systems = [...first.calls, ...reloaded.calls].map((call) => call.system);
    expect(systems).toHaveLength(3);
    expect(new Set(systems).size).toBe(1);
  });

  it('whatever the request, the project or the focus', async () => {
    const small = chat();
    await small.a.send('hi');
    const big = chat();
    withSeededIds(5, () => buildSyntheticSong(big.s, TWO_HUNDRED_CHANNEL_SONG));
    await big.a.send('make the lead warmer and add reverb');
    expect(big.calls[0]!.system).toBe(small.calls[0]!.system);
  });

  it('changes when a plugin is installed, and only the catalog block of it', async () => {
    const before = chat();
    await before.a.send('hi');
    const after = chat();
    install(after.s, userEffect('user.warp', 'Warp'));
    await after.a.send('hi');

    expect(after.calls[0]!.system).not.toBe(before.calls[0]!.system);
    expect(after.calls[0]!.system).toContain('user.warp | Warp | effect | Mine');
    // The rules block is the same, so a cache breakpoint after it still hits; the index block is the one that changed.
    const [rulesBefore, indexBefore] = before.calls[0]!.systemBlocks!;
    const [rulesAfter, indexAfter] = after.calls[0]!.systemBlocks!;
    expect(rulesAfter).toBe(rulesBefore);
    expect(indexAfter).not.toBe(indexBefore);
  });

  it('is sent as blocks that add up to it', async () => {
    const { a, calls } = chat();
    await a.send('hi');
    const { system, systemBlocks } = calls[0]!;
    expect(systemBlocks).toHaveLength(2);
    expect(systemBlocks!.join('\n\n')).toBe(system);
    expect(systemBlocks![1]).toContain('Catalog index v');
  });

  it('has the catalog in it and not in the turn text', async () => {
    const { a, calls } = chat();
    await a.send('make a dark beat');
    expect(calls[0]!.system).toContain('transport.metronome');
    expect(calls[0]!.system).toContain('agstudio.reverb | Reverb | effect');
    expect(calls[0]!.text).not.toContain('<plugins>');
    expect(calls[0]!.text).not.toContain('<commands>');
  });
});

describe('what a first turn weighs', () => {
  /** What one new chat sends, on an empty project and on a big one. */
  async function firstTurn(big: boolean) {
    const { s, a, calls } = chat();
    if (big) withSeededIds(5, () => buildSyntheticSong(s, TWO_HUNDRED_CHANNEL_SONG));
    await a.send('add a warm pad with a long reverb');
    return calls[0]!;
  }

  it('fits the server’s limits with room to grow, on an empty project and on a very big one', async () => {
    for (const big of [false, true]) {
      const turn = await firstTurn(big);
      expect(turn.system.length, `system, big=${big}`).toBeLessThan(MAX_SYSTEM_CHARS * 0.72);
      expect(turn.text.length, `text, big=${big}`).toBeLessThan(MAX_TEXT_CHARS * 0.2);
    }
  });

  it('is mostly the stable prefix: the turn text is the request, the project and the details', async () => {
    const empty = await firstTurn(false);
    expect(empty.text.length).toBeLessThan(14_000);
    expect(empty.text).toContain('<details>');
    expect(empty.system.length).toBeGreaterThan(empty.text.length * 4);
  });

  it('attaches the details of what the request needs, and not the rest of the catalog', async () => {
    const turn = await firstTurn(false);
    expect(turn.text).toContain('- agstudio.reverb "Reverb"');
    expect(turn.text).toMatch(/params: .*decay/);
    expect(turn.text).not.toContain('- agstudio.limiter "Limiter"');
  });
});

describe('details are told once to a conversation', () => {
  it('not again in a follow-up, again after New chat, and again after a request that failed', async () => {
    let fail = false;
    const { a, calls } = chat({ failNext: () => fail });
    const reverbLine = '- agstudio.reverb "Reverb"';

    await a.send('add reverb to the lead');
    expect(calls[0]!.text).toContain(reverbLine);
    await a.send('more reverb please');
    expect(calls[1]!.text).not.toContain(reverbLine);

    a.newBeat();
    await a.send('add reverb to the lead');
    expect(calls[2]!.text).toContain(reverbLine);

    // A request that failed never reached the AI: its details are sent again with the next one.
    fail = true;
    await a.send('and a delay on the snare');
    fail = false;
    expect(calls[3]!.text).toContain('- agstudio.delay "Delay"');
    await a.send('and a delay on the snare');
    expect(calls[4]!.text).toContain('- agstudio.delay "Delay"');
    await a.send('and a delay on the hats');
    expect(calls[5]!.text).not.toContain('- agstudio.delay "Delay"');
  });
});

describe('a change in the catalog in the middle of a chat', () => {
  it('goes in the turn text as a small diff, once; the system prompt is the one the chat began with', async () => {
    const { s, a, calls } = chat();
    await a.send('hi');
    install(s, userEffect('user.warp', 'Warp'));
    await a.send('use the new warp plugin');
    const text = calls[1]!.text;
    expect(text).toContain('<catalog-changes>');
    expect(text).toContain('added:');
    expect(text).toContain('user.warp | Warp | effect | Mine');
    expect(text.slice(text.indexOf('<catalog-changes>'), text.indexOf('</catalog-changes>')).length).toBeLessThan(1500);
    await a.send('and again');
    expect(calls[2]!.text).not.toContain('<catalog-changes>');

    install(s);
    await a.send('it is gone now');
    expect(calls[3]!.text).toMatch(/removed: user\.warp \(effect\)/);
  });

  it('is the whole new index after a reload, when only the saved version is known', async () => {
    const session = storage();
    vi.stubGlobal('sessionStorage', session);
    const first = chat();
    await first.a.send('hi');
    first.a.saveTab();

    const second = chat();
    install(second.s, userEffect('user.warp', 'Warp'));
    await second.a.send('use the new warp plugin');
    expect(second.calls[0]!.session).toBe('sess-1');
    const text = second.calls[0]!.text;
    expect(text).toContain('This index replaces the one in the system prompt');
    expect(text).toContain(catalogIndex(second.s).text);
  });
});

describe('read tools', () => {
  it('are asked for when the server can offer them and MCP is on', async () => {
    const { a, calls } = chat({ mcp: true });
    await a.send('hi');
    expect(calls[0]!.readTools).toBe(true);
    expect(calls[0]!.text).not.toContain('<tools>');
  });

  it('fall back to query actions, said in the turn, when the server has none (an older server, a preview build)', async () => {
    for (const mcp of [undefined, false]) {
      const { a, calls } = chat({ mcp });
      await a.send('hi');
      expect(calls[0]!.readTools, `mcp=${String(mcp)}`).toBeUndefined();
      expect(calls[0]!.text).toContain('<tools>You have no read tools');
      expect(calls[0]!.text).toContain('query action');
    }
  });

  it('fall back too when the musician switched MCP off in the settings', async () => {
    const { s, a, calls } = chat({ mcp: true });
    s.prefs.getState().set({ mcpEnabled: false });
    await a.send('hi');
    expect(calls[0]!.readTools).toBeUndefined();
    expect(calls[0]!.text).toContain('<tools>You have no read tools');
  });
});
